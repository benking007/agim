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
import { DingTalkClient } from './dingtalk-client.js'
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

  private async handleInbound(msg: DingTalkInboundMessage): Promise<void> {
    if (!this.messageHandler) {
      log.debug('no message handler registered')
      return
    }
    if (msg.msgId && this.isDuplicate(msg.msgId)) {
      log.info({ messageId: msg.msgId, event: 'dingtalk.dedup.skip' }, 'dropping replayed msgId')
      return
    }
    if (msg.msgtype !== 'text') {
      log.debug({ msgtype: msg.msgtype, messageId: msg.msgId },
        'non-text dingtalk message — ignored (Stream only delivers text anyway)')
      return
    }

    const text = msg.text?.content?.trim() ?? ''
    if (!text) {
      log.debug('empty text in dingtalk message — ignored')
      return
    }

    // threadId encoding (see file header). For 1:1 we route by sender;
    // for groups, by openConversationId so any group member triggers a
    // shared session in that group.
    const isGroup = msg.conversationType === '2'
    const threadId = isGroup ? `group:${msg.conversationId}` : `user:${msg.senderStaffId}`

    const channelId = this.config?.channelId || 'default'
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
      await this.messageHandler(ctx)
    } catch (err) {
      log.error({
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }, 'error in dingtalk message handler')
    }
  }
}

export const dingtalkAdapter = new DingTalkAdapter()
