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
}

/** Inbound message payload from the Stream SDK's TOPIC_ROBOT callback.
 *  All fields are present on real deliveries; some are typed as optional
 *  for resilience against partial replays. */
export interface DingTalkInboundMessage {
  /** Unique message id for dedup. */
  msgId: string
  /** Always 'text' for now — DingTalk's stream bot only delivers text. */
  msgtype: string
  text?: { content: string }
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
}
