// WeChat iLink Bot API HTTP Client
// Pure HTTP wrapper for iLink API endpoints

import { createDecipheriv } from 'node:crypto'
import type {
  QRCodeResponse,
  QRCodeStatusResponse,
  Credentials,
  CDNMedia,
  GetUpdatesRequest,
  GetUpdatesResponse,
  SendMessageRequest,
  SendMessageResponse,
  GetConfigRequest,
  GetConfigResponse,
  SendTypingRequest,
  SendTypingResponse,
} from './ilink-types.js'

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '1.0.0'
const FETCH_TIMEOUT = 30000 // 30 seconds for HTTP calls

export class ILinkClient {
  private baseUrl: string
  private botToken: string | null = null
  private accountId: string = ''
  private userId: string = ''
  private channelId: string = 'default'

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl
  }

  // ============================================
  // Authentication
  // ============================================

  /**
   * Get channel ID
   */
  getChannelId(): string {
    return this.channelId
  }

  /**
   * Set channel ID
   */
  setChannelId(channelId: string): void {
    this.channelId = channelId
  }

  /**
   * Get QR code for login
   */
  async getQRCode(): Promise<QRCodeResponse> {
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`
    // L6: every outbound fetch wears the same FETCH_TIMEOUT so a stalled
    // network connection can never wedge a long-poll / login flow forever.
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
    if (!response.ok) {
      throw new Error(`getQRCode failed: ${response.status}`)
    }
    return response.json() as Promise<QRCodeResponse>
  }

  /**
   * Poll QR code status
   */
  async getQRCodeStatus(qrcode: string): Promise<QRCodeStatusResponse> {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    const response = await fetch(url, {
      headers: {
        'iLink-App-ClientVersion': '1',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })
    if (!response.ok) {
      throw new Error(`getQRCodeStatus failed: ${response.status}`)
    }
    return response.json() as Promise<QRCodeStatusResponse>
  }

  /**
   * Set credentials after successful login
   */
  setCredentials(credentials: Credentials): void {
    this.botToken = credentials.bot_token
    if (credentials.baseUrl) {
      this.baseUrl = credentials.baseUrl
    }
    if (credentials.accountId) {
      this.accountId = credentials.accountId
    }
    if (credentials.userId) {
      this.userId = credentials.userId
    }
    if (credentials.channelId) {
      this.channelId = credentials.channelId
    }
  }

  /**
   * Clear credentials (logout)
   */
  clearCredentials(): void {
    this.botToken = null
    this.accountId = ''
    this.userId = ''
  }

  /**
   * Check if credentials are set
   */
  hasCredentials(): boolean {
    return this.botToken !== null
  }

  /**
   * Get credentials (for channel ID access)
   */
  getCredentials(): Credentials | null {
    if (!this.botToken) return null
    return {
      bot_token: this.botToken,
      baseUrl: this.baseUrl,
      accountId: this.accountId,
      userId: this.userId,
      channelId: this.channelId,
      savedAt: '',
    }
  }

  // ============================================
  // Message Polling
  // ============================================

  /**
   * Get updates (long polling)
   */
  async getUpdates(getUpdatesBuf: string = ''): Promise<GetUpdatesResponse> {
    if (!this.botToken) {
      throw new Error('No credentials - need to login first')
    }

    const url = `${this.baseUrl}/ilink/bot/getupdates`
    const body: GetUpdatesRequest = {
      get_updates_buf: getUpdatesBuf,
      base_info: {
        channel_version: CHANNEL_VERSION,
      },
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })

    if (!response.ok) {
      throw new Error(`getUpdates failed: ${response.status}`)
    }

    return response.json() as Promise<GetUpdatesResponse>
  }

  // ============================================
  // Message Sending
  // ============================================

  /**
   * Send a text message
   */
  async sendMessage(
    toUserId: string,
    text: string,
    contextToken: string
  ): Promise<SendMessageResponse> {
    if (!this.botToken) {
      throw new Error('No credentials - need to login first')
    }

    const url = `${this.baseUrl}/ilink/bot/sendmessage`
    const body: SendMessageRequest = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `im-hub:${Date.now()}-${Math.random().toString(36).slice(2)}`,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [
          {
            type: 1, // TEXT
            // iLink Bot API 要求 CRLF；只发 \n 时部分微信客户端会把换行吞掉。
            text_item: { text: text.replace(/\n/g, '\r\n') },
          },
        ],
      },
      base_info: {
        channel_version: CHANNEL_VERSION,
      },
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })

    if (!response.ok) {
      throw new Error(`sendMessage failed: ${response.status}`)
    }

    return response.json() as Promise<SendMessageResponse>
  }

  // ============================================
  // Media Download
  // ============================================

  /**
   * Download media content via the signed CDN URL embedded in the message
   * payload. iLink delivers media as an AES-128-ECB encrypted blob behind
   * `media.full_url`; `media.aes_key` is base64 of a 32-char ASCII hex
   * string, which after hex-decode becomes the 16-byte AES-128 key. There is
   * no `/ilink/bot/downloadmedia` endpoint — the bot fetches the CDN
   * directly with no auth header.
   */
  async downloadMedia(cdnMedia: CDNMedia): Promise<Buffer> {
    if (!cdnMedia.full_url) {
      throw new Error('downloadMedia: media.full_url is missing')
    }
    if (!cdnMedia.aes_key) {
      throw new Error('downloadMedia: media.aes_key is missing')
    }

    // media.aes_key is base64("<32-char-hex-string>"); decode → ASCII hex → bytes
    const aeskeyHex = Buffer.from(cdnMedia.aes_key, 'base64').toString('utf8')
    if (!/^[0-9a-fA-F]{32}$/.test(aeskeyHex)) {
      throw new Error(`downloadMedia: decoded aes_key is not 32 hex chars (got ${aeskeyHex.length}: ${aeskeyHex.slice(0, 16)}...)`)
    }
    const key = Buffer.from(aeskeyHex, 'hex')

    const response = await fetch(cdnMedia.full_url, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })

    if (!response.ok) {
      throw new Error(`downloadMedia CDN fetch failed: ${response.status} ${response.statusText}`)
    }

    const arrayBuf = await response.arrayBuffer()
    const cipherBuf = Buffer.from(arrayBuf)
    if (cipherBuf.length === 0 || cipherBuf.length % 16 !== 0) {
      throw new Error(`downloadMedia: ciphertext length ${cipherBuf.length} is not a multiple of 16`)
    }

    // AES-128-ECB. PKCS#7 padding is applied by WeChat's encrypt side; Node's
    // default decipher will strip it.
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(cipherBuf), decipher.final()])
  }

  // ============================================
  // Typing Indicator
  // ============================================

  /**
   * Lightweight session-keepalive probe. Issues a getconfig call against
   * the bot's own user id; success → token still valid. Used by the
   * polling loop's heartbeat tick (does NOT touch the long-poll cursor,
   * unlike getUpdates).
   */
  async pingConfig(): Promise<boolean> {
    if (!this.botToken || !this.userId) return false
    const url = `${this.baseUrl}/ilink/bot/getconfig`
    const body: GetConfigRequest = {
      ilink_user_id: this.userId,
      base_info: { channel_version: CHANNEL_VERSION },
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      })
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Get typing ticket for a user
   */
  async getTypingTicket(
    userId: string,
    contextToken?: string
  ): Promise<string | null> {
    if (!this.botToken) {
      return null
    }

    const url = `${this.baseUrl}/ilink/bot/getconfig`
    const body: GetConfigRequest = {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: {
        channel_version: CHANNEL_VERSION,
      },
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      })

      if (!response.ok) {
        return null
      }

      const data = (await response.json()) as GetConfigResponse
      return data.ret === 0 ? data.typing_ticket || null : null
    } catch {
      return null
    }
  }

  /**
   * Send typing indicator
   */
  async sendTyping(
    userId: string,
    typingTicket: string,
    status: 1 | 2
  ): Promise<boolean> {
    if (!this.botToken) {
      return false
    }

    const url = `${this.baseUrl}/ilink/bot/sendtyping`
    const body: SendTypingRequest = {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
      base_info: {
        channel_version: CHANNEL_VERSION,
      },
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      })

      if (!response.ok) {
        return false
      }

      const data = (await response.json()) as SendTypingResponse
      return data.ret === 0 || data.ret === undefined
    } catch {
      return false
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private getAuthHeaders(): Record<string, string> {
    if (!this.botToken) {
      throw new Error('No bot token available')
    }

    // Generate X-WECHAT-UIN: random uint32 → decimal string → base64
    const randomUin = crypto.getRandomValues(new Uint32Array(1))[0]
    const uinBase64 = btoa(String(randomUin))

    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.botToken}`,
      'X-WECHAT-UIN': uinBase64,
    }
  }
}
