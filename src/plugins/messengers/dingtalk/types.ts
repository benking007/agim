// DingTalk (钉钉) Bot — Stream-mode messenger types
//
// Reference:
//   * SDK: https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
//   * Stream mode protocol: https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
//   * 1:1 send: POST /v1.0/robot/oToMessages/batchSend
//   * Group send: POST /v1.0/robot/groupMessages/send
//
// Note: the SDK's RobotTextMessage type covers only `msgtype: 'text'`, but
// inbound payloads carry conversationType / robotCode / sessionWebhook
// that we need for routing — restate the full shape here so the adapter
// can switch on conversationType without fighting the SDK union.

export interface DingTalkConfig {
  /** AppKey from the DingTalk developer console (also serves as robotCode). */
  clientId: string
  /** AppSecret — used by the SDK to obtain access tokens automatically. */
  clientSecret: string
  /** Optional channel id (forwarded to MessageContext); we don't drive
   *  routing on it but a few downstream consumers tag logs by it. */
  channelId?: string
  /** Batch 1 (#4) — DM access policy. Defaults to 'open' (current behavior).
   *  - `open`       : any user can DM the bot (existing default)
   *  - `pairing`    : only users seen in earlier `allowFrom`-acked messages
   *  - `allowlist`  : only senderStaffId in `allowFrom` may DM the bot */
  dmPolicy?: 'open' | 'pairing' | 'allowlist'
  /** Batch 1 (#4) — Group access policy. Defaults to 'open'.
   *  - `open`       : any group @-mention is accepted
   *  - `allowlist`  : only sender in `groupAllowFrom` is accepted
   *  - `disabled`   : no group chat handling at all */
  groupPolicy?: 'open' | 'allowlist' | 'disabled'
  /** senderStaffId allowed when dmPolicy = allowlist (or seeded for pairing). */
  allowFrom?: string[]
  /** senderStaffId allowed when groupPolicy = allowlist. */
  groupAllowFrom?: string[]
  /** Batch 1 (#7) — ack-reaction mode: render a quick "received / working / done"
   *  emoji marker right after inbound. Defaults to 'off' (no change to today's
   *  behavior). `emoji` uses ⏳ → 🤖 → ✅; `kaomoji` uses pure-text faces for
   *  fonts that don't render emoji (some legacy corp clients). */
  ackReaction?: 'off' | 'emoji' | 'kaomoji'
}

/** Inbound message payload from the Stream SDK's TOPIC_ROBOT callback.
 *  Empirically observed msgtype values (community docs say `image`/`voice`
 *  but DingTalk actually wire-formats them as `picture`/`audio`):
 *    'text' | 'picture' | 'audio' | 'file' | 'link' | 'markdown' | 'action_card'
 *  The official Node SDK only types `text`; we keep msgtype as a loose
 *  string and snapshot known shapes for the rest. Unknown shapes fall
 *  through to a debug-logging path that dumps the full payload — that's
 *  how we discovered the `picture`/`audio` naming + the `content` block
 *  shape (community docs document those fields under `msg.picture` etc.,
 *  but real deliveries put them inside a single `content` object). */
export interface DingTalkInboundMessage {
  /** Unique message id for dedup. */
  msgId: string
  /** One of the empirically-confirmed msgtype values, or something else. */
  msgtype: string
  /** Present on msgtype='text'. */
  text?: { content: string }
  /** Present on msgtype='link'. picUrl is the thumbnail; messageUrl is
   *  the deep link / URL the user actually shared. Title/text are
   *  display preview. */
  link?: { title?: string; text?: string; picUrl?: string; messageUrl?: string }
  /** Catch-all `content` block — used by every non-text/non-link msgtype.
   *  Different msgtype values use different subsets of the fields below:
   *    picture: { pictureDownloadCode (full), downloadCode (thumb) }
   *    audio:   { downloadCode, recognition (DingTalk's server-side ASR!) }
   *    file:    { downloadCode, fileName }     (best-effort from docs)
   *    markdown / action_card: { text, title } (best-effort) */
  content?: {
    pictureDownloadCode?: string
    downloadCode?: string
    /** DingTalk's built-in voice-to-text for `audio` messages. Prefer
     *  this over running whisper.cpp locally — it's typically more
     *  accurate for Mandarin and zero-cost on our side. */
    recognition?: string
    title?: string
    text?: string
    fileName?: string
    duration?: string | number
  }
  /** Conversation id in OpenAPI's `openConversationId` shape — usable
   *  directly when calling /v1.0/robot/groupMessages/send. */
  conversationId: string
  /** '1' = single chat (1:1), '2' = group chat. */
  conversationType: '1' | '2' | string
  /** Internal staff id of the message sender (use in 1:1 send userIds). */
  senderStaffId: string
  senderNick?: string
  senderCorpId?: string
  /** Bot's own ids (chatbotUserId = robot's user id inside the corp). */
  chatbotUserId?: string
  chatbotCorpId?: string
  /** The bot's robotCode — same value as the configured AppKey/clientId
   *  for stream-mode internal apps, but we read it from the message so
   *  we don't have to hard-code the relationship. */
  robotCode: string
  /** Temporary webhook URL the bot can POST to without an access token,
   *  valid until `sessionWebhookExpiredTime` (ms epoch). 30s in practice. */
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
  createAt?: number
  isAdmin?: boolean
  /** Catch-all for unknown fields — we never index this in code, but
   *  preserving it lets the debug-log path dump the full payload. */
  [extra: string]: unknown
}
