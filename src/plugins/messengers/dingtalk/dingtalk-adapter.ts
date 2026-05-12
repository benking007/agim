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
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MessengerAdapter, Message, MessageContext } from '../../../core/types.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { setLocationContext } from '../../../core/location-context.js'
import { normalizeIncomingCoords } from '../../../core/coord-systems.js'
import { detectProvider, transcribe, TranscribeError } from '../../../core/transcribe.js'
import { DingTalkClient } from './dingtalk-client.js'
import { tryExtractLatLng } from './link-coords.js'
import { pickDingTalkExtension, saveDingTalkMedia } from './media-store.js'
import type { DingTalkConfig, DingTalkInboundMessage } from './types.js'

const log = rootLogger.child({ component: 'dingtalk' })

const CONFIG_FILE = join(homedir(), '.im-hub', 'config.json')

// Match Feishu's dedup window — DingTalk's gateway also re-delivers if
// the ack races the next reconnect.
const DEDUP_TTL_MS = 10 * 60 * 1000
const DEDUP_MAX = 2000

export class DingTalkAdapter implements MessengerAdapter {
  readonly name = 'dingtalk'
  private client: DingTalkClient | null = null
  private config: DingTalkConfig | null = null
  private messageHandler?: (ctx: MessageContext) => Promise<void>
  private seenMessages = new Map<string, number>()

  async start(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_FILE, 'utf-8')
      const full = JSON.parse(raw) as { dingtalk?: DingTalkConfig }
      this.config = full.dingtalk ?? null
    } catch {
      throw new Error('DingTalk config not found. Run `im-hub-pro` → Configure → DingTalk first.')
    }
    if (!this.config?.clientId || !this.config?.clientSecret) {
      throw new Error('DingTalk ClientID or ClientSecret missing. Re-run the configure flow.')
    }

    this.client = new DingTalkClient(this.config)
    this.client.onMessage(async (msg) => { await this.handleInbound(msg) })
    await this.client.start()
    log.info('DingTalk adapter started (WebSocket Stream mode, no webhook needed)')
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop()
      this.client = null
    }
    log.info('DingTalk adapter stopped')
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('DingTalk adapter not started')
    await this.client.sendMessage(threadId, text)
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

  /** Build the threadId we expose to the rest of im-hub. 1:1 routes by
   *  sender staffId; group chats route by openConversationId so any
   *  member triggers a shared session in that group. */
  private threadIdFor(msg: DingTalkInboundMessage): string {
    return msg.conversationType === '2'
      ? `group:${msg.conversationId}`
      : `user:${msg.senderStaffId}`
  }

  private async handleInbound(msg: DingTalkInboundMessage): Promise<void> {
    if (!this.messageHandler) {
      log.debug('no message handler registered')
      return
    }
    if (msg.msgId && this.isDuplicate(msg.msgId)) {
      log.info({ messageId: msg.msgId, event: 'dingtalk.dedup.skip' }, 'dropping replayed msgId')
      return
    }

    const channelId = this.config?.channelId || 'default'
    const threadId = this.threadIdFor(msg)

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
        if (this.client) {
          await this.client.sendMessage(threadId,
            `📍 已收到位置${msg.link?.title ? `「${msg.link.title}」` : ''}。告诉我要做什么（例如 /memo 食堂、记下、提醒我下次来）。`)
            .catch(err => log.warn({ err: err instanceof Error ? err.message : String(err) },
              'failed to ack dingtalk location'))
        }
        return
      }
      // Not a recognised map URL — fall through to "tell user we can't"
      // by sending a generic hint and stop here.
      if (this.client) {
        await this.client.sendMessage(threadId, '👁 链接已收到，但我只能阅读文本——请把要做的事情用文字告诉我。')
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
      if (this.client) {
        await this.client.sendMessage(threadId,
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
    if (this.client) {
      await this.client.sendMessage(threadId,
        `❓ 收到一条 \`${msg.msgtype}\` 类型消息，我还不认得这种格式，已记录到日志便于调试。请打字告诉我要做什么。`)
        .catch(() => undefined)
    }
  }

  /** Image inbound: exchange downloadCode → CDN bytes → save under
   *  ~/.im-hub/media/dingtalk/<thread>/, then dispatch a Message whose
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
      if (this.client) {
        await this.client.sendMessage(threadId,
          '🖼 图片收到了但我没拿到下载凭据，没法看。请重发或打字描述。')
          .catch(() => undefined)
      }
      return
    }

    const subPath = this.subPathFor(msg)
    let attachmentLine: string
    try {
      if (!this.client) throw new Error('client not ready')
      const dl = await this.client.downloadMessageFile(downloadCode)
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
        if (!this.client) throw new Error('client not ready')
        const dl = await this.client.downloadMessageFile(downloadCode)
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

  /** Shared text-dispatch path used by text / markdown msgtypes. */
  private async dispatchText(
    msg: DingTalkInboundMessage,
    text: string,
    threadId: string,
    channelId: string,
  ): Promise<void> {
    const out: Message = {
      id: msg.msgId,
      threadId,
      userId: msg.senderStaffId || 'unknown',
      text,
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
