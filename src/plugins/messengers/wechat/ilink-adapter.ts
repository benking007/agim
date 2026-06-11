// WeChat iLink Bot API Adapter
// Implements MessengerAdapter using the iLink HTTP API

import type { MessengerAdapter, Message, MessageContext } from '../../../core/types.js'
import { ILinkClient } from './ilink-client.js'
import type { Credentials, WeixinMessage, MessageItem, ContextTokenCache } from './ilink-types.js'
import { ILINK_ERRORS, ITEM_TYPE } from './ilink-types.js'
import { join } from 'node:path'
import { AGIM_HOME } from '../../../core/agim-paths.js'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { logger as rootLogger } from '../../../core/logger.js'
import { Backoff } from '../../../utils/backoff.js'
import {
  downloadWechatMedia,
  extractCdnMedia,
  pickExtensionForImage,
  pickExtensionForVoice,
  pickExtensionForFile,
  pickExtensionForVideo,
} from './media-download.js'
import { transcribe, detectProvider, TranscribeError } from '../../../core/transcribe.js'
import {
  persistContextToken,
  loadContextToken,
  loadAllContextTokens,
  cleanupExpiredTokens as cleanupExpiredTokensInStore,
  closeContextStore,
  deleteContextToken,
} from './context-store.js'

const log = rootLogger.child({ component: 'wechat-ilink' })

const CREDENTIALS_FILE = join(AGIM_HOME, 'wechat-credentials.json')
const _POLL_TIMEOUT = 30000 // 30 seconds
const CONTEXT_TOKEN_TTL = 30 * 60 * 1000 // 30 minutes

const PROCESSED_MESSAGES_TTL = 60 * 1000 // 1 minute

export class ILinkWeChatAdapter implements MessengerAdapter {
  readonly name = 'wechat-ilink'
  private client: ILinkClient
  private messageHandler?: (ctx: MessageContext) => Promise<void>
  private isRunning = false
  private pollState = {
    getUpdatesBuf: '',
    isPolling: false,
    lastPollTime: 0,
  }
  private contextTokens = new Map<string, ContextTokenCache>()
  private typingTickets = new Map<string, string>()
  private processedMessages = new Map<string, number>() // message_id -> timestamp

  constructor() {
    this.client = new ILinkClient()
  }

  // ============================================
  // Lifecycle
  // ============================================

  async start(): Promise<void> {
    // Load saved credentials
    const credentials = await this.loadCredentials()
    if (credentials) {
      this.client.setCredentials(credentials)
      log.info('Credentials loaded from cache')
    } else {
      throw new Error('No WeChat credentials found. Run "agim config wechat" first.')
    }

    // Warm in-memory context-token cache from persistent store. Without this,
    // any user who messaged before the last restart but is silent now can't
    // receive pushes (e.g. recurring reminders) until they speak again.
    const warmed = loadAllContextTokens(CONTEXT_TOKEN_TTL, Date.now())
    for (const t of warmed) {
      this.contextTokens.set(t.userId, {
        userId: t.userId,
        contextToken: t.token,
        timestamp: t.fetchedAt,
      })
    }
    if (warmed.length > 0) {
      log.info({ event: 'wechat.context.warm', count: warmed.length },
        'Warmed context-token cache from persistent store')
    }

    this.isRunning = true
    log.info('WeChat iLink adapter started')

    // Start polling in background
    this.startPolling()
  }

  async stop(): Promise<void> {
    this.isRunning = false
    this.client.clearCredentials()
    closeContextStore()
    log.info('WeChat iLink adapter stopped')
  }

  // ============================================
  // Message Handling
  // ============================================

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    if (!this.client.hasCredentials()) {
      throw new Error('WeChat adapter not authenticated')
    }

    // Extract user ID from threadId (format: user:xxx or room:xxx)
    const userId = threadId.replace(/^(user|room):/, '')

    // Get context token for this user
    const contextToken = this.getContextToken(userId)
    if (!contextToken) {
      throw new Error('No context token available for this user')
    }

    // Split long messages
    const chunks = this.splitMessage(text)

    for (const chunk of chunks) {
      const response = await this.client.sendMessage(userId, chunk, contextToken)

      if (response.ret !== 0 && response.ret !== undefined) {
        if (response.ret === ILINK_ERRORS.SESSION_EXPIRED) {
          throw new Error('WeChat session expired. Please re-login.')
        }
        // INVALID_PARAMS (-2) on send almost always means our cached
        // context-token for this user has been invalidated upstream (e.g.
        // the user opened a different chat / wechat rotated the token).
        // Drop it so the next inbound message from this user refreshes
        // the cache + the outbox retry will succeed once they reply.
        // Without this hook, outbox loops forever on the stale token
        // and the user never sees any reply (observed 2026-05-24).
        if (response.ret === ILINK_ERRORS.INVALID_PARAMS) {
          this.invalidateContextToken(userId, 'wechat.send.invalid_params')
        }
        throw new Error(`Failed to send message: ${response.errmsg || response.ret}`)
      }
    }
  }

  /** Drop the cached + persisted context-token for a user. Called when
   *  wechat rejects a send with INVALID_PARAMS so the next inbound
   *  message rebuilds the cache from the fresh polling token. */
  private invalidateContextToken(userId: string, reason: string): void {
    this.contextTokens.delete(userId)
    try { deleteContextToken(userId) } catch { /* best-effort */ }
    log.warn({
      event: 'wechat.context.invalidated',
      userId,
      reason,
    }, 'invalidated context token for user — will refresh on next inbound message')
  }

  // ============================================
  // Typing Indicator
  // ============================================

  // Note: WeChat does NOT implement sendThinking on purpose. The previous
  // "🤔 思考中…" placeholder was added in May 2026 as a fallback when the
  // native typing indicator was deemed not prominent enough. After the
  // remind-intent perf fix (avg reply latency 80s → 3s) the case
  // collapsed: the bubble would linger forever (iLink has no recall API)
  // and just polluted chat history. Native sendTyping below covers the
  // immediate-feedback need on its own. Feishu still keeps sendThinking
  // because its sendTyping is a no-op.

  async sendTyping(threadId: string, isTyping: boolean): Promise<void> {
    if (!this.client.hasCredentials()) {
      return
    }

    // Extract user ID from threadId (format: user:xxx or room:xxx)
    const userId = threadId.replace(/^(user|room):/, '')

    // Get or fetch typing ticket
    let typingTicket: string | undefined = this.typingTickets.get(userId)
    if (!typingTicket) {
      const contextToken = this.getContextToken(userId)
      const ticket = await this.client.getTypingTicket(userId, contextToken ?? undefined)
      if (!ticket) {
        log.warn({ userId }, 'Could not get typing ticket')
        return
      }
      typingTicket = ticket
      this.typingTickets.set(userId, ticket)
    }

    // Send typing status (1 = start, 2 = stop)
    const status = isTyping ? 1 : 2
    const success = await this.client.sendTyping(userId, typingTicket, status)

    if (!success) {
      // Ticket might be expired, clear it for next attempt
      this.typingTickets.delete(userId)
      log.warn({ userId }, 'Failed to send typing indicator, cleared ticket')
    }
  }

  // ============================================
  // QR Code Login
  // ============================================

  /**
   * Start QR code login flow
   * Returns QR code URL and token for polling
   */
  async startQRLogin(): Promise<{ qrUrl: string; qrToken: string }> {
    const response = await this.client.getQRCode()
    return {
      qrUrl: response.qrcode_img_content,
      qrToken: response.qrcode,
    }
  }

  /**
   * Single-shot QR status check, intended for the web settings page
   * which polls on its own cadence rather than holding a 2-minute
   * long-poll. On 'confirmed' the credentials are persisted to disk
   * exactly the same way `waitForQRLogin` does, so the caller doesn't
   * need to know about the credentials-file layout.
   */
  async pollQRLogin(qrToken: string): Promise<{
    status: 'wait' | 'scaned' | 'confirmed' | 'expired' | string
    credentials?: { accountId?: string; userId?: string }
  }> {
    const status = await this.client.getQRCodeStatus(qrToken)
    if (status.status === 'confirmed' && status.bot_token && status.ilink_bot_id && status.ilink_user_id) {
      const credentials: Credentials = {
        bot_token: status.bot_token,
        baseUrl: status.baseurl || 'https://ilinkai.weixin.qq.com',
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
      }
      await this.saveCredentials(credentials)
      this.client.setCredentials(credentials)
      return {
        status: 'confirmed',
        credentials: { accountId: credentials.accountId, userId: credentials.userId },
      }
    }
    return { status: status.status }
  }

  /**
   * Poll QR code status until confirmed or expired
   */
  async waitForQRLogin(
    qrToken: string,
    onStatus?: (status: string) => void
  ): Promise<Credentials | null> {
    const maxAttempts = 120 // 2 minutes with 1s interval
    let attempts = 0

    while (attempts < maxAttempts) {
      const status = await this.client.getQRCodeStatus(qrToken)

      switch (status.status) {
        case 'wait':
          onStatus?.('Waiting for scan...')
          break

        case 'scaned':
          onStatus?.('QR code scanned! Waiting for confirmation...')
          break

        case 'confirmed':
          if (status.bot_token && status.ilink_bot_id && status.ilink_user_id) {
            const credentials: Credentials = {
              bot_token: status.bot_token,
              baseUrl: status.baseurl || 'https://ilinkai.weixin.qq.com',
              accountId: status.ilink_bot_id,
              userId: status.ilink_user_id,
              savedAt: new Date().toISOString(),
            }

            // Save credentials
            await this.saveCredentials(credentials)
            this.client.setCredentials(credentials)

            onStatus?.('Login successful!')
            return credentials
          }
          break

        case 'expired':
          onStatus?.('QR code expired')
          return null
      }

      // Wait 1 second before next poll
      await new Promise((resolve) => setTimeout(resolve, 1000))
      attempts++
    }

    return null
  }

  // ============================================
  // Polling
  // ============================================

  private startPolling(): void {
    if (this.pollState.isPolling) return

    this.pollState.isPolling = true
    this.pollLoop()
  }

  private async pollLoop(): Promise<void> {
    log.info('Polling started')
    let consecutiveFailures = 0
    let lastHeartbeatTime = Date.now()
    const HEARTBEAT_INTERVAL_MS = 60 * 1000 // 60 seconds
    // M9: shared exponential-with-jitter helper. The previous inline
    // `1000 * Math.pow(2, n - 1)` was deterministic, so a fleet of agim
    // instances recovering from a shared network event would all
    // reconnect in lock-step. Backoff(jitter=0.5) spreads the storm
    // across a ±50% window without changing the underlying cadence.
    // Base 2_000 / cap 30_000 preserves the prior schedule's ballpark
    // (2s, 4s, 8s, 16s, 30s capped) — first failure still has no
    // extra wait via the `consecutiveFailures > 1` gate below.
    const backoff = new Backoff({ baseMs: 2_000, capMs: 30_000, jitter: 0.5 })

    while (this.isRunning) {
      try {
        const response = await this.client.getUpdates(this.pollState.getUpdatesBuf)

        // Success — reset failure counter and backoff
        consecutiveFailures = 0
        backoff.reset()

        if (response.msgs?.length) {
          log.debug({ count: response.msgs.length }, 'Received messages')
        }

        const isSuccess = response.ret === 0 || response.ret === undefined
        if (isSuccess) {
          this.pollState.getUpdatesBuf = response.get_updates_buf

          if (response.msgs) {
            for (const msg of response.msgs) {
              this.handleIncomingMessage(msg).catch(err =>
                log.error({ err: err instanceof Error ? err.message : String(err) }, 'Message handler error')
              )
            }
          }
        } else if (response.ret === ILINK_ERRORS.SESSION_EXPIRED) {
          log.warn('WeChat session expired, attempting recovery...')
          const recovered = await this.tryRefreshSession()
          if (!recovered) {
            log.error('WeChat session expired. Token refresh failed after retries — polling stopped.')
            this.isRunning = false
            break
          }
          log.info('Token refreshed successfully, resuming polling')
        } else {
          log.warn({ ret: response.ret }, 'Unexpected getUpdates response code')
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        consecutiveFailures++
        log.error({ err: errMsg, consecutiveFailures }, 'Poll error')

        // First failure: no extra wait, just the regular 1s tail sleep.
        // From the second consecutive failure on, draw the next delay
        // from the jittered exponential schedule (2s/4s/8s/16s/30s ±50%).
        if (consecutiveFailures > 1) {
          const delayMs = backoff.nextDelayMs()
          log.warn({ delayMs }, `Backing off after ${consecutiveFailures} consecutive failures`)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          continue
        }
      }

      // Periodic heartbeat: getconfig probe (no side effect on the
      // long-poll cursor, so it's safe to run alongside the loop).
      if (Date.now() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatTime = Date.now()
        this.sendHeartbeat().catch(err =>
          log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Heartbeat error')
        )
        // L14: piggyback context-token sweep on the heartbeat tick (1/min).
        // Cheap full scan — bounded by active user count.
        this.cleanupExpiredContextTokens()
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    this.pollState.isPolling = false
    log.info('Polling stopped')
  }

  /**
   * Attempt to recover from SESSION_EXPIRED. Tries a fresh getUpdates
   * up to 3 times with linear backoff so a single network blip during
   * recovery doesn't tear down the whole adapter (W-3).
   */
  private async tryRefreshSession(): Promise<boolean> {
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.getUpdates('')
        if (response.ret === 0 || response.ret === undefined) {
          this.pollState.getUpdatesBuf = response.get_updates_buf
          if (response.msgs) {
            for (const msg of response.msgs) {
              // Preserve the reply context token even for non-dispatchable
              // messages (handleIncomingMessage also sets it, but only after
              // its bot/item-list early returns).
              if (msg.from_user_id && msg.context_token) {
                this.setContextToken(msg.from_user_id, msg.context_token)
              }
              // Actually DISPATCH the recovered messages. getUpdates('')
              // consumed the server-side cursor, so any messages it returns
              // are lost forever if we don't process them here. Mirror the
              // main poll loop: fire-and-forget + per-message dedup inside
              // handleIncomingMessage (so a later real re-delivery of the
              // same id is still deduped).
              this.handleIncomingMessage(msg).catch((err) =>
                log.error({ err: err instanceof Error ? err.message : String(err) },
                  'Recovered-message handler error'))
            }
          }
          log.info({ attempt, recovered: response.msgs?.length ?? 0 }, 'Session recovered after SESSION_EXPIRED')
          return true
        }
        log.warn({ attempt, ret: response.ret }, 'Session refresh attempt returned error')
      } catch (err) {
        log.warn({ attempt, err: err instanceof Error ? err.message : String(err) },
          'Session refresh attempt threw')
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000))  // 5s, 10s
      }
    }
    return false
  }

  /**
   * Periodic keep-alive: probe getconfig instead of getUpdates so we don't
   * race the polling loop on the same long-poll cursor (W-1).
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.client.hasCredentials()) return
    const ok = await this.client.pingConfig()
    if (ok) {
      log.debug('Heartbeat OK')
    } else {
      log.warn('Heartbeat failed (getconfig returned non-OK)')
    }
  }

  private async handleIncomingMessage(msg: WeixinMessage): Promise<void> {
    log.debug({ messageId: msg.message_id, type: msg.message_type }, 'handleIncomingMessage')

    if (!this.messageHandler) {
      log.warn('No message handler registered')
      return
    }

    if (msg.message_type === 2) {
      log.debug('Skipping bot message')
      return
    }

    const msgId = String(msg.message_id)
    if (msgId && this.processedMessages.has(msgId)) {
      log.debug({ messageId: msgId }, 'Skipping duplicate message')
      return
    }

    if (msgId) {
      this.processedMessages.set(msgId, Date.now())
      this.cleanupProcessedMessages()
    }

    if (!msg.item_list?.length) {
      log.debug('No item_list in message')
      return
    }

    // Store context token for replies
    if (msg.from_user_id && msg.context_token) {
      this.setContextToken(msg.from_user_id, msg.context_token)
    }

    const textParts: string[] = []
    const userId = msg.from_user_id || 'unknown'

    for (const item of msg.item_list) {
      const part = await this.extractItemContent(item, msgId, userId)
      if (part) textParts.push(part)
    }

    if (!textParts.length) {
      log.debug('No extractable content in message items')
      return
    }

    const text = textParts.join('\n')
    log.debug({
      text: text.substring(0, 200),
      fromUserId: msg.from_user_id,
      contextToken: msg.context_token ? 'present' : 'missing',
      itemTypes: msg.item_list.map(i => i.type),
    }, 'Extracted message content')

    const message: Message = {
      id: String(msg.message_id || Date.now()),
      threadId: msg.group_id ? `room:${msg.group_id}` : `user:${msg.from_user_id}`,
      userId,
      text,
      timestamp: new Date(msg.create_time_ms || Date.now()),
      channelId: this.client.getCredentials()?.accountId || 'default',
    }

    const ctx: MessageContext = {
      message,
      platform: 'wechat',
      channelId: this.client.getCredentials()?.accountId || 'default',
    }

    log.debug('Calling message handler')
    await this.messageHandler(ctx)
    log.debug('Message handler completed')
  }

  // ============================================
  // Media Item Handlers
  // ============================================

  /**
   * Extract displayable text content from a single message item. Text items
   * return their text directly; media items are downloaded and surfaced as
   * path markers that downstream agents can read.
   */
  private async extractItemContent(
    item: MessageItem,
    msgId: string,
    userId: string,
  ): Promise<string | null> {
    switch (item.type) {
      case ITEM_TYPE.TEXT:
        return item.text_item?.text || null

      case ITEM_TYPE.IMAGE:
        return this.handleImageItem(item, msgId, userId)

      case ITEM_TYPE.VOICE:
        return this.handleVoiceItem(item, msgId, userId)

      case ITEM_TYPE.FILE:
        return this.handleFileItem(item, msgId, userId)

      case ITEM_TYPE.VIDEO:
        return this.handleVideoItem(item, msgId, userId)

      default:
        log.debug({ type: item.type }, 'Ignoring unsupported item type')
        return null
    }
  }

  private async handleImageItem(
    item: MessageItem,
    msgId: string,
    userId: string,
  ): Promise<string> {
    if (!item.image_item) return '[图片消息：无图片数据]'

    const cdn = extractCdnMedia(item.image_item)
    if (!cdn) {
      log.warn({ event: 'wechat.media.image_no_cdn', msgId, image_item: item.image_item }, 'Image item has no downloadable CDN media')
      return '[图片消息：无法下载]'
    }

    try {
      const ext = pickExtensionForImage(item.image_item)
      const { path } = await downloadWechatMedia(
        this.client, cdn, userId, `${msgId}.${ext}`,
      )
      return `[图片附件：${path}]`
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'wechat.media.image_failed', err: reason, msgId }, 'image download failed')
      return `[图片附件下载失败：${reason}]`
    }
  }

  private async handleVoiceItem(
    item: MessageItem,
    msgId: string,
    userId: string,
  ): Promise<string> {
    if (!item.voice_item) return '[语音消息：无语音数据]'

    // WeChat may provide its own transcription via voice_item.text
    if (item.voice_item.text) {
      const dur = item.voice_item.playtime != null
        ? `${Math.round(item.voice_item.playtime / 1000)}s, `
        : ''
      return `[语音转写（${dur}微信识别）：${item.voice_item.text}]`
    }

    // No built-in transcription — download and run STT ourselves
    const cdn = extractCdnMedia(item.voice_item)
    if (!cdn) {
      log.warn({ event: 'wechat.media.voice_no_cdn', msgId, voice_item: item.voice_item }, 'Voice item has no downloadable CDN media and no text')
      return '[语音消息：无法下载且无转写文本]'
    }

    let savedPath: string | null = null
    try {
      const ext = pickExtensionForVoice(item.voice_item)
      const { path } = await downloadWechatMedia(
        this.client, cdn, userId, `${msgId}.${ext}`,
      )
      savedPath = path
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'wechat.media.voice_download_failed', err: reason, msgId }, 'voice download failed')
      return `[语音附件下载失败：${reason}]`
    }

    if (detectProvider() === 'none') {
      return `[语音附件未转写（未配置 OPENAI_API_KEY 或 IMHUB_WHISPERCPP_BIN）：${savedPath}]`
    }

    try {
      const result = await transcribe(savedPath, { language: 'zh' })
      const dur = item.voice_item.playtime != null
        ? `${Math.round(item.voice_item.playtime / 1000)}s, `
        : ''
      return [
        `[语音转写（${dur}provider=${result.provider}, ${result.elapsedMs}ms）：`,
        result.text || '（空）',
        `源文件：${savedPath}]`,
      ].join('\n')
    } catch (err) {
      const reason = err instanceof TranscribeError
        ? `${err.provider}: ${err.reason}`
        : err instanceof Error ? err.message : String(err)
      return `[语音转写失败（${reason}）\n源文件：${savedPath}]`
    }
  }

  private async handleFileItem(
    item: MessageItem,
    msgId: string,
    userId: string,
  ): Promise<string> {
    if (!item.file_item) return '[文件消息：无文件数据]'

    const cdn = extractCdnMedia(item.file_item)
    if (!cdn) {
      log.warn({ event: 'wechat.media.file_no_cdn', msgId, file_item: item.file_item }, 'File item has no downloadable CDN media')
      return `[文件消息：无法下载${item.file_item.file_name ? ` (${item.file_item.file_name})` : ''}]`
    }

    const displayName = item.file_item.file_name || '未命名文件'
    try {
      const ext = pickExtensionForFile(item.file_item)
      const filename = item.file_item.file_name || `${msgId}.${ext}`
      const safeName = filename.replace(/[/\\]/g, '_')
      const { path, bytes } = await downloadWechatMedia(
        this.client, cdn, userId, safeName,
      )
      const sizeStr = bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${(bytes / 1024).toFixed(0)} KB`
      return `[文件附件：${path} (${displayName}, ${sizeStr})]`
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'wechat.media.file_failed', err: reason, msgId }, 'file download failed')
      return `[文件附件下载失败：${reason} (${displayName})]`
    }
  }

  private async handleVideoItem(
    item: MessageItem,
    msgId: string,
    userId: string,
  ): Promise<string> {
    if (!item.video_item) return '[视频消息：无视频数据]'

    const cdn = extractCdnMedia(item.video_item)
    if (!cdn) {
      log.warn({ event: 'wechat.media.video_no_cdn', msgId, video_item: item.video_item }, 'Video item has no downloadable CDN media')
      return '[视频消息：无法下载]'
    }

    try {
      const ext = pickExtensionForVideo(item.video_item)
      const { path, bytes } = await downloadWechatMedia(
        this.client, cdn, userId, `${msgId}.${ext}`,
      )
      const dur = item.video_item.play_length != null
        ? `${item.video_item.play_length}s, `
        : ''
      const sizeStr = bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${(bytes / 1024).toFixed(0)} KB`
      return `[视频附件：${path} (${dur}${sizeStr})]`
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'wechat.media.video_failed', err: reason, msgId }, 'video download failed')
      return `[视频附件下载失败：${reason}]`
    }
  }

  // ============================================
  // Context Token Management
  // ============================================

  private getContextToken(userId: string): string | null {
    const now = Date.now()
    const cached = this.contextTokens.get(userId)
    if (cached) {
      if (now - cached.timestamp > CONTEXT_TOKEN_TTL) {
        this.contextTokens.delete(userId)
        // Fall through to DB — last-resort same-user token might be even
        // older, but the DB-backed cleanup will reject expired rows too.
      } else {
        return cached.contextToken
      }
    }

    // Map miss (or just-expired) → fall back to persistent store. This makes
    // first-send-after-restart succeed when the user messaged before the
    // restart and the token is still within its 30-min window.
    const stored = loadContextToken(userId, CONTEXT_TOKEN_TTL, now)
    if (!stored) return null
    // Re-populate the Map so subsequent sends in this run skip the DB.
    this.contextTokens.set(userId, {
      userId: stored.userId,
      contextToken: stored.token,
      timestamp: stored.fetchedAt,
    })
    return stored.token
  }

  private setContextToken(userId: string, token: string): void {
    const now = Date.now()
    this.contextTokens.set(userId, {
      userId,
      contextToken: token,
      timestamp: now,
    })
    // Write-through. Best-effort: store calls fail-soft on SQLite issues.
    persistContextToken(userId, token, now)
  }

  private cleanupProcessedMessages(): void {
    const now = Date.now()
    for (const [msgId, timestamp] of this.processedMessages) {
      if (now - timestamp > PROCESSED_MESSAGES_TTL) {
        this.processedMessages.delete(msgId)
      }
    }
  }

  /**
   * L14: drop expired context-token entries. The original implementation
   * only removed an entry on read (`getContextToken` checked TTL), so a
   * userId that messaged once and never came back left its row in the
   * Map indefinitely. Called from the polling loop at the same cadence
   * as cleanupProcessedMessages so memory stays bounded under big group
   * sizes / churning user populations.
   */
  private cleanupExpiredContextTokens(): void {
    const now = Date.now()
    for (const [userId, cached] of this.contextTokens) {
      if (now - cached.timestamp > CONTEXT_TOKEN_TTL) {
        this.contextTokens.delete(userId)
      }
    }
    // Mirror the cleanup into the persistent store so its row count stays
    // bounded too. Cheap (indexed by fetched_at).
    cleanupExpiredTokensInStore(CONTEXT_TOKEN_TTL, now)
  }

  // ============================================
  // Credentials Persistence
  // ============================================

  private async loadCredentials(): Promise<Credentials | null> {
    try {
      const data = await readFile(CREDENTIALS_FILE, 'utf-8')
      // Defense in depth: nag in logs if the file isn't 0o600. We can't
      // safely chmod it on the user's behalf at load time (concurrent ops,
      // odd ownership) but the warning prompts an operator to fix legacy
      // credentials files written before H9.
      try {
        const st = await stat(CREDENTIALS_FILE)
        if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
          log.warn({
            file: CREDENTIALS_FILE,
            mode: (st.mode & 0o777).toString(8),
          }, 'Credentials file is group/world readable — chmod 600 recommended')
        }
      } catch { /* stat failure is non-fatal */ }
      return JSON.parse(data) as Credentials
    } catch {
      return null
    }
  }

  private async saveCredentials(credentials: Credentials): Promise<void> {
    const dir = join(CREDENTIALS_FILE, '..')
    // Restrict the parent dir to the current user. recursive:true is a no-op
    // when the dir already exists with looser perms — accept that compromise
    // (we don't want to chmod existing dirs out from under the operator) and
    // rely on the file-level 0o600 below as the primary line of defense.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 })
    log.info({ file: CREDENTIALS_FILE }, 'Credentials saved')
  }

  // ============================================
  // Utilities
  // ============================================

  private splitMessage(text: string, maxLength = 2000): string[] {
    if (text.length <= maxLength) {
      return [text]
    }

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > maxLength) {
      // Try to split at newline
      let splitPoint = remaining.lastIndexOf('\n', maxLength)
      if (splitPoint < maxLength / 2) {
        splitPoint = maxLength
      }

      chunks.push(remaining.slice(0, splitPoint))
      remaining = remaining.slice(splitPoint).trim()
    }

    if (remaining) {
      chunks.push(remaining)
    }

    // Add continuation markers
    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length - 1; i++) {
        chunks[i] += '\n\n[continued...]'
      }
    }

    return chunks
  }
}

// Singleton instance
export const ilinkWeChatAdapter = new ILinkWeChatAdapter()
