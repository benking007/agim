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
// carries)?  Because agim's primary use case is multi-minute agent
// runs and the sessionWebhook is always stale by the time the agent
// finishes. OpenAPI works for any send regardless of elapsed time.

import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream'
import { logger as rootLogger } from '../../../core/logger.js'
import type { DingTalkConfig, DingTalkInboundMessage } from './types.js'

const log = rootLogger.child({ component: 'dingtalk-client' })

const API_BASE = 'https://api.dingtalk.com'
const URL_1V1 = `${API_BASE}/v1.0/robot/oToMessages/batchSend`
const URL_GROUP = `${API_BASE}/v1.0/robot/groupMessages/send`
const URL_MEDIA_DL = `${API_BASE}/v1.0/robot/messageFiles/download`

/** Hard cap on a single inbound media download. DingTalk caps voice at
 *  ~2 MB and images at ~10 MB on the consumer client; 20 MB gives us
 *  headroom for files without letting a runaway upload fill the disk. */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024

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
      // Ack FIRST, then dispatch fire-and-forget. Previously we awaited the
      // full agent run before acking, which (a) blocked this WS callback from
      // processing the next inbound message for the whole turn, and (b) for a
      // run exceeding the gateway's ~60s retry window triggered a redelivery
      // that app-level dedup then had to absorb — and if the handler HUNG, the
      // message was never acked and the redelivery was dropped by dedup, so
      // the user got nothing. Acking up front (the message IS received) +
      // background dispatch fixes both. Same-tick duplicate is impossible:
      // gateway redelivery is seconds later, by which point dedup is populated.
      this.dw.socketCallBackResponse(res.headers.messageId, { status: 'SUCCESS' })
      if (this.messageHandler) {
        void this.messageHandler(msg).catch((err) =>
          log.error({ err: err instanceof Error ? err.message : String(err) },
            'message handler threw'))
      }
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

  /** Download an inbound image / voice / file message's binary payload.
   *
   *  DingTalk hands the bot a short-lived `downloadCode` in each media
   *  inbound; we trade it (plus our robotCode) for a presigned downloadUrl
   *  on alibaba CDN, then GET that URL and return the bytes.
   *
   *  Returns null on any error (caller surfaces a "[download failed:...]"
   *  marker instead of silently dropping the user's message). MAX cap is
   *  enforced; oversize payloads throw before allocating the buffer.
   *
   *  Reference: POST /v1.0/robot/messageFiles/download
   *             { downloadCode, robotCode }
   *             header: x-acs-dingtalk-access-token
   *             response: { downloadUrl }   (sometimes nested under .data)
   */
  async downloadMessageFile(downloadCode: string): Promise<
    { buffer: Buffer; contentType: string } | null
  > {
    if (!downloadCode) return null
    let accessToken: string | undefined
    try {
      accessToken = await this.dw.getAccessToken()
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) },
        'dingtalk: getAccessToken failed before media download')
      return null
    }
    if (!accessToken) return null

    // Step 1: exchange downloadCode for a CDN URL.
    let downloadUrl: string | null = null
    try {
      const res = await fetch(URL_MEDIA_DL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': String(accessToken),
        },
        body: JSON.stringify({ downloadCode, robotCode: this.lastSeenRobotCode }),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        log.warn({
          status: res.status,
          body: txt.slice(0, 200),
          event: 'dingtalk.media.exchange_failed',
        }, 'messageFiles/download API rejected the downloadCode exchange')
        return null
      }
      const payload = await res.json().catch(() => null) as
        | { downloadUrl?: string; data?: { downloadUrl?: string } }
        | null
      downloadUrl = payload?.downloadUrl ?? payload?.data?.downloadUrl ?? null
      if (!downloadUrl) {
        log.warn({ event: 'dingtalk.media.no_url_in_response', payload },
          'exchange succeeded but response had no downloadUrl')
        return null
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) },
        'dingtalk: downloadCode exchange threw')
      return null
    }

    // Step 2: GET the CDN URL. DingTalk's CDN may be on different alibaba
    // hosts depending on the file type / region; no host restriction here.
    try {
      const res = await fetch(downloadUrl)
      if (!res.ok) {
        log.warn({ status: res.status, event: 'dingtalk.media.cdn_get_failed' },
          'CDN refused the download')
        return null
      }
      const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10)
      if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) {
        log.warn({ contentLength, max: MAX_MEDIA_BYTES, event: 'dingtalk.media.too_large' },
          'media exceeds size cap; refusing to download')
        return null
      }
      const arr = await res.arrayBuffer()
      if (arr.byteLength > MAX_MEDIA_BYTES) {
        log.warn({ bytes: arr.byteLength, max: MAX_MEDIA_BYTES, event: 'dingtalk.media.too_large' },
          'media bytes exceed size cap after download')
        return null
      }
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
      return { buffer: Buffer.from(arr), contentType }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) },
        'dingtalk: CDN GET threw')
      return null
    }
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
