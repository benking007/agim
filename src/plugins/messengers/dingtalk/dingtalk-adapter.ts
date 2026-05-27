// DingTalk (钉钉) messenger adapter — implements MessengerAdapter
// against the official `dingtalk-stream` SDK in Stream mode.
//
// Stream mode characteristics that shaped this adapter:
//   * No public webhook needed — DingTalk pushes events over WebSocket.
//     The SDK handles reconnect/heartbeat/access-token rotation.
//   * Inbound only fires when the user @-mentions the bot in a group,
//     or sends a 1:1 message. DingTalk strips the @ prefix server-side.
//   * Bot can only send back to (a) the user who messaged it (1:1) or
//     (b) the group conversation the message came from. There is no
//     concept of "DM any user without being messaged first" outside of
//     proactive workflow messages, which we don't use.
//   * threadId encoding: `user:<senderStaffId>` for 1:1, `group:<convId>`
//     for groups. This lets sendMessage route to the right OpenAPI
//     endpoint without consulting external state.
//   * Inbound type is `text` only — DingTalk Stream doesn't deliver
//     image / voice / location messages to bots. /memo coordinate flow
//     therefore needs the user to type coords (no native location msg).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MessengerAdapter, Message, MessageContext } from '../../../core/types.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { setLocationContext } from '../../../core/location-context.js'
import { normalizeIncomingCoords } from '../../../core/coord-systems.js'
import { detectProvider, transcribe, TranscribeError } from '../../../core/transcribe.js'
import { AGIM_HOME } from '../../../core/agim-paths.js'
import { DingTalkClient } from './dingtalk-client.js'
import { tryExtractLatLng } from './link-coords.js'
import { pickDingTalkExtension, saveDingTalkMedia } from './media-store.js'
import type { DingTalkConfig, DingTalkInboundMessage } from './types.js'

const log = rootLogger.child({ component: 'dingtalk' })

const CONFIG_FILE = join(AGIM_HOME, 'config.json')

// Match Feishu's dedup window — DingTalk's gateway also re-delivers if
// the ack races the next reconnect.
const DEDUP_TTL_MS = 10 * 60 * 1000
const DEDUP_MAX = 2000

// Batch 1 (#7) — ack-reaction glyphs. Emoji set is the common one most
// corp DingTalk clients render correctly; kaomoji is the pure-text
// fallback for the small set of locked-down deployments that disable
// emoji fonts. Empty string skips that state silently.
export const ACK_GLYPHS = {
  emoji: { received: '⏳', working: '🤖', done: '✅', failed: '❌' },
  kaomoji: { received: '(´・ω・`)', working: '(｡•̀ᴗ-)', done: '(•̀ᴗ•́)', failed: '(╥﹏╥)' },
} as const

/**
 * Batch 4 (#3) — pure account-resolution helper. Merge accounts dict +
 * top-level credentials into the set of (accountId → DingTalkConfig)
 * pairs the adapter should start. Disabled accounts are filtered out.
 * Each entry's policy / ack-reaction fields fall back to the top-level
 * values when the account-block doesn't override them.
 *
 * Single-account legacy configs (top-level credentials, no `accounts`)
 * resolve to `{'default': <cfg>}` so the adapter sees the same code
 * path regardless of multi-bot vs single-bot deployments.
 */
export function planDingTalkAccounts(cfg: DingTalkConfig): Map<string, DingTalkConfig> {
  const out = new Map<string, DingTalkConfig>()
  const hasExplicitDefault = !!cfg.accounts?.default
  if (cfg.clientId && cfg.clientSecret && !hasExplicitDefault) {
    out.set('default', cfg)
  }
  for (const [accountId, override] of Object.entries(cfg.accounts || {})) {
    if (override.enabled === false) continue
    const clientId = override.clientId || cfg.clientId
    const clientSecret = override.clientSecret || cfg.clientSecret
    if (!clientId || !clientSecret) continue
    out.set(accountId, {
      clientId,
      clientSecret,
      channelId: cfg.channelId,
      dmPolicy: override.dmPolicy ?? cfg.dmPolicy,
      groupPolicy: override.groupPolicy ?? cfg.groupPolicy,
      allowFrom: override.allowFrom ?? cfg.allowFrom,
      groupAllowFrom: override.groupAllowFrom ?? cfg.groupAllowFrom,
      ackReaction: override.ackReaction ?? cfg.ackReaction,
    })
  }
  return out
}

/**
 * Batch 1 (#4) — pure access-policy evaluator. Decoupled from the adapter
 * class so unit tests can hit it without the SDK. Returns:
 *  - allowed: should the message be dispatched to the agent?
 *  - pairedNewSender: when defined, the caller should persist this sender
 *    into allowFrom because the policy is `pairing` and this is the first
 *    inbound DM.
 */
export function evalAccessPolicy(
  cfg: Pick<DingTalkConfig, 'dmPolicy' | 'groupPolicy' | 'allowFrom' | 'groupAllowFrom'>,
  msg: { isGroup: boolean; senderStaffId: string },
): { allowed: boolean; pairedNewSender?: string } {
  if (msg.isGroup) {
    const policy = cfg.groupPolicy || 'open'
    if (policy === 'disabled') return { allowed: false }
    if (policy === 'allowlist') {
      if (!msg.senderStaffId) return { allowed: false }
      return { allowed: (cfg.groupAllowFrom || []).includes(msg.senderStaffId) }
    }
    return { allowed: true }
  }
  const policy = cfg.dmPolicy || 'open'
  if (policy === 'allowlist') {
    if (!msg.senderStaffId) return { allowed: false }
    return { allowed: (cfg.allowFrom || []).includes(msg.senderStaffId) }
  }
  if (policy === 'pairing') {
    if (!msg.senderStaffId) return { allowed: false }
    const seen = cfg.allowFrom || []
    if (seen.length === 0) {
      return { allowed: true, pairedNewSender: msg.senderStaffId }
    }
    return { allowed: seen.includes(msg.senderStaffId) }
  }
  return { allowed: true }
}

export class DingTalkAdapter implements MessengerAdapter {
  readonly name = 'dingtalk'
  // Batch 4 (#3) — accountId → live client. 'default' is the implicit
  // entry built from the top-level credentials when accounts dict is
  // empty. When the operator defines accounts dict, we start one
  // DWClient per entry plus the default (if top-level creds are also
  // set). The threadOwner map below tracks which client originated each
  // thread so outbound replies route back to the right bot.
  private clients = new Map<string, DingTalkClient>()
  // accountId per thread — populated on inbound, consulted on outbound.
  private threadOwner = new Map<string, string>()
  // Per-account effective config snapshot — used by passesAccessPolicy()
  // so each account can have its own dmPolicy / allowFrom / etc.
  private effectiveConfigs = new Map<string, DingTalkConfig>()
  private config: DingTalkConfig | null = null
  private messageHandler?: (ctx: MessageContext) => Promise<void>
  private seenMessages = new Map<string, number>()

  async start(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_FILE, 'utf-8')
      const full = JSON.parse(raw) as { dingtalk?: DingTalkConfig }
      this.config = full.dingtalk ?? null
    } catch {
      throw new Error('DingTalk config not found. Run `agim` → Configure → DingTalk first.')
    }
    if (!this.config) {
      throw new Error('DingTalk config not found. Re-run the configure flow.')
    }
    const planned = this.planAccounts(this.config)
    if (planned.size === 0) {
      throw new Error('DingTalk ClientID or ClientSecret missing on every account. Re-run the configure flow.')
    }
    for (const [accountId, accountCfg] of planned) {
      const client = new DingTalkClient(accountCfg)
      client.onMessage(async (msg) => { await this.handleInbound(msg, accountId) })
      try {
        await client.start()
        this.clients.set(accountId, client)
        this.effectiveConfigs.set(accountId, accountCfg)
        log.info({ event: 'dingtalk.account.started', accountId }, 'DingTalk account started')
      } catch (err) {
        // One bad account shouldn't kill all the others.
        log.error({
          event: 'dingtalk.account.start_failed',
          accountId,
          err: err instanceof Error ? err.message : String(err),
        }, 'DingTalk account failed to start')
      }
    }
    if (this.clients.size === 0) {
      throw new Error('DingTalk: every account failed to start')
    }
    log.info({ accounts: Array.from(this.clients.keys()) },
      `DingTalk adapter started (${this.clients.size} account(s), Stream mode, no webhook needed)`)
  }

  /** Internal wrapper that defers to the pure {@link planDingTalkAccounts}
   *  helper exported from this module so unit tests can exercise account
   *  resolution without spinning up the SDK. */
  private planAccounts(cfg: DingTalkConfig): Map<string, DingTalkConfig> {
    return planDingTalkAccounts(cfg)
  }

  async stop(): Promise<void> {
    for (const [accountId, client] of this.clients) {
      try { await client.stop() } catch (err) {
        log.warn({ accountId, err: err instanceof Error ? err.message : String(err) }, 'stop failed')
      }
    }
    this.clients.clear()
    this.threadOwner.clear()
    this.effectiveConfigs.clear()
    log.info('DingTalk adapter stopped')
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    const client = this.clientForThread(threadId)
    if (!client) throw new Error('DingTalk adapter not started')
    await client.sendMessage(threadId, text)
  }

  /** Batch 4 (#3) — pick the client that owns this thread, falling back
   *  to 'default' if we never saw the thread before (manual notify path). */
  private clientForThread(threadId: string): DingTalkClient | null {
    const owner = this.threadOwner.get(threadId)
    if (owner) {
      const c = this.clients.get(owner)
      if (c) return c
    }
    return this.clients.get('default') ?? this.clients.values().next().value ?? null
  }

  // No sendTyping / sendThinking — DingTalk doesn't expose a typing
  // indicator API for stream-mode bots, and the client UI already shows
  // a "正在输入" hint when a message is being processed in 1:1 chats.
  // Group chats get nothing; the agent's first chunk is the user's signal.

  // ─── inbound ─────────────────────────────────────────────────────────

  /** Returns true on duplicate; otherwise records and prunes. Same shape
   *  as the Feishu adapter's dedup helper. */
  private isDuplicate(msgId: string): boolean {
    const now = Date.now()
    const seenAt = this.seenMessages.get(msgId)
    if (seenAt !== undefined && now - seenAt < DEDUP_TTL_MS) return true
    this.seenMessages.set(msgId, now)
    if (this.seenMessages.size > DEDUP_MAX) {
      const cutoff = now - DEDUP_TTL_MS
      for (const [k, t] of this.seenMessages) {
        if (t < cutoff) this.seenMessages.delete(k)
        if (this.seenMessages.size <= DEDUP_MAX * 0.8) break
      }
      while (this.seenMessages.size > DEDUP_MAX) {
        const oldest = this.seenMessages.keys().next().value
        if (!oldest) break
        this.seenMessages.delete(oldest)
      }
    }
    return false
  }

  /** Build the threadId we expose to the rest of agim. 1:1 routes by
   *  sender staffId; group chats route by openConversationId so any
   *  member triggers a shared session in that group. */
  private threadIdFor(msg: DingTalkInboundMessage): string {
    return msg.conversationType === '2'
      ? `group:${msg.conversationId}`
      : `user:${msg.senderStaffId}`
  }

  private async handleInbound(msg: DingTalkInboundMessage, accountId: string = 'default'): Promise<void> {
    if (!this.messageHandler) {
      log.debug('no message handler registered')
      return
    }
    if (msg.msgId && this.isDuplicate(msg.msgId)) {
      log.info({ messageId: msg.msgId, event: 'dingtalk.dedup.skip' }, 'dropping replayed msgId')
      return
    }

    // Batch 1 (#4) — access policy gate. Filters BEFORE dispatch so the
    // agent never sees an unauthorized turn. `pairing` learns the first
    // DM sender into allowFrom for future turns (write-back).
    if (!this.passesAccessPolicy(msg, accountId)) {
      log.info({
        event: 'dingtalk.policy.denied',
        accountId,
        messageId: msg.msgId,
        conversationType: msg.conversationType,
        senderStaffId: msg.senderStaffId,
      }, 'inbound dropped by access policy')
      return
    }

    const acctCfg = this.effectiveConfigs.get(accountId) || this.config || undefined
    const channelId = acctCfg?.channelId || 'default'
    const threadId = this.threadIdFor(msg)
    // Batch 4 (#3) — remember which account owns this thread so future
    // outbound sends route back to the same bot.
    this.threadOwner.set(threadId, accountId)

    // Batch 1 (#7) — best-effort ack-reaction. Fire-and-forget; if the
    // session webhook expired or the SDK chokes, we still proceed.
    void this.sendAckReaction(msg, 'received').catch((err) => {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, 'ack-reaction received failed')
    })

    // ─── text / markdown — the happy path ────────────────────────────
    // Markdown messages from DingTalk also carry `text.content`; treat
    // them like plain text since the agent already speaks markdown.
    if (msg.msgtype === 'text' || msg.msgtype === 'markdown') {
      const text = msg.text?.content?.trim() ?? ''
      if (!text) {
        log.debug('empty text in dingtalk message — ignored')
        return
      }
      await this.dispatchText(msg, text, threadId, channelId)
      return
    }

    // ─── link — could be a shared location, a deep link, etc. ────────
    // We log the full link block and try to recognise common GPS-bearing
    // URL shapes (amap, qmap, baidu, dingtalk map mini-app). When we
    // find lat/lng we feed location-context so cli.ts can annotate the
    // user's next text turn — same architecture as Telegram / Feishu
    // native location sharing.
    if (msg.msgtype === 'link') {
      log.info({
        event: 'dingtalk.inbound.link',
        messageId: msg.msgId,
        link: msg.link,
        threadId,
      }, 'received link msgtype')
      const coords = msg.link?.messageUrl ? tryExtractLatLng(msg.link.messageUrl) : null
      if (coords) {
        // Apply the right coord-system conversion based on which map
        // provider's URL we just parsed (amap/qq=GCJ-02, baidu=BD-09).
        // See core/coord-systems.ts for the full per-source policy.
        const norm = normalizeIncomingCoords(coords.source, coords.lat, coords.lng)
        const threadKey = `dingtalk:${channelId}:${threadId}`
        setLocationContext(threadKey, {
          lat: norm.lat,
          lng: norm.lng,
          venueLabel: msg.link?.title || undefined,
          venueAddress: msg.link?.text || undefined,
        })
        log.info({
          event: 'dingtalk.location_context.set',
          source: coords.source,
          raw_lat: coords.lat, raw_lng: coords.lng,
          wgs_lat: norm.lat, wgs_lng: norm.lng,
          applied: norm.applied,
        })
        if (this.clients.size > 0) {
          await this.clientForThread(threadId)?.sendMessage(threadId,
            `📍 已收到位置${msg.link?.title ? `「${msg.link.title}」` : ''}。告诉我要做什么（例如 /memo 食堂、记下、提醒我下次来）。`)
            .catch(err => log.warn({ err: err instanceof Error ? err.message : String(err) },
              'failed to ack dingtalk location'))
        }
        return
      }
      // Not a recognised map URL — fall through to "tell user we can't"
      // by sending a generic hint and stop here.
      if (this.clients.size > 0) {
        await this.clientForThread(threadId)?.sendMessage(threadId, '👁 链接已收到，但我只能阅读文本——请把要做的事情用文字告诉我。')
          .catch(() => undefined)
      }
      return
    }

    // ─── picture — download via messageFiles/download → save → enrich ──
    // (msgtype is 'picture' on the wire — community docs say 'image' but
    // empirically DingTalk delivers 'picture'.)
    if (msg.msgtype === 'picture') {
      await this.handleImageInbound(msg, threadId, channelId)
      return
    }

    // ─── audio — DingTalk includes server-side ASR ─────────────────────
    // (msgtype is 'audio' on the wire — community docs say 'voice'.)
    // Inbound `content.recognition` carries the transcript already; we
    // prefer it over re-running whisper locally for two reasons:
    //   1. accuracy: DingTalk's Mandarin ASR is generally better than the
    //      ggml-base whisper.cpp model on the same clip.
    //   2. latency: zero round-trip vs. 5-30 s on CPU.
    // We still pull the audio file when we have a downloadCode so the
    // agent can replay / archive the source recording.
    if (msg.msgtype === 'audio') {
      await this.handleVoiceInbound(msg, threadId, channelId)
      return
    }

    // ─── richText — flatten text segments and dispatch as plain text ─
    // DingTalk delivers "rich text" forwards / mixed-content messages
    // with `msgtype: 'richText'`. The msgList array carrying the
    // segments has been observed in three different positions across
    // SDK versions and chat contexts (1:1 vs group, internal vs
    // OpenAPI relay):
    //   * msg.richText.msgList         (top-level — community docs)
    //   * msg.content.richText.msgList (some 1:1 channels)
    //   * msg.content.msgList          (some action-card relays)
    // We probe all three. We also normalise the msgtype check
    // case-insensitively because the wire has been seen as both
    // 'richText' and 'richtext'. Always log the structure we found
    // so future shape drift is visible without a stack trace.
    if (typeof msg.msgtype === 'string' && msg.msgtype.toLowerCase() === 'richtext') {
      const m = msg as unknown as {
        richText?: { msgList?: unknown }
        content?: { richText?: { msgList?: unknown }; msgList?: unknown }
      }
      let list: Array<Record<string, unknown>> = []
      let source = 'none'
      const candidates: Array<[string, unknown]> = [
        ['msg.richText.msgList', m.richText?.msgList],
        ['msg.content.richText.msgList', m.content?.richText?.msgList],
        ['msg.content.msgList', m.content?.msgList],
      ]
      for (const [where, c] of candidates) {
        if (Array.isArray(c) && c.length > 0) {
          list = c as Array<Record<string, unknown>>
          source = where
          break
        }
      }
      const textParts: string[] = []
      let pictureCount = 0
      for (const seg of list) {
        if (!seg || typeof seg !== 'object') continue
        const segType = typeof seg.type === 'string' ? seg.type : ''
        // Tolerate both `text` and `content` for the text-segment
        // body — different SDK versions disagree on the field name.
        const segText = typeof seg.text === 'string'
          ? seg.text
          : typeof seg.content === 'string'
            ? seg.content
            : ''
        if (segType === 'text' || (!segType && segText)) {
          const t = segText.trim()
          if (t) textParts.push(t)
        } else if (segType === 'picture') {
          pictureCount += 1
        }
        // 'at' / unknown segments are intentionally ignored — they
        // carry no payload the agent can act on.
      }
      log.info({
        event: 'dingtalk.inbound.richtext',
        messageId: msg.msgId,
        threadId,
        msgtype: msg.msgtype,
        msgListSource: source,
        msgListLen: list.length,
        textPartCount: textParts.length,
        pictureCount,
        // Dump the payload's top-level shape so we can adjust if
        // none of the candidates matched.
        topLevelKeys: Object.keys(msg).slice(0, 20),
      }, `richText inbound (msgList from ${source}, ${textParts.length} text seg, ${pictureCount} picture seg)`)

      let text = textParts.join('\n').trim()
      if (pictureCount > 0) {
        text = text
          ? `${text}\n\n（这条消息还附带 ${pictureCount} 张图片；如需我查看图片，请单独发送。）`
          : `（收到 ${pictureCount} 张图片的复合消息，请单独发送图片以便我查看，或打字告诉我要做什么。）`
      }
      if (!text) {
        // Last-ditch fallback — if we couldn't pull any text segments,
        // dump the full payload at warn level so the operator sees
        // exactly what arrived. Then ack to the user so they know the
        // bot at least received the message (vs the v1.2.88 silent
        // "I don't recognize this format" fallback that returned them
        // a static banner). Without this ack the user sees nothing
        // even though the inbound was logged.
        log.warn({
          event: 'dingtalk.inbound.richtext_no_text',
          messageId: msg.msgId,
          threadId,
          fullPayload: msg,
        }, 'richText with no extractable text — full payload logged for shape analysis')
        if (this.clients.size > 0) {
          await this.clientForThread(threadId)?.sendMessage(threadId,
            '📝 收到一条复合消息，但里面没找到可用的文字。请打字告诉我要做什么，或直接转发文字 / 图片 / 文件。')
            .catch(() => undefined)
        }
        return
      }
      await this.dispatchText(msg, text, threadId, channelId)
      return
    }

    // ─── file — out of scope for now; ack only ───────────────────────
    // Files can be PDFs / Word / spreadsheets etc. — multimodal agent
    // handling is a separate effort. Acknowledge so user knows we saw it.
    if (msg.msgtype === 'file') {
      log.info({
        event: 'dingtalk.inbound.file',
        messageId: msg.msgId,
        msgtype: msg.msgtype,
        threadId,
        content: msg.content,
      }, 'received file msgtype — currently no handler')
      if (this.clients.size > 0) {
        await this.clientForThread(threadId)?.sendMessage(threadId,
          '📎 文件收到了，但我暂时还不能解析文件内容——请打字告诉我或上传图片。')
          .catch(() => undefined)
      }
      return
    }

    // ─── unknown msgtype — dump full payload for diagnosis ──────────
    // This is the fallback for things like "user shared a native
    // location" (msgtype undocumented). The dump lets us inspect the
    // real shape in journalctl and teach the adapter next iteration.
    log.warn({
      event: 'dingtalk.inbound.unknown_msgtype',
      messageId: msg.msgId,
      msgtype: msg.msgtype,
      threadId,
      fullPayload: msg,
    }, 'unknown dingtalk msgtype — full payload logged for analysis')
    if (this.clients.size > 0) {
      await this.clientForThread(threadId)?.sendMessage(threadId,
        `❓ 收到一条 \`${msg.msgtype}\` 类型消息，我还不认得这种格式，已记录到日志便于调试。请打字告诉我要做什么。`)
        .catch(() => undefined)
    }
  }

  /** Image inbound: exchange downloadCode → CDN bytes → save under
   *  ~/.agim/media/dingtalk/<thread>/, then dispatch a Message whose
   *  text contains an `[图片附件：<path>]` marker. claude-code's Read
   *  tool already understands that marker — it'll fetch the file off
   *  disk and pass it to the multimodal model the user is talking to.
   *
   *  On download failure we still dispatch (with a `[图片附件下载失败]`
   *  marker) so the user's interaction isn't silently dropped. */
  private async handleImageInbound(
    msg: DingTalkInboundMessage,
    threadId: string,
    channelId: string,
  ): Promise<void> {
    // DingTalk picture inbound carries TWO codes. Empirically only the
    // generic `downloadCode` is accepted by /v1.0/robot/messageFiles/download
    // — `pictureDownloadCode` returns 500 "unknownError" (it's reserved for
    // a different endpoint we don't use). Picture's `downloadCode` resolves
    // to a high-resolution version, not a thumbnail, despite the field
    // name overlap with what the wire format calls a "thumb code". Confirmed
    // 2026-05-11 via real msg dumps.
    const downloadCode = msg.content?.downloadCode ?? msg.content?.pictureDownloadCode
    if (!downloadCode) {
      log.warn({ event: 'dingtalk.image.no_download_code', messageId: msg.msgId, content: msg.content },
        'image msg arrived without downloadCode — falling back to ack hint')
      if (this.clients.size > 0) {
        await this.clientForThread(threadId)?.sendMessage(threadId,
          '🖼 图片收到了但我没拿到下载凭据，没法看。请重发或打字描述。')
          .catch(() => undefined)
      }
      return
    }

    const subPath = this.subPathFor(msg)
    let attachmentLine: string
    try {
      const client = this.clientForThread(threadId)
      if (!client) throw new Error('client not ready')
      const dl = await client.downloadMessageFile(downloadCode)
      if (!dl) throw new Error('messageFiles/download returned null')
      const ext = pickDingTalkExtension(dl.contentType, undefined)
      const path = await saveDingTalkMedia(dl.buffer, subPath, `${this.safeFilenameStem(msg.msgId)}.${ext}`)
      attachmentLine = `[图片附件：${path}]`
      log.info({ event: 'dingtalk.image.saved', path, bytes: dl.buffer.length },
        'dingtalk image saved')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'dingtalk.image.download_failed', err: reason, messageId: msg.msgId },
        'image download/save failed')
      attachmentLine = `[图片附件下载失败：${reason}]`
    }

    await this.dispatchText(msg, attachmentLine, threadId, channelId)
  }

  /** Voice inbound: download AMR (or whatever the CDN serves) → transcribe
   *  via the shared whisper provider → dispatch the transcript as the
   *  user's text. The saved source file path is appended so the agent can
   *  reference it (replay, archive, etc.) — same shape as the Telegram
   *  voice path so claude-code's prompts work uniformly.
   *
   *  Surfaces failures inline so the user gets feedback:
   *    - no downloadCode      → `[语音附件无下载凭据]`
   *    - download failed      → `[语音附件下载失败：…]`
   *    - no provider set      → `[语音附件未转写（未配置 OPENAI_API_KEY 或 IMHUB_WHISPERCPP_BIN）：path]`
   *    - transcribe threw     → `[语音转写失败（provider: reason）\n源文件：path]` */
  private async handleVoiceInbound(
    msg: DingTalkInboundMessage,
    threadId: string,
    channelId: string,
  ): Promise<void> {
    const recognition = (msg.content?.recognition ?? '').trim()
    const downloadCode = msg.content?.downloadCode
    const durationRaw = msg.content?.duration
    const durationSec = typeof durationRaw === 'number'
      ? durationRaw
      : typeof durationRaw === 'string' && durationRaw
        ? parseInt(durationRaw, 10)
        : undefined

    // Try to grab the source audio file so the agent can reference /
    // replay it. Best-effort: a missing or failed download doesn't
    // block the conversation when DingTalk's server-side ASR already
    // gave us the transcript text.
    let savedPath: string | null = null
    let downloadErr: string | null = null
    if (downloadCode) {
      try {
        const c = this.clientForThread(threadId)
        if (!c) throw new Error('client not ready')
        const dl = await c.downloadMessageFile(downloadCode)
        if (!dl) throw new Error('messageFiles/download returned null')
        const ext = pickDingTalkExtension(dl.contentType, undefined)
        savedPath = await saveDingTalkMedia(dl.buffer, this.subPathFor(msg), `${this.safeFilenameStem(msg.msgId)}.${ext}`)
        log.info({ event: 'dingtalk.voice.saved', path: savedPath, bytes: dl.buffer.length },
          'dingtalk voice saved')
      } catch (err) {
        downloadErr = err instanceof Error ? err.message : String(err)
        log.warn({ event: 'dingtalk.voice.download_failed', err: downloadErr, messageId: msg.msgId },
          'voice download/save failed (transcript may still be available via DingTalk ASR)')
      }
    }

    // Resolve a transcript. Priority order:
    //   1. DingTalk server-side ASR (msg.content.recognition) — accurate
    //      for Mandarin, zero latency on our side.
    //   2. Local whisper.cpp / OpenAI Whisper on the downloaded audio,
    //      if the platform ASR is missing AND we have the source file.
    //   3. Failure markers so the agent + user both see something.
    let voiceLine: string
    if (recognition) {
      const dur = durationSec != null ? `${durationSec}s, ` : ''
      const sourceTail = savedPath ? `\n源文件：${savedPath}]`
        : downloadErr ? `\n源文件下载失败：${downloadErr}]`
        : ']'
      voiceLine = `[语音转写（${dur}provider=dingtalk-asr）：\n${recognition}${sourceTail}`
    } else if (!savedPath) {
      voiceLine = `[语音附件下载失败：${downloadErr ?? '钉钉未提供 downloadCode'}]`
    } else if (detectProvider() === 'none') {
      voiceLine = `[语音附件未转写（钉钉未返回 recognition，且本地未配置 OPENAI_API_KEY 或 IMHUB_WHISPERCPP_BIN）：${savedPath}]`
    } else {
      try {
        const result = await transcribe(savedPath, { language: 'zh' })
        const dur = durationSec != null ? `${durationSec}s, ` : ''
        voiceLine = [
          `[语音转写（${dur}provider=${result.provider}, ${result.elapsedMs}ms）：`,
          result.text || '（空）',
          `源文件：${savedPath}]`,
        ].join('\n')
      } catch (err) {
        const reason = err instanceof TranscribeError
          ? `${err.provider}: ${err.reason}`
          : err instanceof Error ? err.message : String(err)
        voiceLine = `[语音转写失败（${reason}）\n源文件：${savedPath}]`
      }
    }

    await this.dispatchText(msg, voiceLine, threadId, channelId)
  }

  /** Build a filesystem-safe sub-path under MEDIA_ROOT/dingtalk/.
   *  Uses senderStaffId for 1:1 and openConversationId for groups; both
   *  are alphanumeric+`=` from DingTalk so we sanitise the `=` (and any
   *  other path-unsafe chars) to `_` to avoid surprises on Windows ports
   *  or shell quoting. */
  private subPathFor(msg: DingTalkInboundMessage): string {
    const raw = msg.conversationType === '2' ? msg.conversationId : msg.senderStaffId
    return (raw || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')
  }

  /** DingTalk msgIds are base64-shaped (`msgABC/DEF+xyz==`) and contain
   *  `/` + `+` + `=` — all reserved for path or shell quoting. Replace
   *  every non-[A-Za-z0-9_-] char with `_` so the resulting filename
   *  passes saveDingTalkMedia's safety check and is portable. */
  private safeFilenameStem(msgId: string | undefined): string {
    return (msgId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')
  }

  /** Batch 1 (#4) + Batch 4 (#3) — per-account policy gate. Uses the
   *  effective config for `accountId` so each bot can have its own
   *  dmPolicy / allowlist. */
  private passesAccessPolicy(msg: DingTalkInboundMessage, accountId: string = 'default'): boolean {
    const cfg = this.effectiveConfigs.get(accountId) || this.config
    if (!cfg) return true
    const result = evalAccessPolicy(cfg, {
      isGroup: msg.conversationType === '2',
      senderStaffId: msg.senderStaffId || '',
    })
    if (result.pairedNewSender) {
      // Pairing learn-back: scoped to the inbound account so paired-with
      // bot-A doesn't accidentally unlock DMs to bot-B.
      cfg.allowFrom = [result.pairedNewSender]
      log.info({
        event: 'dingtalk.policy.paired',
        accountId,
        senderStaffId: result.pairedNewSender,
      }, 'pairing locked in')
    }
    return result.allowed
  }

  /** Batch 1 (#7) + Batch 4 (#3) — per-account ack glyph. Reads the
   *  ackReaction mode from the account that owns the inbound thread. */
  private async sendAckReaction(
    msg: DingTalkInboundMessage,
    state: 'received' | 'working' | 'done' | 'failed',
  ): Promise<void> {
    const threadId = this.threadIdFor(msg)
    const accountId = this.threadOwner.get(threadId) || 'default'
    const acctCfg = this.effectiveConfigs.get(accountId) || this.config
    const mode = acctCfg?.ackReaction || 'off'
    if (mode === 'off') return
    const client = this.clientForThread(threadId)
    if (!client) return
    const glyph = ACK_GLYPHS[mode][state]
    if (!glyph) return
    try {
      await client.sendMessage(threadId, glyph)
    } catch (err) {
      log.debug({
        event: 'dingtalk.ack.send_failed',
        state,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Shared text-dispatch path used by text / markdown msgtypes. */
  private async dispatchText(
    msg: DingTalkInboundMessage,
    text: string,
    threadId: string,
    channelId: string,
  ): Promise<void> {
    // Batch 3 (#8) — quoted-message recovery. DingTalk Stream sometimes
    // carries the originalContent.text when the user "reply-to"-style
    // quotes a prior message. Defensive: many SDK versions don't ship
    // these fields at all, so absent is fine.
    const quoted = msg.originalContent?.text?.trim() || ''
    const composed = quoted
      ? `[reply to dingtalk message ${msg.originalMessageId || ''}: "${
          quoted.length > 800 ? `${quoted.slice(0, 797)}…` : quoted
        }"]\n\n${text}`
      : text

    const out: Message = {
      id: msg.msgId,
      threadId,
      userId: msg.senderStaffId || 'unknown',
      text: composed,
      timestamp: msg.createAt ? new Date(msg.createAt) : new Date(),
      channelId,
    }
    const ctx: MessageContext = {
      message: out,
      platform: 'dingtalk',
      channelId,
    }
    try {
      await this.messageHandler!(ctx)
    } catch (err) {
      log.error({
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }, 'error in dingtalk message handler')
    }
  }
}

// tryExtractLatLng + MapUrlSource live in ./link-coords.ts so tests for
// the URL classifier can import them without pulling in this adapter's
// heavy side-effecting transitive deps (media-store, dingtalk-stream,
// transcribe, …). Re-exported here for any external callers that import
// from the adapter module.
export { tryExtractLatLng, type MapUrlSource } from './link-coords.js'

export const dingtalkAdapter = new DingTalkAdapter()
