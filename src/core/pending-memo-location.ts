// pending-memo-location.ts — short-lived "you sent a pin, want me to remember it?"
// state, used when a messenger delivers a native location/venue message.
//
// Flow:
//   1. User taps Telegram 📎 → Location → bot receives `message:location`
//      (or `message:venue` for places with a title/address).
//   2. Adapter calls setPending(threadKey, { lat, lng, venueLabel?, ... }) and
//      replies asking the user to name it.
//   3. User's next text in this thread runs through tryConsumeReply BEFORE
//      the agent router (same pattern as pending-reminder.ts). The text is
//      either a cancel pattern, a confirm pattern (only meaningful for
//      venues — auto-uses the venue title), or a free-form label to use as
//      `what`.
//
// Deliberately in-memory: a stale pending after im-hub restart would just
// be confusing UX, and the TTL is short (5 min — same as reminders). If
// the user comes back later they can re-share the pin.

const PENDING_TTL_MS = 5 * 60 * 1000

export interface PendingMemoLocation {
  lat: number
  lng: number
  /** Telegram horizontal accuracy in meters, when provided. */
  accuracy?: number
  /** Venue title — when set, "y" can confirm without re-typing it. */
  venueLabel?: string
  /** Venue address — used as where_label when present (richer than just lat/lng). */
  venueAddress?: string
  /** Wall-clock ms when stored — for TTL eviction. */
  createdAt: number
}

const store = new Map<string, PendingMemoLocation>()

function evictExpired(now: number): void {
  for (const [k, v] of store) {
    if (now - v.createdAt > PENDING_TTL_MS) store.delete(k)
  }
}

export function setPending(threadKey: string, p: Omit<PendingMemoLocation, 'createdAt'>): void {
  evictExpired(Date.now())
  store.set(threadKey, { ...p, createdAt: Date.now() })
}

export function getPending(threadKey: string): PendingMemoLocation | null {
  evictExpired(Date.now())
  return store.get(threadKey) ?? null
}

export function clearPending(threadKey: string): void {
  store.delete(threadKey)
}

export function _sizeForTest(): number { return store.size }
export function _clearForTest(): void { store.clear() }

const CANCEL_PAT = /^(n|no|否|取消|不|不用|算了|skip|跳过|忽略)\s*$/i
const CONFIRM_PAT = /^(y|yes|是|确认|对|好|ok|可以|记下|保存)\s*$/i

export type ConsumedDecision =
  | { decision: 'cancel'; pending: PendingMemoLocation }
  | { decision: 'save'; pending: PendingMemoLocation; what: string }

/**
 * Inspect an inbound text message; if there's a pending location for this
 * thread, decide what to do:
 *   - cancel pattern → `cancel`
 *   - confirm pattern → `save` with venue title as `what` (only valid when
 *     a venueLabel exists; otherwise the user must supply a name)
 *   - any other non-empty text → `save` with that text as `what`
 *   - empty text → null (don't intercept; let normal pipeline handle)
 *
 * Returns null when there is no pending entry — caller proceeds normally.
 */
export function tryConsumeReply(threadKey: string, text: string): ConsumedDecision | null {
  const pending = getPending(threadKey)
  if (!pending) return null
  const t = text.trim()
  if (!t) return null

  if (CANCEL_PAT.test(t)) {
    clearPending(threadKey)
    return { decision: 'cancel', pending }
  }

  if (CONFIRM_PAT.test(t) && pending.venueLabel) {
    clearPending(threadKey)
    return { decision: 'save', pending, what: pending.venueLabel }
  }

  // Free-form label: use the whole trimmed text as `what`. Cap to avoid
  // accidentally swallowing a long reply that wasn't meant for us — if the
  // user wrote a paragraph, they probably moved on to a new topic and the
  // pending should TTL out instead of being consumed.
  if (t.length > 80) return null

  clearPending(threadKey)
  return { decision: 'save', pending, what: t }
}
