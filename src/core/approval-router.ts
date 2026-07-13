// approval-router — 把 approval-bus 的两个端口接到 IM messenger 上：
//   1. notifier：bus 收到 sidecar 的审批请求 → 这里翻译成文本/卡片 → 推到对应 IM thread
//   2. 拦截层：用户在该 thread 回复 y/n/批准/拒绝时，cli 主 handler 把消息先交给我们；
//      命中就 resolvePending，吃掉这条消息不进 router；不命中放行，并把已挂起的
//      pending 当作"用户改主意"自动 deny。
//
// 不知道 messenger 实现细节，只通过注入的 resolveMessenger 拿到 sendMessage/sendCard。

import type {
  MessengerAdapter,
  ButtonCallback,
  ApprovalCardPrompt,
  ApprovalCardOutcome,
} from './types.js'
import {
  approvalBus,
  humanizeFingerprint,
  isTimeoutDefaultAllow,
  type ApprovalNotification,
  type Decision,
  type ResolvedInfo,
  type ResolutionEvent,
} from './approval-bus.js'
import { checkToolUse } from './self-protect.js'
import { logger as rootLogger } from './logger.js'
import { sink } from './message-sink.js'

const log = rootLogger.child({ component: 'approval-router' })

/** Truncation limit for the plain-text approval prompt. Conservative because
 *  some IMs (older WeChat clients) start chunking aggressively past ~500
 *  chars and the y/n line at the bottom must stay visible. */
const MAX_INPUT_PREVIEW = 400

/** Truncation limit for the rich-card approval prompt. Telegram allows ~4 KB
 *  per message; with the surrounding template (~150 chars) and a <pre>
 *  block, 1500 fits in one bubble and covers the long tail of Bash / Edit
 *  payloads without losing context. */
const MAX_INPUT_PREVIEW_CARD = 1500

const ALLOW_TOKENS = new Set([
  'y', 'yes', 'ok', '1', '批准', '同意', '通过', '可以', '✅',
])
const DENY_TOKENS = new Set([
  'n', 'no', '0', '拒绝', '不同意', '不行', '不可以', '不', '❌',
])
/** "Approve this and auto-approve future calls of the same tool with the
 *  same input prefix in this session." Bus consumes `autoAllowFurther` and
 *  registers the rule. */
const ALLOW_ALL_TOKENS = new Set([
  'all', 'a', '全部', '总是', '都同意', '都批准',
])

/**
 * Classify an inbound IM reply as an approval decision. Returns null when the
 * reply doesn't match any known pattern — the caller should treat that as
 * "user changed topic" and route normally.
 */
export function parseApprovalReply(text: string): Decision | null {
  const trimmed = text.trim().toLowerCase()
  if (!trimmed) return null
  // Strip leading slashes so "/y" works too — some users do that on Telegram.
  const stripped = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  if (ALLOW_ALL_TOKENS.has(stripped)) {
    return { behavior: 'allow', autoAllowFurther: true }
  }
  if (ALLOW_TOKENS.has(stripped)) {
    return { behavior: 'allow' }
  }
  if (DENY_TOKENS.has(stripped)) {
    return { behavior: 'deny', message: '用户在 IM 中拒绝了这次工具调用' }
  }
  return null
}

/**
 * Compact JSON serialize with truncation. Used by the rich-card path (which
 * has its own UI rendering) — for plain-text we use formatInputBody below.
 */
function safeStringify(v: unknown, maxLen: number): string {
  let s: string
  try { s = JSON.stringify(v) } catch { s = String(v) }
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`
  return s
}

/**
 * Strip MCP-style prefix from a tool name for display. `mcp__agim__create_reminder`
 * → `agim: create_reminder` (the user cares about the namespace, not the
 * triple-underscore wire format).
 */
function displayToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  if (m) return `${m[1]}: ${m[2]}`
  return name
}

/** Human-readable byte count, no decimals for B, one for KB/MB. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** Pull a string field iff present and (optionally) short enough to inline
 *  next to the tool name in the header row. Returns null when the field is
 *  missing, non-string, multi-line, or longer than `max`. */
function inlineableField(v: unknown, max = 60): string | null {
  if (typeof v !== 'string') return null
  if (v.length > max || v.includes('\n')) return null
  return v
}

/** Header-row "primary parameter" for common tools — file_path, URL, short
 *  pattern, or short Bash command. Returns null when the primary field is
 *  too long for the header; in that case the body block renders it as a
 *  separate labelled line. */
function primaryInlineParam(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Read': case 'NotebookRead': case 'Edit': case 'Write':
    case 'NotebookEdit': case 'LS':
      return inlineableField(input.file_path) ?? inlineableField(input.path)
    case 'Glob': case 'Grep':
      return inlineableField(input.pattern)
    case 'WebFetch':
      return inlineableField(input.url, 80)
    case 'WebSearch':
      return inlineableField(input.query, 80)
    case 'Bash':
      return inlineableField(input.command, 80)
  }
  return null
}

/**
 * Render input fields as body lines that go between the header and the
 * action row. Empty array = nothing to add (primary param already lives in
 * the header). For big text fields (Write.content, Edit.new_string, long
 * Bash commands) prepend a "(N 行·X KB)" hint so the user knows what
 * they're approving even when the preview is truncated.
 *
 * The goal is "user can decide y/n in 1 second" — short tools collapse to
 * a 3-line message; only big fields get an expanded indented block.
 */
function formatInputBody(toolName: string, input: Record<string, unknown>, maxLen: number): string[] {
  const lines: string[] = []
  const get = (k: string): string | null => typeof input[k] === 'string' ? (input[k] as string) : null

  /** Render a big text field. Inline when it fits on one line; expand with
   *  size hint + 2-space indent when multi-line or long enough to deserve it. */
  const big = (label: string, val: string): void => {
    const truncated = val.length > maxLen ? `${val.slice(0, maxLen - 1)}…` : val
    const cnt = val.split('\n').length
    const hint = (cnt > 1 || val.length > 100)
      ? ` (${cnt} 行·${formatBytes(Buffer.byteLength(val, 'utf-8'))})`
      : ''
    if (truncated.includes('\n')) {
      lines.push(`${label}${hint}：`)
      for (const ln of truncated.split('\n')) lines.push(`  ${ln}`)
    } else {
      lines.push(`${label}${hint}：${truncated}`)
    }
  }

  switch (toolName) {
    case 'Bash': {
      const cmd = get('command')
      if (cmd && (cmd.length > 80 || cmd.includes('\n'))) big('命令', cmd)
      return lines
    }
    case 'Read': case 'NotebookRead': case 'LS': {
      const fp = get('file_path') ?? get('path')
      if (fp && (fp.length > 60 || fp.includes('\n'))) {
        lines.push(`路径：${fp.length > maxLen ? `${fp.slice(0, maxLen - 1)}…` : fp}`)
      }
      return lines
    }
    case 'Edit': case 'Write': case 'NotebookEdit': {
      const fp = get('file_path')
      const content = get('content') ?? get('new_string') ?? get('new_source')
      if (fp && (fp.length > 60 || fp.includes('\n'))) {
        lines.push(`路径：${fp.length > maxLen ? `${fp.slice(0, maxLen - 1)}…` : fp}`)
      }
      if (content) big(toolName === 'Edit' ? '新内容' : '内容', content)
      return lines
    }
    case 'Glob': case 'Grep': {
      const pat = get('pattern')
      if (pat && (pat.length > 60 || pat.includes('\n'))) big('Pattern', pat)
      const path = get('path')
      if (path) lines.push(`位置：${path}`)
      const glob = get('glob') ?? get('output_mode')
      if (glob) lines.push(`Glob：${glob}`)
      return lines
    }
    case 'WebFetch': {
      // Show the URL inline only when it fits the header; long URLs need
      // their own line so the user can see what they're approving. A 250-char
      // OAuth callback URL with no body would otherwise be approved blind.
      const url = get('url')
      if (url && (url.length > 80 || url.includes('\n'))) {
        lines.push(`URL：${url.length > maxLen ? `${url.slice(0, maxLen - 1)}…` : url}`)
      }
      return lines
    }
    case 'WebSearch': {
      const query = get('query')
      if (query && (query.length > 80 || query.includes('\n'))) {
        lines.push(`查询：${query.length > maxLen ? `${query.slice(0, maxLen - 1)}…` : query}`)
      }
      return lines
    }
  }

  // Unknown tool — compact JSON dump, indented when multi-line.
  let s: string
  try {
    const pretty = JSON.stringify(input, null, 2)
    s = pretty.length <= maxLen ? pretty : JSON.stringify(input)
  } catch { s = String(input) }
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`
  if (s.includes('\n')) {
    lines.push('入参：')
    for (const ln of s.split('\n')) lines.push(`  ${ln}`)
  } else {
    lines.push(`入参：${s}`)
  }
  return lines
}

/**
 * Render an approval request as a plain text message. We keep this format
 * stable across IM platforms; richer flows (Feishu cards with buttons) can
 * layer on later by checking platform/sendCard.
 *
 * Two flavors:
 *   - Normal: y/n/all action box with timeout footer
 *   - Auto-allow grace mode (n.autoAllow set): "⏱ 自动放行中…" with deny option
 */
export function formatApprovalPrompt(n: ApprovalNotification): string {
  const tool = displayToolName(n.toolName)
  const primary = primaryInlineParam(n.toolName, n.input)
  const body = formatInputBody(n.toolName, n.input, MAX_INPUT_PREVIEW)
  const reqShort = n.reqId.slice(0, 8)

  if (n.autoAllow) {
    const sec = Math.round(n.autoAllow.graceMs / 1000)
    const header = primary ? `⏱ 自动放行 · ${tool} · ${primary}` : `⏱ 自动放行 · ${tool}`
    return [header, ...body, `${sec}s 后执行 · 回 n 拒绝并撤销规则 · req ${reqShort}`].join('\n')
  }

  const mins = Math.max(1, Math.round(approvalBus.approvalTimeoutMs / 60000))
  if (n.requiresExplicitDecision) {
    const header = primary ? `🔐 必须确认 · ${tool} · ${primary}` : `🔐 必须确认 · ${tool}`
    return [
      header,
      ...body,
      'y 批准一次 · n 拒绝',
      `${mins}min 未回 → 拒绝 · req ${reqShort}`,
    ].join('\n')
  }
  const fallback = isTimeoutDefaultAllow() ? '放行' : '拒绝'
  const header = primary ? `🔐 审批 · ${tool} · ${primary}` : `🔐 审批 · ${tool}`
  return [
    header,
    ...body,
    `y 批准 · n 拒绝 · all 同类放行`,
    `${mins}min 未回 → ${fallback} · req ${reqShort}`,
  ].join('\n')
}

/**
 * Map an IM platform name to its messenger registration. WeChat is special-
 * cased because the messenger is registered as "wechat-ilink" but messages
 * carry platform="wechat".
 */
export function platformToMessengerName(platform: string): string {
  return platform === 'wechat' ? 'wechat-ilink' : platform
}

export interface InstallOptions {
  resolveMessenger: (platform: string) => MessengerAdapter | undefined
  /** Optional. Platform names whose messengers should have button-callback
   *  support bound at install time. Adapters that don't implement
   *  onButtonCallback are silently skipped. Defaults to all known IM
   *  platforms; existing tests / callers don't need to pass this. */
  buttonCallbackPlatforms?: string[]
}

let installed: InstallOptions | null = null

/** Per-reqId card tracking. Populated when sendApprovalCard succeeds; cleared
 *  when the card is edited to its terminal state (via button click or text
 *  reply that triggers editCardOnThreadResolution). Survives only in memory —
 *  bus restart wipes pendings anyway. */
interface ActiveCard {
  platform: string
  threadId: string
  messageId: string
}
const activeCards = new Map<string, ActiveCard>()

/**
 * Wire approval-bus.notifier to the messenger layer. Idempotent: calling
 * install() twice replaces the previous wiring.
 *
 * Notifier prefers the rich-card path (sendApprovalCard) when the resolved
 * adapter implements it; otherwise it falls back to the plain-text path
 * (sendMessage with formatApprovalPrompt). The text path is the canonical
 * approval channel for adapters without native interactive buttons (Feishu
 * cards aren't wired for buttons yet, WeChat iLink can't render them).
 *
 * Button callbacks: for each platform listed in buttonCallbackPlatforms
 * whose adapter implements onButtonCallback, we subscribe a handler that
 * parses callback_data of the form `apv:<reqId>:<y|n|a>` and resolves the
 * matching pending. Subscribing happens once at install — adapters started
 * later won't receive button wiring until install() is called again.
 */
export function install(opts: InstallOptions): void {
  installed = opts
  approvalBus.setNotifier(async (n: ApprovalNotification) => {
    // Self-protect: an LLM tried to kill/restart Agim itself. Deny with
    // a friendly redirect to /restart before bothering the user with a
    // y/n card. See core/self-protect.ts for the pattern list and why.
    const selfProtect = checkToolUse(n.toolName, n.input)
    if (selfProtect) {
      log.warn({
        event: 'approval.router.self_protect_block',
        reqId: n.reqId,
        toolName: n.toolName,
        platform: n.ctx.platform,
        threadId: n.ctx.threadId,
      }, 'blocked self-targeted tool call; LLM will receive the redirect message')
      throw new Error(selfProtect.message)
    }

    const m = opts.resolveMessenger(n.ctx.platform)
    if (!m) {
      log.warn({ event: 'approval.router.no_messenger', platform: n.ctx.platform, reqId: n.reqId },
        'No messenger registered for platform; approval cannot be surfaced')
      // Throwing tells the bus to auto-deny this request.
      throw new Error(`no messenger for platform ${n.ctx.platform}`)
    }

    // Rich-card path (Telegram inline keyboard). Retry once with a short
    // delay before falling back to plain text — the common failure mode is
    // "Telegram adapter not started" during a bot reconnect (bot=null inside
    // sendApprovalCard) or a transient 429, both of which clear in well
    // under a second. Without the retry, the user gets a plain-text card
    // every time the bot blips, even though the next attempt would've
    // succeeded.
    if (m.sendApprovalCard) {
      const prompt: ApprovalCardPrompt = {
        reqId: n.reqId,
        toolName: n.toolName,
        inputJson: safeStringify(n.input, MAX_INPUT_PREVIEW_CARD),
        mode: n.autoAllow ? 'auto-allow' : n.requiresExplicitDecision ? 'explicit' : 'normal',
        graceSeconds: n.autoAllow ? Math.round(n.autoAllow.graceMs / 1000) : undefined,
      }
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { messageId } = await m.sendApprovalCard(n.ctx.threadId, prompt)
          activeCards.set(n.reqId, {
            platform: n.ctx.platform,
            threadId: n.ctx.threadId,
            messageId,
          })
          log.info({
            event: 'approval.router.card_sent',
            platform: n.ctx.platform,
            threadId: n.ctx.threadId,
            reqId: n.reqId,
            messageId,
            attempt,
          })
          return
        } catch (err) {
          lastErr = err
          if (attempt === 0) {
            log.warn({
              event: 'approval.router.card_retry',
              err: String(err),
              reqId: n.reqId,
              platform: n.ctx.platform,
            }, 'sendApprovalCard threw; retrying once in 200ms')
            await new Promise<void>((resolve) => setTimeout(resolve, 200))
          }
        }
      }
      log.warn({
        event: 'approval.router.card_failed_fallback',
        err: String(lastErr),
        reqId: n.reqId,
        platform: n.ctx.platform,
      }, 'sendApprovalCard threw twice; falling back to text path')
      // Fall through to text path
    }

    // Text path (Feishu / WeChat / any adapter without sendApprovalCard).
    // priority='high' so sink tries a sync send first; falls back to the
    // outbox queue on failure (e.g. IM platform glitch). Approval prompts
    // are time-sensitive — the user expects them to feel synchronous.
    // We pass `adapter: m` so sink uses the already-resolved messenger
    // (respects install({ resolveMessenger })'s injection hook used by
    // tests + multi-tenant setups) instead of re-resolving via registry.
    const text = formatApprovalPrompt(n)
    await sink.deliver({
      platform: n.ctx.platform,
      channelId: n.ctx.channelId,
      threadId: n.ctx.threadId,
      payload: text,
      kind: 'text',
      priority: 'high',
      adapter: m,
    })
    log.info({ event: 'approval.router.prompt_sent', platform: n.ctx.platform, threadId: n.ctx.threadId, reqId: n.reqId })
  })

  const platforms = opts.buttonCallbackPlatforms ?? ['telegram', 'feishu', 'wechat', 'discord', 'web']
  for (const platform of platforms) {
    bindButtonHandlerForPlatform(platform)
  }

  // Listen for non-user resolutions (timeout, sidecar disconnect, run
  // terminated, shutdown, notifier error) so we can collapse the card to
  // a terminal "已过期" state. The user-driven path (button click / y-n
  // text reply) edits the card itself BEFORE the listener fires — by that
  // time activeCards has already been pruned, so this listener no-ops on
  // cause='user'. Defensive double-check via cause makes intent explicit.
  approvalBus.setResolutionListener((e) => onBusResolution(e))
}

export function uninstall(): void {
  installed = null
  approvalBus.setNotifier(null)
  approvalBus.setResolutionListener(null)
  activeCards.clear()
  // Note: we don't unsubscribe button handlers from messengers — tests that
  // re-install will overwrite via onButtonCallback's "replace previous"
  // contract. Production never uninstalls.
}

/**
 * Bind the inline-button handler for a single platform's messenger. The
 * install() loop calls this for every default platform at boot; callers
 * (e.g. web/server.ts) that register their messenger AFTER install have
 * to call this themselves to get button-click → resolvePending wiring.
 *
 * Idempotent at the messenger level — onButtonCallback's contract is
 * "replace previous handler", so re-calling this on the same platform
 * just rewires.
 *
 * Silent no-op when the messenger isn't registered yet, has no
 * onButtonCallback, or the router hasn't been install()'d.
 */
export function bindButtonHandlerForPlatform(platform: string): void {
  if (!installed) return
  const m = installed.resolveMessenger(platform)
  if (!m?.onButtonCallback) return
  m.onButtonCallback(async (cb) => handleButtonCallback(platform, cb))
  log.info({ event: 'approval.router.button_handler_bound', platform })
}

/**
 * Bus-side resolution listener. Fires for every transition pending → resolved
 * regardless of cause. We only act on non-user causes here: those are the
 * cases where no IM-side handler updated the card, so without us the user
 * sees a card with stale buttons.
 *
 * For auto-allow grace expiry that resolves to allow, we still mark the card
 * as 'allowed' (without byUserDisplay) — the call did go through, just
 * silently. For all other non-user causes (timeout deny, disconnect, run
 * terminated, shutdown, notifier error), the card collapses to 'expired'.
 */
function onBusResolution(e: ResolutionEvent): void {
  if (e.cause === 'user') return  // button/text path already edited
  const card = activeCards.get(e.reqId)
  if (!card) return  // text-fallback path doesn't track cards
  activeCards.delete(e.reqId)
  if (!installed) return
  const m = installed.resolveMessenger(card.platform)
  if (!m?.editApprovalCard) return

  let decision: import('./types.js').ApprovalCardOutcome['decision']
  if (e.cause === 'timeout' && e.decision.behavior === 'allow') {
    // auto-allow grace fired silently
    decision = 'allowed'
  } else {
    decision = 'expired'
  }
  m.editApprovalCard(card.threadId, card.messageId, {
    decision,
    atDate: new Date(),
  }).catch((err) => {
    log.warn({ event: 'approval.router.bus_edit_failed', reqId: e.reqId, err: String(err) })
  })
}

/**
 * Called by cli's onMessage handler before it routes to the agent.
 * Returns true when this message was an approval reply (so the caller should
 * stop and not invoke the normal router).
 *
 * Behavior:
 *   - If thread has no pending approval → return false, do nothing
 *   - If thread has pending AND text parses as decision → resolve, return true
 *   - If thread has pending AND text does NOT parse → auto-deny pending
 *     (user is moving on), return false so the message routes normally
 *
 * Receipt: when the resolution adds or revokes an auto-allow rule, also
 * sends a one-line confirmation back to the IM thread so the user knows
 * the rule landed (or got cleared). Best-effort: a missing messenger or
 * sendMessage failure is logged and ignored — the approval itself already
 * resolved successfully.
 */
/**
 * Called by cli's onMessage handler before it routes to the agent.
 * `key` must be a composite key from `threadKey(platform, channelId, threadId)`
 * — same value the bus stored under at registerRun/registerSyntheticPending
 * time. A bare threadId will miss in multi-platform deployments.
 */
export function tryHandleApprovalReply(key: string, text: string): boolean {
  if (!approvalBus.hasPendingFor(key)) return false
  const decision = parseApprovalReply(text)
  if (decision) {
    const info = approvalBus.resolvePending(key, decision)
    log.info({ event: 'approval.router.resolved', key, behavior: decision.behavior })
    // R12 ⑤ — persistent audit. ResolvedInfo has platform + threadId +
    // toolName but no user_id (the IM reply identifies a thread, not a
    // person directly); we record thread granularity which is enough to
    // correlate "this thread approved this tool at this time" with the
    // IM platform's own conversation logs for the human-level lookup.
    if (info) {
      void (async () => {
        try {
          const { logAuditEvent } = await import('./audit-log.js')
          logAuditEvent({
            eventType: decision.behavior === 'allow' ? 'approval.allow' : 'approval.deny',
            actor: `${info.platform}:${info.threadId}`,
            target: info.toolName,
            outcome: decision.behavior === 'allow' ? 'ok' : 'denied',
            details: { reqId: info.reqId, wasAutoAllow: info.wasAutoAllow },
          })
        } catch { /* best-effort */ }
      })()
      editCardOnThreadResolution(info, decision, undefined)
      sendReceiptIfAny(info, decision)
    }
    return true
  }
  const redirectDecision: Decision = {
    behavior: 'deny',
    message: '用户在 IM 中改换话题，未给出审批回复',
  }
  const info = approvalBus.resolvePending(key, redirectDecision)
  if (info) editCardOnThreadResolution(info, redirectDecision, undefined)
  log.info({ event: 'approval.router.redirected', key })
  return false
}

/**
 * Inline-button handler. callback_data format: `apv:<reqId>:<y|n|a>`.
 * Resolves the matching pending via approvalBus.resolvePending, acks the
 * button (must happen within ~1s on Telegram), edits the card to its
 * terminal state, and sends the same auto-allow receipt the text path
 * would send.
 *
 * Late clicks (already resolved or expired): we ack with a soft hint and
 * try to edit the card to the "expired" state so subsequent users see a
 * clean terminal view.
 */
async function handleButtonCallback(platform: string, cb: ButtonCallback): Promise<void> {
  // v1.2 — dispatch by callback_data prefix. job-recovery owns `rec:`.
  // Adding a new prefix? Add a guard here + import the matching handler.
  try {
    const { isRecoveryButtonData, handleRecoveryButton } = await import('./job-recovery.js')
    if (isRecoveryButtonData(cb.data)) {
      await handleRecoveryButton(platform, cb)
      return
    }
  } catch (err) {
    log.warn({ event: 'approval.router.recovery_dispatch_failed', err: String(err) })
  }

  // ask_user choice cards share the same messenger callback channel as
  // approvals (this router is the de-facto unified dispatcher — ask-user-
  // router.install() is never wired). Delegate the full `ask:` handling
  // (single / multi toggle+submit / custom) to ask-user-router, passing our
  // injected resolveMessenger so it can re-render / strip the card.
  if (cb.data?.startsWith('ask:')) {
    try {
      const { handleAskButtonClick } = await import('./ask-user-router.js')
      const resolveMessenger = installed?.resolveMessenger ?? (() => undefined)
      await handleAskButtonClick(platform, cb, resolveMessenger)
    } catch (err) {
      log.warn({ event: 'approval.router.ask_button_failed', err: String(err) })
      try { await cb.ack('处理失败') } catch { /* best-effort */ }
    }
    return
  }

  const parsed = parseCallbackData(cb.data)
  if (!parsed) {
    await cb.ack('未识别的按钮')
    return
  }
  const decision = decisionFromButton(parsed.choice)
  const info = approvalBus.resolvePendingByReqId(parsed.reqId, decision)

  if (!info) {
    await cb.ack('请求已过期或已被处理')
    // v1.2.113 — ALWAYS fire editApprovalCard for the click's own card,
    // not just when activeCards has the reqId. Two real-world paths hit
    // this branch with activeCards empty:
    //   (a) bus auto-resolved (timeout / grace expired) → onBusResolution
    //       ran editApprovalCard AND cleared activeCards. If the WS was
    //       disconnected at that moment the edit was silently dropped
    //       (`if (!ws.OPEN) return`, no retry) — user's card stays in
    //       its pending state until they click, and previously a click
    //       in this state did NOTHING because the `activeCards.has`
    //       gate was false. The fix: fire `editApprovalCard` here so
    //       the user gets visible feedback ('已过期').
    //   (b) agim restarted while a browser tab had an open approval
    //       card. The new process's pendingById is empty, activeCards
    //       is empty — same dead-end as (a).
    // Trade-off: in the rare race where auto-allow grace fired ms ago
    // and the user clicks "approve" right after, we'll briefly flip
    // an "allowed" card to "expired". Visible flip ≪ stuck forever.
    if (installed) {
      const m = installed.resolveMessenger(platform)
      if (m?.editApprovalCard) {
        log.info({
          event: 'approval.router.orphan_click_expired',
          platform, reqId: parsed.reqId, messageId: cb.messageId,
        }, 'orphan click — bus had no pending; firing edit→expired so UI unsticks')
        await m.editApprovalCard(cb.threadId, cb.messageId, {
          decision: 'expired',
          atDate: new Date(),
        }).catch((err) => {
          log.warn({ event: 'approval.router.expire_edit_failed', err: String(err) })
        })
      }
    }
    activeCards.delete(parsed.reqId)
    return
  }

  const ackText = decision.behavior === 'allow'
    ? (decision.autoAllowFurther ? '🛡 已批准并自动放行' : '✅ 已批准')
    : (info.wasAutoAllow ? '❌ 已拒绝并撤销规则' : '❌ 已拒绝')
  await cb.ack(ackText)

  if (installed) {
    const m = installed.resolveMessenger(info.platform)
    if (m?.editApprovalCard) {
      const outcome: ApprovalCardOutcome = {
        decision: outcomeFromDecision(decision, info.wasAutoAllow),
        byUserDisplay: cb.userDisplay,
        atDate: new Date(),
      }
      await m.editApprovalCard(cb.threadId, cb.messageId, outcome).catch((err) => {
        log.warn({ event: 'approval.router.edit_failed', err: String(err) })
      })
    }
  }
  activeCards.delete(parsed.reqId)

  log.info({
    event: 'approval.router.button_resolved',
    platform,
    threadId: cb.threadId,
    behavior: decision.behavior,
    autoAllowFurther: decision.behavior === 'allow' && decision.autoAllowFurther === true,
  })

  sendReceiptIfAny(info, decision)
}

/** Find the active card matching the resolved reqId and edit it to its
 *  terminal state. Keyed strictly by reqId — both the text y/n path and the
 *  button-callback path now resolve via reqId, so a thread-scan fallback is
 *  unnecessary. No-op when no card was registered (other IMs / fallback). */
function editCardOnThreadResolution(
  info: ResolvedInfo,
  decision: Decision,
  byUserDisplay: string | undefined,
): void {
  if (!installed) return
  const card = activeCards.get(info.reqId)
  if (!card) return
  activeCards.delete(info.reqId)
  const m = installed.resolveMessenger(info.platform)
  if (!m?.editApprovalCard) return
  const outcome: ApprovalCardOutcome = {
    decision: outcomeFromDecision(decision, info.wasAutoAllow),
    byUserDisplay,
    atDate: new Date(),
  }
  m.editApprovalCard(card.threadId, card.messageId, outcome).catch((err) => {
    log.warn({ event: 'approval.router.edit_failed', err: String(err) })
  })
}

function outcomeFromDecision(d: Decision, wasAutoAllow: boolean): ApprovalCardOutcome['decision'] {
  if (d.behavior === 'allow') {
    return d.autoAllowFurther ? 'allowed-pinned' : 'allowed'
  }
  return wasAutoAllow ? 'denied-revoked' : 'denied'
}

/**
 * Parse callback_data of the form `apv:<reqId>:<y|n|a>`. reqId may itself
 * contain characters but never `:` in practice (UUID / opaque sidecar id);
 * we still split on the LAST colon to be safe, leaving the choice as the
 * single trailing letter.
 */
export function parseCallbackData(data: string): { reqId: string; choice: 'y' | 'n' | 'a' } | null {
  if (!data.startsWith('apv:')) return null
  const rest = data.slice(4)
  const lastColon = rest.lastIndexOf(':')
  if (lastColon <= 0) return null
  const reqId = rest.slice(0, lastColon)
  const choice = rest.slice(lastColon + 1)
  if (choice !== 'y' && choice !== 'n' && choice !== 'a') return null
  if (!reqId) return null
  return { reqId, choice }
}

function decisionFromButton(choice: 'y' | 'n' | 'a'): Decision {
  if (choice === 'y') return { behavior: 'allow' }
  if (choice === 'a') return { behavior: 'allow', autoAllowFurther: true }
  return { behavior: 'deny', message: '用户在 IM 中拒绝了这次工具调用（按钮）' }
}

/**
 * If the user just enabled an auto-allow rule (allow + autoAllowFurther) or
 * just revoked one (deny while in grace mode), push a short confirmation
 * line to the originating thread.
 */
function sendReceiptIfAny(info: ResolvedInfo, decision: Decision): void {
  if (!installed) return
  let msg: string | null = null
  if (decision.behavior === 'allow' && decision.autoAllowFurther) {
    msg = [
      '✅ 已批准并启用自动放行',
      `规则：${info.toolName} · ${humanizeFingerprint(info.fingerprint)} — 5s 内自动放行`,
      '撤销：本会话回 n 单条 / /approval clear 清空',
    ].join('\n')
  } else if (decision.behavior === 'deny' && info.wasAutoAllow) {
    msg = `❌ 已拒绝并撤销自动放行规则：${info.toolName} · ${humanizeFingerprint(info.fingerprint)}`
  }
  if (!msg) return
  const m = installed.resolveMessenger(info.platform)
  if (!m) {
    log.warn({ event: 'approval.router.receipt_no_messenger', platform: info.platform })
    return
  }
  // priority='high' to match the approval prompt itself: receipt should
  // arrive immediately on the happy path. channelId is not part of
  // ResolvedInfo today (only RunContext carries it) so we pass '' — that
  // affects the outbox row's thread_key composite but not delivery routing.
  // adapter: m bypasses sink's global-registry resolve, respecting
  // install({ resolveMessenger })'s test-friendly indirection.
  sink.deliver({
    platform: info.platform,
    channelId: '',
    threadId: info.threadId,
    payload: msg,
    kind: 'text',
    priority: 'high',
    adapter: m,
  }).catch((err) => {
    log.warn({ event: 'approval.router.receipt_failed', err: String(err) })
  })
}

/** Test helper — not exported from index. */
export function _isInstalled(): boolean { return installed !== null }
