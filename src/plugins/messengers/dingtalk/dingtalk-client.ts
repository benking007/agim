// DingTalk Bot client — wraps the official `dingtalk-stream` SDK for
// inbound messages (WebSocket Stream mode) and uses DingTalk's REST
// OpenAPI for outbound messages.
//
// Architecture matches the Feishu client:
//   * Inbound goes through TOPIC_ROBOT callback registered with DWClient
//   * Outbound uses access-token-authed POST to api.dingtalk.com
//   * The SDK manages WebSocket reconnect (1s-60s exponential), heartbeat,
//     and access-token refresh — we just call getAccessToken() before
//     each OpenAPI send and the SDK caches/refreshes as needed.
//
// Why not sessionWebhook (the temporary 30s URL each inbound message
// carries)?  Because im-hub's primary use case is multi-minute agent
// runs and the sessionWebhook is always stale by the time the agent
// finishes. OpenAPI works for any send regardless of elapsed time.

import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream'
import { logger as rootLogger } from '../../../core/logger.js'
import type { DingTalkConfig, DingTalkInboundMessage } from './types.js'

const log = rootLogger.child({ component: 'dingtalk-client' })

const API_BASE = 'https://api.dingtalk.com'
const URL_1V1 = `${API_BASE}/v1.0/robot/oToMessages/batchSend`
const URL_GROUP = `${API_BASE}/v1.0/robot/groupMessages/send`

type MessageHandler = (msg: DingTalkInboundMessage) => Promise<void>

/** Decoded routing target derived from an inbound message's threadId.
 *  Adapter encodes threadId as `user:<staffId>` or `group:<convId>`. */
interface RoutingTarget {
  kind: 'user' | 'group'
  /** For 1:1: the staffId. For group: the openConversationId. */
  id: string
}

function parseThreadId(threadId: string): RoutingTarget | null {
  if (threadId.startsWith('user:')) {
    return { kind: 'user', id: threadId.slice('user:'.length) }
  }
  if (threadId.startsWith('group:')) {
    return { kind: 'group', id: threadId.slice('group:'.length) }
  }
  return null
}

export class DingTalkClient {
  private dw: DWClient
  private config: DingTalkConfig
  private messageHandler?: MessageHandler
  /** Cached robotCode from the most recent inbound (== clientId for
   *  stream-mode internal apps, but we read it from messages so we're
   *  tolerant of multi-bot setups in one app). */
  private lastSeenRobotCode: string

  constructor(config: DingTalkConfig) {
    this.config = config
    this.lastSeenRobotCode = config.clientId  // sensible default
    this.dw = new DWClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      // DWClient defaults: autoReconnect=true, debug=false, keepAlive=false.
      // Reconnect strategy is 1s → 60s exponential, heartbeat 8s — already
      // matches our needs.
    })
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    this.dw.registerCallbackListener(TOPIC_ROBOT, async (res: DWClientDownStream) => {
      let msg: DingTalkInboundMessage
      try {
        msg = JSON.parse(res.data) as DingTalkInboundMessage
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), data: res.data?.slice?.(0, 200) },
          'failed to parse TOPIC_ROBOT data')
        return
      }
      if (msg.robotCode) this.lastSeenRobotCode = msg.robotCode
      if (this.messageHandler) {
        try {
          await this.messageHandler(msg)
        } catch (err) {
          log.error({ err: err instanceof Error ? err.message : String(err) },
            'message handler threw')
        }
      }
      // ack so the gateway doesn't redeliver. We're swallowing the
      // response payload here intentionally — DingTalk gives 60s before
      // it retries; our agent flow may exceed that and that's fine,
      // the user gets the eventual reply via OpenAPI.
      this.dw.socketCallBackResponse(res.headers.messageId, { status: 'SUCCESS' })
    })

    await this.dw.connect()
    log.info({ event: 'dingtalk.client.connected' }, 'WebSocket connected')
  }

  async stop(): Promise<void> {
    try { this.dw.disconnect() } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) },
        'error during dingtalk disconnect (ignored)')
    }
  }

  /** Send a plain-text message to a thread we previously received from
   *  (encoded as `user:<staffId>` for 1:1, `group:<convId>` for groups).
   *  Uses OpenAPI under the bot's access token. */
  async sendMessage(threadId: string, text: string): Promise<void> {
    await this.sendTemplated(threadId, 'sampleText', { content: text })
  }

  /** Send a markdown-formatted message. DingTalk's `sampleMarkdown` only
   *  takes `title` + `text`; we derive title from the first line so the
   *  user sees something meaningful in the notification preview. */
  async sendMarkdown(threadId: string, text: string, title?: string): Promise<void> {
    const firstLine = text.split('\n', 1)[0]?.replace(/^[#*\-\s>]+/, '').slice(0, 32) || 'Message'
    await this.sendTemplated(threadId, 'sampleMarkdown', {
      title: title ?? firstLine,
      text,
    })
  }

  /** Shared POST path. msgKey + msgParam (stringified inner object) is
   *  DingTalk's "templated message" convention — covers text, markdown,
   *  cards via the same endpoint. */
  private async sendTemplated(
    threadId: string,
    msgKey: string,
    inner: Record<string, unknown>,
  ): Promise<void> {
    const target = parseThreadId(threadId)
    if (!target) {
      throw new Error(`dingtalk: unrecognised threadId "${threadId}" (expected user:<id> or group:<id>)`)
    }
    const accessToken = await this.dw.getAccessToken()
    if (!accessToken) {
      throw new Error('dingtalk: getAccessToken() returned empty token')
    }
    const body =
      target.kind === 'user'
        ? {
            robotCode: this.lastSeenRobotCode,
            userIds: [target.id],
            msgKey,
            msgParam: JSON.stringify(inner),
          }
        : {
            robotCode: this.lastSeenRobotCode,
            openConversationId: target.id,
            msgKey,
            msgParam: JSON.stringify(inner),
          }
    const url = target.kind === 'user' ? URL_1V1 : URL_GROUP
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': String(accessToken),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`dingtalk: ${target.kind} send failed: ${res.status} ${res.statusText} ${txt.slice(0, 200)}`)
    }
  }
}
