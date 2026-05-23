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
//   agent (via MCP tool mcp__imhub__ask_user)
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
import { sink } from './message-sink.js'
import { registry } from './registry.js'

const log = rootLogger.child({ component: 'ask-user-rpc' })

/** Hard caps on user-facing prompt + choice count + per-choice label. */
export const MAX_QUESTION_CHARS = 1_000
export const MAX_CHOICE_LABEL_CHARS = 80
export const MIN_CHOICES = 2
export const MAX_CHOICES = 9   // 1..9 keypad-friendly; cards have layout limits

/** Default timeout. Generous because the user might be reading a long
 *  question; agents asking yes/no should pass a shorter timeoutSec. */
const DEFAULT_TIMEOUT_SEC = 300  // 5 min
const MIN_TIMEOUT_SEC = 5
const MAX_TIMEOUT_SEC = 60 * 30  // 30 min

/** Reserved button-data prefix — short to fit Telegram's 64-byte cap. */
const BTN_PREFIX = 'ask:'

export interface AskPayload {
  question?: unknown
  choices?: unknown    // string[]; index encoded as key in the result
  timeoutSec?: unknown
  /** When true (default), text replies like "1" / "a" / the choice
   *  label substring match the corresponding option. Disable for
   *  strict button-only flows (the user must click a button or wait
   *  for the timeout). */
  allowTextReply?: unknown
}

export interface AskChoice {
  /** 1-indexed for human readability (1 / 2 / 3 …) */
  index: number
  /** Display label as shown to the user. */
  label: string
}

export type AskResult =
  | {
      ok: true
      result: {
        /** 1-indexed choice the user picked. */
        index: number
        /** The label that was shown for that choice. */
        label: string
        /** 'button' | 'text' | 'timeout'. timeout never has a chosen
         *  index either — see ok=false for that. */
        via: 'button' | 'text'
        /** Raw user-typed text or button data; lets the agent diff
         *  against what was shown if needed. */
        raw: string
      }
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
  allowTextReply: boolean
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
  const timeoutSec = clampTimeout(payload.timeoutSec)
  const allowTextReply = payload.allowTextReply !== false  // default true

  // Resolve the messenger for the IM thread. If the platform isn't
  // registered (rare — usually means a misconfigured ACP caller), fall
  // through to text-only via sink, which will queue and eventually fail
  // delivery with a clear error. We refuse the ask in that case so the
  // agent doesn't sit on a Promise that can never resolve.
  const messenger = registry.getMessenger(ctx.platform)
  if (!messenger) {
    return {
      ok: false,
      error: `messenger "${ctx.platform}" not registered (cannot deliver the question)`,
      reason: 'no-messenger',
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
    allowTextReply,
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
  // everything else. The card's data field encodes reqId + index so
  // the button callback can route directly without an extra lookup.
  const card: ChoiceCardPrompt = {
    title: 'agim · 请选择',
    body: question,
    choices: choices.map((c) => ({
      label: `${c.index}. ${c.label}`,
      data: `${BTN_PREFIX}${reqId}:${c.index}`,
    })),
  }
  let cardSent = false
  if (messenger.sendChoiceCard) {
    try {
      await messenger.sendChoiceCard(ctx.threadId, card)
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
    const lines = [
      `❓ ${question}`,
      ...choices.map((c) => `  ${c.index}. ${c.label}`),
      allowTextReply
        ? `回复数字 (1-${choices.length}) 或选项关键字；${timeoutSec}s 后超时。`
        : `请等待按钮回调；${timeoutSec}s 后超时。`,
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
  })

  return promise
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
    if (!p.allowTextReply) continue
    const match = matchTextToChoice(cleaned, p.choices)
    if (!match) continue
    p.resolve({
      ok: true,
      result: { index: match.index, label: match.label, via: 'text', raw: cleaned },
    })
    log.info({ event: 'ask.resolved.text', reqId, choice: match.index })
    return true
  }
  return false
}

/**
 * Messenger-side: button callback handler. The data field is the
 * card's `data` we stored as `ask:<reqId>:<index>`. Returns true iff
 * resolved (caller can ack the tap).
 */
export function tryResolvePendingAskByButton(data: string): boolean {
  if (!data.startsWith(BTN_PREFIX)) return false
  const rest = data.slice(BTN_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep === -1) return false
  const reqId = rest.slice(0, sep)
  const idxStr = rest.slice(sep + 1)
  const idx = parseInt(idxStr, 10)
  if (!Number.isFinite(idx)) return false
  const p = PENDING.get(reqId)
  if (!p) return false
  const choice = p.choices.find((c) => c.index === idx)
  if (!choice) return false
  p.resolve({
    ok: true,
    result: { index: choice.index, label: choice.label, via: 'button', raw: data },
  })
  log.info({ event: 'ask.resolved.button', reqId, choice: choice.index })
  return true
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
