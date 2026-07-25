// ask-user-rpc — agent-facing "ask the user a question, wait for the
// answer, return it" primitive (P0 #5).
//
// Why we need this: agim already has Y/N approval (heavy-weight
// approval-bus + sidecar) and free-form chat (the regular agent reply
// stream). What was missing: a structured way for the agent to ask the
// user a clarifying question with N choices ("user said '张三'; did
// they mean 张三 A or 张三 B?") and reliably get the answer back without
// the user accidentally treating the message as a new request.
//
// Wire flow:
//
//   agent (via MCP tool mcp__agim__ask_user)
//      ↓
//   sidecar -> approval-bus  {v:1, type:'ask', runId, reqId, payload:{question, choices, timeoutSec?}}
//      ↓
//   approval-bus.handleAsk -> handleAskOp(payload, runContext)
//      ↓
//   ask-user-rpc:
//      1. validate input + caller context
//      2. register a pending entry keyed by reqId in PENDING map
//      3. compose a ChoiceCardPrompt + send via the resolved messenger
//         (sendChoiceCard if available, sendMessage text fallback)
//      4. arm timeoutSec timer (default 5 min)
//      5. AWAIT the Promise — resolved by either:
//           * onButtonReply  (from messenger.onButtonCallback)
//           * onTextReply    (from router intercept)
//           * timeout
//      6. return { choice: 'a' | 'b' | ... , raw: '<user-typed text or button data>' }
//
// Router intercept (the consumer side):
//   When a fresh inbound IM message arrives, router calls
//   tryResolvePendingAsk(thread). If a pending ask exists AND the text
//   matches one of the choice tokens (1 / a / "first" / "通过" / …),
//   we resolve the Promise and tell router "consumed, skip normal
//   routing". Non-matching text passes through normally — the user
//   changed topic.

import { randomUUID } from 'node:crypto'
import type { ChoiceCardPrompt } from './types.js'
import type { RunContext } from './approval-bus.js'
import { logger as rootLogger } from './logger.js'
import { sink, resolveMessenger } from './message-sink.js'

const log = rootLogger.child({ component: 'ask-user-rpc' })

/** Hard caps on user-facing prompt + choice count + per-choice label. */
export const MAX_QUESTION_CHARS = 1_000
export const MAX_CHOICE_LABEL_CHARS = 80
export const MIN_CHOICES = 2
export const MAX_CHOICES = 9   // 1..9 keypad-friendly; cards have layout limits

/** Default timeout. Generous because the user might be reading a long
 *  question or comparing options; agents asking yes/no can pass a shorter
 *  timeoutSec. 15 min matches the native tool schema default. */
const DEFAULT_TIMEOUT_SEC = 900  // 15 min
const MIN_TIMEOUT_SEC = 5
const MAX_TIMEOUT_SEC = 60 * 30  // 30 min

/** Reserved button-data prefix — short to fit Telegram's 64-byte cap. */
const BTN_PREFIX = 'ask:'
const DEFAULT_CUSTOM_INPUT_LABEL = '其他（自定义输入）'

export interface AskPayload {
  question?: unknown
  choices?: unknown    // string[]; index encoded as key in the result
  timeoutSec?: unknown
  /** Selection mode. single=pick one; multi=pick N items at once. */
  selectionMode?: unknown
  /** Multi-select lower bound (only used when selectionMode=multi). */
  minSelections?: unknown
  /** Multi-select upper bound (only used when selectionMode=multi). */
  maxSelections?: unknown
  /** Allow free-form text as an alternative answer path. */
  allowCustomInput?: unknown
  /** Label for the custom-input pseudo option (TUI only). */
  customInputLabel?: unknown
  /** When true (default), text replies like "1" / "a" / the choice
   *  label substring match the corresponding option. Disable for
   *  strict button-only flows (the user must click a button or wait
   *  for the timeout). */
  allowTextReply?: unknown
  /** Optional http(s) URL surfaced as a "查看详情" entry on the card, for
   *  context the decision depends on (e.g. a viewer/paste link, a PR). */
  detailsUrl?: unknown
  /** Optional label for the details link (default "📖 查看详情"). */
  detailsLabel?: unknown
}

export interface AskChoice {
  /** 1-indexed for human readability (1 / 2 / 3 …) */
  index: number
  /** Display label as shown to the user. */
  label: string
}

export type AskSelectionMode = 'single' | 'multi'

interface AskSuccessResult {
  /** 1-indexed primary choice. For multi-select this is the first pick. */
  index: number
  /** Primary label. For multi-select this is the first pick label. */
  label: string
  /** How the answer reached agim. */
  via: 'button' | 'text'
  /** Raw user-typed text or callback payload. */
  raw: string
  /** Chosen selection mode. */
  selectionMode: AskSelectionMode
  /** Present for multi-select answers. */
  indexes?: number[]
  /** Present for multi-select answers. */
  labels?: string[]
  /** Present when the user gave free-form custom input. */
  customText?: string
}

export type AskResult =
  | {
      ok: true
      result: AskSuccessResult
    }
  | { ok: false; error: string; reason?: 'timeout' | 'cancelled' | 'invalid' | 'no-messenger' }

/** A pending ask waiting on user input. The router consults the PENDING
 *  map; the bus consults it via the resolver returned from registerAsk. */
interface PendingAsk {
  reqId: string
  platform: string
  channelId: string
  threadId: string
  userId: string
  question: string
  choices: AskChoice[]
  selectionMode: AskSelectionMode
  minSelections: number
  maxSelections: number
  allowCustomInput: boolean
  customInputLabel: string
  allowTextReply: boolean
  timeoutSec: number
  /** Optional details link surfaced on the card. */
  detailsUrl?: string
  detailsLabel?: string
  /** Server-side multi-select accumulator (1-based indexes). Used when the
   *  card is stateful (Telegram toggle keyboard); each toggle tap mutates
   *  this without resolving, and a "submit" tap resolves with its contents. */
  selected: Set<number>
  /** Set when the user taps the "custom input" button: the next text reply
   *  is then taken verbatim as the answer (no choice matching). */
  awaitingCustomText: boolean
  /** Messenger message id of the sent card, for in-place edits (toggle
   *  re-render, terminal strip, timeout cleanup). Set after sendChoiceCard. */
  cardMessageId?: string
  resolve: (r: AskResult) => void
  /** Timeout handle so we can clear it on early resolution. */
  timer: NodeJS.Timeout | null
  createdAt: number
}

const PENDING: Map<string, PendingAsk> = new Map()

function threadKey(platform: string, channelId: string, threadId: string): string {
  return `${platform}::${channelId}::${threadId}`
}

/** All pending entries keyed by (platform, channelId, threadId) for
 *  fast router-side lookup. Most threads have 0 or 1 pending asks; we
 *  use the same lookup for both cases. */
const PENDING_BY_THREAD: Map<string, Set<string>> = new Map()

function addToThreadIndex(p: PendingAsk): void {
  const key = threadKey(p.platform, p.channelId, p.threadId)
  let set = PENDING_BY_THREAD.get(key)
  if (!set) { set = new Set(); PENDING_BY_THREAD.set(key, set) }
  set.add(p.reqId)
}

function removeFromThreadIndex(p: PendingAsk): void {
  const key = threadKey(p.platform, p.channelId, p.threadId)
  const set = PENDING_BY_THREAD.get(key)
  if (!set) return
  set.delete(p.reqId)
  if (set.size === 0) PENDING_BY_THREAD.delete(key)
}

// ─── public API ──────────────────────────────────────────────────────

/**
 * Handle one `ask_user` RPC. Returns the AskResult to be wired back to
 * the sidecar. ALL exceptions caught + converted; the bus never sees
 * a thrown error from here.
 */
export async function handleAskOp(payload: AskPayload, ctx: RunContext): Promise<AskResult> {
  const question = typeof payload.question === 'string' ? payload.question.trim() : ''
  if (!question) return { ok: false, error: 'question is required (non-empty string)', reason: 'invalid' }
  if (question.length > MAX_QUESTION_CHARS) {
    return { ok: false, error: `question too long (max ${MAX_QUESTION_CHARS} chars)`, reason: 'invalid' }
  }
  const choices = normalizeChoices(payload.choices)
  if (!choices) {
    return {
      ok: false,
      error: `choices must be an array of ${MIN_CHOICES}–${MAX_CHOICES} strings (each ≤ ${MAX_CHOICE_LABEL_CHARS} chars)`,
      reason: 'invalid',
    }
  }
  const selectionMode = normalizeSelectionMode(payload.selectionMode)
  if (!selectionMode) {
    return { ok: false, error: 'selectionMode must be "single" or "multi"', reason: 'invalid' }
  }
  const minSelections = selectionMode === 'multi'
    ? normalizeSelectionBound(payload.minSelections, 1)
    : 1
  const maxSelections = selectionMode === 'multi'
    ? normalizeSelectionBound(payload.maxSelections, choices.length)
    : 1
  if (selectionMode === 'multi' && (minSelections > maxSelections || maxSelections > choices.length)) {
    return {
      ok: false,
      error: `invalid selection bounds: minSelections=${minSelections}, maxSelections=${maxSelections}, choices=${choices.length}`,
      reason: 'invalid',
    }
  }
  const allowCustomInput = payload.allowCustomInput === true
  const customInputLabel = normalizeCustomInputLabel(payload.customInputLabel)
  const timeoutSec = clampTimeout(payload.timeoutSec)
  const allowTextReply = payload.allowTextReply !== false  // default true
  const detailsUrl = normalizeDetailsUrl(payload.detailsUrl)
  const detailsLabel = typeof payload.detailsLabel === 'string' && payload.detailsLabel.trim()
    ? payload.detailsLabel.trim().slice(0, MAX_CHOICE_LABEL_CHARS)
    : undefined

  // Resolve the messenger for the IM thread. If the platform isn't
  // registered (rare — usually means a misconfigured ACP caller), fall
  // through to text-only via sink, which will queue and eventually fail
  // delivery with a clear error. We refuse the ask in that case so the
  // agent doesn't sit on a Promise that can never resolve.
  const messenger = resolveMessenger(ctx.platform)
  if (!messenger) {
    return {
      ok: false,
      error: `messenger "${ctx.platform}" not registered (cannot deliver the question)`,
      reason: 'no-messenger',
    }
  }
  // Who can host a full-featured card (multi-select + custom input)?
  //  - tui / web render the interaction client-side.
  //  - adapters implementing updateChoiceCard (Telegram) render a stateful
  //    server-side toggle keyboard.
  // Everything else only gets a card for the simple single-select case and
  // falls back to the text-reply path for richer modes.
  const serverSideToggle = Boolean(messenger.updateChoiceCard)
  const canSendChoiceCard = Boolean(
    messenger.sendChoiceCard
    && (ctx.platform === 'tui'
      || ctx.platform === 'web'
      || serverSideToggle
      || (selectionMode === 'single' && !allowCustomInput)),
  )
  if (!allowTextReply && !canSendChoiceCard) {
    return {
      ok: false,
      error: 'allowTextReply=false requires a card-capable messenger for this ask mode',
      reason: 'invalid',
    }
  }

  // Build the pending entry FIRST so onMessage callbacks can find it
  // even before sink finishes its delivery (rare race; cheap insurance).
  const reqId = randomUUID()
  const pending: PendingAsk = {
    reqId,
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    userId: ctx.userId || '',
    question,
    choices,
    selectionMode,
    minSelections,
    maxSelections,
    allowCustomInput,
    customInputLabel,
    allowTextReply,
    timeoutSec,
    detailsUrl,
    detailsLabel,
    selected: new Set<number>(),
    awaitingCustomText: false,
    resolve: () => { /* placeholder; replaced below */ },
    timer: null,
    createdAt: Date.now(),
  }

  const promise = new Promise<AskResult>((resolve) => {
    pending.resolve = (r: AskResult) => {
      // First-resolution wins (timer fired vs button vs text race).
      // Defensive: subsequent calls are no-ops.
      if (!PENDING.has(reqId)) return
      PENDING.delete(reqId)
      removeFromThreadIndex(pending)
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = null
      resolve(r)
    }
  })

  PENDING.set(reqId, pending)
  addToThreadIndex(pending)

  // Arm the timeout BEFORE sending — if delivery is slow we still
  // guarantee the agent gets a result within timeoutSec.
  pending.timer = setTimeout(() => {
    pending.resolve({
      ok: false,
      error: `user did not respond within ${timeoutSec}s`,
      reason: 'timeout',
    })
  }, timeoutSec * 1000)
  if (typeof pending.timer === 'object' && pending.timer && 'unref' in pending.timer) {
    (pending.timer as { unref: () => void }).unref()
  }

  // Compose the prompt. Cards on adapters that support them, text on
  // everything else. The card's data field encodes reqId + the button
  // action so the callback can route directly without an extra lookup.
  const card = buildAskCard(pending, serverSideToggle)
  let cardSent = false
  if (canSendChoiceCard && messenger.sendChoiceCard) {
    try {
      const sent = await messenger.sendChoiceCard(ctx.threadId, card)
      pending.cardMessageId = sent.messageId
      cardSent = true
    } catch (err) {
      log.warn({
        event: 'ask.card_send_failed',
        platform: ctx.platform, threadId: ctx.threadId,
        err: err instanceof Error ? err.message : String(err),
      })
      // Fall through to text fallback below.
    }
  }
  if (!cardSent) {
    const textHint = renderTextReplyHint({
      choiceCount: choices.length,
      selectionMode,
      minSelections,
      maxSelections,
      allowCustomInput,
      allowTextReply,
      timeoutSec,
    })
    const lines = [
      `❓ ${question}`,
      ...choices.map((c) => `  ${c.index}. ${c.label}`),
      textHint,
    ]
    try {
      await sink.deliver({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        payload: lines.join('\n'),
        kind: 'text',
        priority: 'normal',
        source: 'system',
      })
    } catch (err) {
      // Sink itself rejected. Resolve immediately so the agent doesn't
      // sit forever on a Promise that can never fire.
      pending.resolve({
        ok: false,
        error: `failed to deliver question: ${err instanceof Error ? err.message : String(err)}`,
        reason: 'no-messenger',
      })
    }
  }

  log.info({
    event: 'ask.opened', reqId,
    platform: ctx.platform, threadId: ctx.threadId,
    choices: choices.length, timeoutSec, cardSent,
    selectionMode, minSelections, maxSelections, allowCustomInput,
  })

  return promise
}

/**
 * Build the ChoiceCardPrompt for a pending ask. Used both for the initial
 * send and for in-place re-render after a toggle tap, so the keyboard stays
 * consistent. Two styles:
 *   - client-side (web/tui): plain per-choice buttons; the client renders
 *     checkboxes / custom input and assembles `multi:` / `custom:` payloads.
 *   - server-side toggle (Telegram): for multi, ☐/☑️ toggle buttons +
 *     "✅ 完成 (n)" submit + optional "✍️" custom trigger; for single, plain
 *     buttons + optional custom trigger.
 */
function buildAskCard(p: PendingAsk, serverSideToggle: boolean): ChoiceCardPrompt {
  let cardChoices: Array<{ label: string; data: string }>
  if (!serverSideToggle) {
    cardChoices = p.choices.map((c) => ({
      label: `${c.index}. ${c.label}`,
      data: `${BTN_PREFIX}${p.reqId}:${c.index}`,
    }))
    if (p.platform === 'tui' && p.allowCustomInput) {
      cardChoices.push({ label: `0. ${p.customInputLabel}`, data: `${BTN_PREFIX}${p.reqId}:custom` })
    }
  } else if (p.selectionMode === 'multi') {
    cardChoices = p.choices.map((c) => ({
      label: `${p.selected.has(c.index) ? '☑️' : '☐'} ${c.index}. ${c.label}`,
      data: `${BTN_PREFIX}${p.reqId}:t:${c.index}`,
    }))
    cardChoices.push({ label: `✅ 完成 (${p.selected.size})`, data: `${BTN_PREFIX}${p.reqId}:ok` })
    if (p.allowCustomInput) {
      cardChoices.push({ label: `✍️ ${p.customInputLabel}`, data: `${BTN_PREFIX}${p.reqId}:custom` })
    }
  } else {
    cardChoices = p.choices.map((c) => ({
      label: `${c.index}. ${c.label}`,
      data: `${BTN_PREFIX}${p.reqId}:${c.index}`,
    }))
    if (p.allowCustomInput) {
      cardChoices.push({ label: `✍️ ${p.customInputLabel}`, data: `${BTN_PREFIX}${p.reqId}:custom` })
    }
  }
  return {
    title: 'agim · 请选择',
    body: p.question,
    choices: cardChoices,
    links: p.detailsUrl ? [{ label: p.detailsLabel ?? '📖 查看详情', url: p.detailsUrl }] : undefined,
    meta: {
      kind: 'ask-user',
      reqId: p.reqId,
      selectionMode: p.selectionMode,
      minSelections: p.minSelections,
      maxSelections: p.maxSelections,
      allowCustomInput: p.allowCustomInput,
      customInputLabel: p.customInputLabel,
      timeoutSec: p.timeoutSec,
    },
  }
}

/** Validate an optional details URL: http(s) only, ≤512 chars. Returns
 *  undefined (silently dropped) on anything invalid — a bad link should
 *  never block the ask. */
function normalizeDetailsUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const url = raw.trim()
  if (!url || url.length > 512) return undefined
  if (!/^https?:\/\//i.test(url)) return undefined
  return url
}

/** Short receipt shown when a card resolves (used for editChoiceCard). */
function askFinalText(result: AskSuccessResult): string {
  if (typeof result.customText === 'string') {
    const t = result.customText.length > 60 ? `${result.customText.slice(0, 59)}…` : result.customText
    return `✅ 已回答：${t}`
  }
  if (result.selectionMode === 'multi' && result.labels?.length) {
    return `✅ 已选择：${result.labels.join('、')}`
  }
  return `✅ 已选择：${result.label}`
}

/**
 * Router-side: try to resolve a pending ask for this thread with the
 * inbound text. Returns true iff the text was consumed (router should
 * skip normal routing).
 */
export function tryResolvePendingAsk(
  platform: string, channelId: string, threadId: string,
  rawText: string,
): boolean {
  const key = threadKey(platform, channelId, threadId)
  const set = PENDING_BY_THREAD.get(key)
  if (!set || set.size === 0) return false

  const cleaned = rawText.trim()
  if (!cleaned) return false

  // Iterate snapshot — resolve() mutates the set.
  for (const reqId of Array.from(set)) {
    const p = PENDING.get(reqId)
    if (!p) continue
    // If the user tapped the "custom input" button, the next text is taken
    // verbatim (no choice matching, and regardless of allowTextReply — they
    // explicitly opted into typing an answer).
    let result: AskSuccessResult | null
    if (p.awaitingCustomText && p.allowCustomInput) {
      result = toCustomResult(cleaned, 'text', cleaned, p)
    } else {
      if (!p.allowTextReply) continue
      result = resolveTextReply(p, cleaned)
    }
    if (!result) continue
    p.resolve({ ok: true, result })
    stripCardBestEffort(p, askFinalText(result))
    log.info({
      event: 'ask.resolved.text',
      reqId,
      choice: result.index,
      mode: result.selectionMode,
      picks: result.indexes?.length ?? 1,
      custom: typeof result.customText === 'string',
    })
    return true
  }
  return false
}

/** Best-effort: after a card-backed ask resolves via text, edit the card to
 *  its terminal receipt + drop the buttons so a stale tap can't fire. No-op
 *  when there's no card or the adapter can't edit. */
function stripCardBestEffort(p: PendingAsk, finalText: string): void {
  if (!p.cardMessageId) return
  const m = resolveMessenger(p.platform)
  if (!m?.editChoiceCard) return
  void m.editChoiceCard(p.threadId, p.cardMessageId, finalText).catch(() => { /* best-effort */ })
}

/**
 * Resolve a pending ask from a "terminal" button payload — i.e. one that
 * carries the full answer, as produced client-side by web/tui:
 *   - ask:<reqId>:<index>           (single)
 *   - ask:<reqId>:multi:1,3         (multi)
 *   - ask:<reqId>:custom:<base64>   (custom text)
 * Returns the result on success. The stateful Telegram kinds (toggle /
 * submit / custom-trigger) are NOT handled here — see handleAskButton.
 */
function resolveByButton(data: string): AskSuccessResult | null {
  const parsed = parseAskButtonData(data)
  if (!parsed) return null
  const p = PENDING.get(parsed.reqId)
  if (!p) return null
  if (parsed.kind === 'single') {
    const choice = p.choices.find((c) => c.index === parsed.index)
    if (!choice) return null
    if (p.selectionMode === 'multi') {
      if (p.minSelections > 1 || p.maxSelections < 1) return null
      const result = toMultiResult([choice], 'button', data)
      p.resolve({ ok: true, result })
      log.info({ event: 'ask.resolved.button', reqId: parsed.reqId, mode: 'multi', picks: 1 })
      return result
    }
    const result = toSingleResult(choice, 'button', data, p.selectionMode)
    p.resolve({ ok: true, result })
    log.info({ event: 'ask.resolved.button', reqId: parsed.reqId, choice: choice.index, mode: p.selectionMode })
    return result
  }
  if (parsed.kind === 'multi') {
    if (p.selectionMode !== 'multi') return null
    const picked = getChoicesByIndexes(p.choices, parsed.indexes)
    if (!picked) return null
    if (picked.length < p.minSelections || picked.length > p.maxSelections) return null
    const result = toMultiResult(picked, 'button', data)
    p.resolve({ ok: true, result })
    log.info({ event: 'ask.resolved.button', reqId: parsed.reqId, mode: 'multi', picks: picked.length })
    return result
  }
  if (parsed.kind === 'custom') {
    if (!p.allowCustomInput) return null
    const customText = parsed.text.trim()
    if (!customText) return null
    const result = toCustomResult(customText, 'button', data, p)
    p.resolve({ ok: true, result })
    log.info({ event: 'ask.resolved.button', reqId: parsed.reqId, mode: p.selectionMode, custom: true })
    return result
  }
  return null
}

/**
 * Messenger-side: resolve a pending ask from a terminal button payload.
 * Returns true iff resolved. Kept for web/tui callers (and tests) that send
 * fully-formed `single` / `multi:` / `custom:<b64>` data.
 */
export function tryResolvePendingAskByButton(data: string): boolean {
  return resolveByButton(data) !== null
}

/** Outcome of a button tap, for the router to act on (ack + re-render). */
export type AskButtonOutcome =
  | { kind: 'resolved'; finalText: string }
  | { kind: 'rerender'; card: ChoiceCardPrompt }
  | { kind: 'await-custom'; prompt: string }
  | { kind: 'invalid'; hint: string }
  | { kind: 'unmatched' }

/**
 * Unified ask button dispatch. Handles BOTH the terminal payloads
 * (single / multi: / custom:<b64>, via resolveByButton) AND the stateful
 * Telegram kinds (toggle / submit / custom-trigger) that accumulate
 * server-side. The router maps the returned outcome to an ack + an
 * optional in-place card edit.
 */
export function handleAskButton(data: string): AskButtonOutcome {
  const parsed = parseAskButtonData(data)
  if (!parsed) return { kind: 'unmatched' }
  const p = PENDING.get(parsed.reqId)
  if (!p) return { kind: 'unmatched' }

  if (parsed.kind === 'toggle') {
    if (p.selectionMode !== 'multi') return { kind: 'unmatched' }
    if (!p.choices.some((c) => c.index === parsed.index)) return { kind: 'unmatched' }
    if (p.selected.has(parsed.index)) {
      p.selected.delete(parsed.index)
    } else {
      if (p.selected.size >= p.maxSelections) {
        return { kind: 'invalid', hint: `最多选 ${p.maxSelections} 项` }
      }
      p.selected.add(parsed.index)
    }
    return { kind: 'rerender', card: buildAskCard(p, true) }
  }

  if (parsed.kind === 'submit') {
    if (p.selectionMode !== 'multi') return { kind: 'unmatched' }
    const idxs = Array.from(p.selected).sort((a, b) => a - b)
    if (idxs.length < p.minSelections || idxs.length > p.maxSelections) {
      return { kind: 'invalid', hint: `请选择 ${p.minSelections}-${p.maxSelections} 项（已选 ${idxs.length}）` }
    }
    const picked = getChoicesByIndexes(p.choices, idxs)
    if (!picked) return { kind: 'unmatched' }
    const result = toMultiResult(picked, 'button', data)
    p.resolve({ ok: true, result })
    log.info({ event: 'ask.resolved.button', reqId: parsed.reqId, mode: 'multi', picks: picked.length })
    return { kind: 'resolved', finalText: askFinalText(result) }
  }

  if (parsed.kind === 'custom-trigger') {
    if (!p.allowCustomInput) return { kind: 'unmatched' }
    p.awaitingCustomText = true
    log.info({ event: 'ask.await_custom', reqId: parsed.reqId })
    return { kind: 'await-custom', prompt: '请直接输入你的回答（下一条消息将作为答案）' }
  }

  // Terminal payloads (single / multi: / custom:<b64>).
  const result = resolveByButton(data)
  if (!result) return { kind: 'unmatched' }
  return { kind: 'resolved', finalText: askFinalText(result) }
}

/** Diagnostic: pending count per thread. Used by /ask status / future
 *  /tasks#ask web tile. */
export function listPendingAsks(): Array<{
  reqId: string; platform: string; threadId: string; question: string; choices: number; ageMs: number
}> {
  const out: Array<{
    reqId: string; platform: string; threadId: string; question: string; choices: number; ageMs: number
  }> = []
  const now = Date.now()
  for (const p of PENDING.values()) {
    out.push({
      reqId: p.reqId, platform: p.platform, threadId: p.threadId,
      question: p.question.slice(0, 100), choices: p.choices.length,
      ageMs: now - p.createdAt,
    })
  }
  return out
}

/** True while this thread has an unresolved ask_user (awaiting user reply). */
export function threadHasPendingAsk(
  platform: string,
  channelId: string,
  threadId: string,
): boolean {
  if (!platform || !threadId) return false
  const set = PENDING_BY_THREAD.get(threadKey(platform, channelId || '', threadId))
  return !!set && set.size > 0
}

/**
 * Cancel a single pending ask by reqId. Returns true iff something
 * was cancelled. Used by the admin panel's per-row Cancel button —
 * the agent waiting on it gets { ok: false, reason: 'cancelled' }
 * back exactly as if the user had let it time out, which the agent
 * already knows how to handle.
 */
export function cancelPendingAsk(reqId: string, reason = 'cancelled by operator'): boolean {
  const p = PENDING.get(reqId)
  if (!p) return false
  p.resolve({ ok: false, error: reason, reason: 'cancelled' })
  log.info({ event: 'ask.cancelled_by_operator', reqId })
  return true
}

/** Test hook: cancel everything. Useful between bun-test cases. */
export function _resetAskBusForTests(): void {
  for (const p of Array.from(PENDING.values())) {
    if (p.timer) clearTimeout(p.timer)
    p.resolve({ ok: false, error: 'test reset', reason: 'cancelled' })
  }
  PENDING.clear()
  PENDING_BY_THREAD.clear()
}

// ─── helpers ─────────────────────────────────────────────────────────

function normalizeChoices(raw: unknown): AskChoice[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length < MIN_CHOICES || raw.length > MAX_CHOICES) return null
  const out: AskChoice[] = []
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]
    if (typeof v !== 'string') return null
    const label = v.trim().slice(0, MAX_CHOICE_LABEL_CHARS)
    if (!label) return null
    out.push({ index: i + 1, label })
  }
  return out
}

function clampTimeout(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_SEC
  const n = Math.floor(raw)
  if (n < MIN_TIMEOUT_SEC) return MIN_TIMEOUT_SEC
  if (n > MAX_TIMEOUT_SEC) return MAX_TIMEOUT_SEC
  return n
}

function normalizeSelectionMode(raw: unknown): AskSelectionMode | null {
  if (raw === undefined || raw === null || raw === '') return 'single'
  if (raw === 'single' || raw === 'multi') return raw
  return null
}

function normalizeSelectionBound(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  const v = Math.floor(raw)
  return v < 1 ? 1 : v
}

function normalizeCustomInputLabel(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_CUSTOM_INPUT_LABEL
  const s = raw.trim().slice(0, MAX_CHOICE_LABEL_CHARS)
  return s || DEFAULT_CUSTOM_INPUT_LABEL
}

function renderTextReplyHint(params: {
  choiceCount: number
  selectionMode: AskSelectionMode
  minSelections: number
  maxSelections: number
  allowCustomInput: boolean
  allowTextReply: boolean
  timeoutSec: number
}): string {
  const {
    choiceCount, selectionMode, minSelections, maxSelections,
    allowCustomInput, allowTextReply, timeoutSec,
  } = params
  if (!allowTextReply) return `请点击按钮完成选择；${timeoutSec}s 后超时。`
  if (selectionMode === 'single') {
    const base = `回复数字 (1-${choiceCount}) / 字母 (a-${String.fromCharCode('a'.charCodeAt(0) + choiceCount - 1)}) / 选项关键字`
    return allowCustomInput
      ? `${base}，或直接输入自定义文本；${timeoutSec}s 后超时。`
      : `${base}；${timeoutSec}s 后超时。`
  }
  const multi = `可多选：回复如 "1,3" 或 "a c"（至少 ${minSelections} 项，最多 ${maxSelections} 项）`
  return allowCustomInput
    ? `${multi}，或直接输入自定义文本；${timeoutSec}s 后超时。`
    : `${multi}；${timeoutSec}s 后超时。`
}

function resolveTextReply(p: PendingAsk, cleaned: string): AskSuccessResult | null {
  if (p.selectionMode === 'single') {
    const match = matchTextToChoice(cleaned, p.choices)
    if (match) return toSingleResult(match, 'text', cleaned, p.selectionMode)
    if (!p.allowCustomInput) return null
    return toCustomResult(cleaned, 'text', cleaned, p)
  }
  const picks = matchTextToChoices(cleaned, p.choices)
  if (picks) {
    if (picks.length < p.minSelections || picks.length > p.maxSelections) return null
    return toMultiResult(picks, 'text', cleaned)
  }
  if (!p.allowCustomInput) return null
  return toCustomResult(cleaned, 'text', cleaned, p)
}

function toSingleResult(
  choice: AskChoice,
  via: AskSuccessResult['via'],
  raw: string,
  selectionMode: AskSelectionMode = 'single',
): AskSuccessResult {
  return {
    index: choice.index,
    label: choice.label,
    via,
    raw,
    selectionMode,
  }
}

function toMultiResult(
  picked: AskChoice[],
  via: AskSuccessResult['via'],
  raw: string,
): AskSuccessResult {
  const [first] = picked
  return {
    index: first.index,
    label: first.label,
    via,
    raw,
    selectionMode: 'multi',
    indexes: picked.map((c) => c.index),
    labels: picked.map((c) => c.label),
  }
}

function toCustomResult(
  customText: string,
  via: AskSuccessResult['via'],
  raw: string,
  pending: PendingAsk,
): AskSuccessResult {
  return {
    index: 0,
    label: pending.customInputLabel,
    via,
    raw,
    selectionMode: pending.selectionMode,
    customText,
  }
}

function getChoicesByIndexes(choices: AskChoice[], indexes: number[]): AskChoice[] | null {
  const out: AskChoice[] = []
  for (const idx of indexes) {
    const choice = choices.find((c) => c.index === idx)
    if (!choice) return null
    out.push(choice)
  }
  return out
}

/**
 * Match an inbound text reply to a choice. Order of attempts:
 *   1. exact numeric "1"/"2"/…
 *   2. exact letter "a"/"b"/… (1-based)
 *   3. exact label match (case-insensitive)
 *   4. substring match — caller text contains the label (case-insens.)
 *
 * Returns null when nothing matches. Substring match is intentional so
 * users can type "the first one" / "yes do A" style answers.
 */
function matchTextToChoice(text: string, choices: AskChoice[]): AskChoice | null {
  const lower = text.toLowerCase()
  // 1. numeric "1"
  const n = parseInt(lower.replace(/[^\d]/g, ''), 10)
  if (Number.isFinite(n) && n >= 1 && n <= choices.length) {
    return choices[n - 1]
  }
  // 2. letter "a" / "b"
  if (/^[a-z]$/i.test(lower)) {
    const i = lower.charCodeAt(0) - 'a'.charCodeAt(0)
    if (i >= 0 && i < choices.length) return choices[i]
  }
  // 3. exact label
  const exact = choices.find((c) => c.label.toLowerCase() === lower)
  if (exact) return exact
  // 4. substring (longest label first so a 2-char label doesn't shadow
  //    a 20-char label that happens to also be present)
  const sorted = [...choices].sort((a, b) => b.label.length - a.label.length)
  for (const c of sorted) {
    if (lower.includes(c.label.toLowerCase())) return c
  }
  return null
}

function matchTextToChoices(text: string, choices: AskChoice[]): AskChoice[] | null {
  const lower = text.toLowerCase()
  const picked = new Map<number, AskChoice>()

  // 1) explicit numeric references anywhere in the text: "1,3"
  const nums = lower.match(/\d+/g) ?? []
  for (const nText of nums) {
    const n = Number.parseInt(nText, 10)
    if (!Number.isFinite(n) || n < 1 || n > choices.length) continue
    picked.set(n, choices[n - 1])
  }

  // 2) single-letter references: "a c"
  const letters = lower.match(/\b[a-z]\b/g) ?? []
  for (const token of letters) {
    const i = token.charCodeAt(0) - 'a'.charCodeAt(0)
    if (i >= 0 && i < choices.length) picked.set(i + 1, choices[i])
  }

  if (picked.size > 0) {
    return Array.from(picked.values()).sort((a, b) => a.index - b.index)
  }

  // 3) tokenized exact label matches
  const tokens = lower.split(/[\s,，、;；|]+/).filter(Boolean)
  for (const token of tokens) {
    const exact = choices.find((c) => c.label.toLowerCase() === token)
    if (exact) picked.set(exact.index, exact)
  }
  if (picked.size > 0) {
    return Array.from(picked.values()).sort((a, b) => a.index - b.index)
  }

  // 4) fallback label substring scan
  for (const c of choices) {
    if (lower.includes(c.label.toLowerCase())) picked.set(c.index, c)
  }
  if (picked.size === 0) return null
  return Array.from(picked.values()).sort((a, b) => a.index - b.index)
}

type AskButtonData =
  | { reqId: string; kind: 'single'; index: number }
  | { reqId: string; kind: 'multi'; indexes: number[] }
  | { reqId: string; kind: 'custom'; text: string }
  // Stateful Telegram kinds (server-side accumulation):
  | { reqId: string; kind: 'toggle'; index: number }   // ask:<id>:t:<i>
  | { reqId: string; kind: 'submit' }                  // ask:<id>:ok
  | { reqId: string; kind: 'custom-trigger' }          // ask:<id>:custom (no payload)

function parseAskButtonData(data: string): AskButtonData | null {
  if (!data.startsWith(BTN_PREFIX)) return null
  const parts = data.slice(BTN_PREFIX.length).split(':')
  if (parts.length < 2) return null
  const reqId = parts[0]
  if (!reqId) return null
  const action = parts[1]

  // Toggle one multi-select index: ask:<reqId>:t:<index>
  if (action === 't') {
    const idx = Number.parseInt(parts[2] ?? '', 10)
    if (!Number.isFinite(idx)) return null
    return { reqId, kind: 'toggle', index: idx }
  }
  // Submit the accumulated multi-select: ask:<reqId>:ok
  if (action === 'ok') {
    return { reqId, kind: 'submit' }
  }
  if (action === 'multi') {
    const raw = parts.slice(2).join(':')
    const indexes = parseMultiIndexes(raw)
    if (!indexes || indexes.length === 0) return null
    return { reqId, kind: 'multi', indexes }
  }
  if (action === 'custom') {
    const encoded = parts.slice(2).join(':')
    // Bare `custom` (no payload) = trigger: enter await-custom-text mode.
    if (!encoded) return { reqId, kind: 'custom-trigger' }
    const text = decodeBase64Url(encoded)
    if (text === null) return null
    return { reqId, kind: 'custom', text }
  }

  // Default format: ask:<reqId>:<index> (single).
  const idx = Number.parseInt(action, 10)
  if (!Number.isFinite(idx)) return null
  return { reqId, kind: 'single', index: idx }
}

function parseMultiIndexes(raw: string): number[] | null {
  if (!raw) return null
  const tokens = raw.split(/[\s,，、;；|]+/).filter(Boolean)
  if (tokens.length === 0) return null
  const out = new Set<number>()
  for (const token of tokens) {
    const n = Number.parseInt(token, 10)
    if (!Number.isFinite(n) || n < 1) return null
    out.add(n)
  }
  return Array.from(out.values()).sort((a, b) => a - b)
}

function decodeBase64Url(input: string): string | null {
  if (!input) return null
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  try {
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
}
