// pending-reminder.ts — short-lived "did you mean to set a reminder?"
// state, used by the LLM intent detector.
//
// When the detector decides a non-slash message is probably a reminder
// request, it stashes the parsed payload here keyed by thread, sends a
// confirmation card, and waits for a y/n reply. This module deliberately
// stays in-memory — pending detections are bounded by a 5-min TTL and
// don't need to survive restart (a stale "y" arriving after restart
// would be confusing UX anyway).

const PENDING_TTL_MS = 5 * 60 * 1000

export interface PendingReminder {
  fireAt: Date
  text: string
  recurrence?: string
  routeViaEmail?: boolean
  emailTarget?: string
  /** Wall-clock ms when this entry was put — used for TTL eviction. */
  createdAt: number
}

const store = new Map<string, PendingReminder>()

function evictExpired(now: number): void {
  for (const [k, v] of store) {
    if (now - v.createdAt > PENDING_TTL_MS) store.delete(k)
  }
}

export function setPending(threadKey: string, p: Omit<PendingReminder, 'createdAt'>): void {
  evictExpired(Date.now())
  store.set(threadKey, { ...p, createdAt: Date.now() })
}

export function getPending(threadKey: string): PendingReminder | null {
  evictExpired(Date.now())
  return store.get(threadKey) ?? null
}

export function clearPending(threadKey: string): void {
  store.delete(threadKey)
}

export function _sizeForTest(): number { return store.size }
export function _clearForTest(): void { store.clear() }

const CONFIRM_PAT = /^(y|yes|是|确认|对|好|ok|可以|创建)\s*$/i
const CANCEL_PAT = /^(n|no|否|取消|不|算了|不用|skip)\s*$/i

/** Inspect an inbound message; if there's a pending detection for this
 *  thread AND the message looks like y/n, return the decision. Otherwise
 *  return null and the caller continues normal processing. */
export function tryConsumeReply(threadKey: string, text: string):
  | { decision: 'confirm'; pending: PendingReminder }
  | { decision: 'cancel'; pending: PendingReminder }
  | null
{
  const pending = getPending(threadKey)
  if (!pending) return null
  const t = text.trim()
  if (CONFIRM_PAT.test(t)) {
    clearPending(threadKey)
    return { decision: 'confirm', pending }
  }
  if (CANCEL_PAT.test(t)) {
    clearPending(threadKey)
    return { decision: 'cancel', pending }
  }
  // Anything else: leave pending in place (user might be ignoring the card,
  // or replying with extra context). It'll TTL out on its own.
  return null
}
