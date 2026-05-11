// location-context.ts — short-lived "user just shared GPS / venue" cache
// per IM thread. Used by Telegram + Feishu adapters when the user sends a
// native location/venue message: instead of running a deterministic
// pending-reply + heuristic-extraction flow, we just stash the coords here
// for the duration of one user turn, and cli.ts injects an annotation
// into the user's NEXT text message before dispatching to the agent.
//
// Why this design (matches WeChat's H5-flow architecture):
//   The agent already has full conversational context + LLM judgment;
//   it's the right decision-maker for "should this be saved? as what?".
//   The adapter's job is to surface the data, not to decide.
//
// Compared to the old pending-memo-location.ts:
//   - No reply-decoding regex (cancel/confirm/free-form patterns)
//   - No heuristic noun extraction (was producing "记下" / "一个好吃的日"
//     style truncations)
//   - No "y/n to skip" UX — the agent decides based on the user's actual
//     follow-up message. "不用记" / silence / new topic all work naturally.
//
// The cache is purely additive: location is consumed on the next agent
// dispatch in the same thread within 5 min. Beyond that, it evicts.

const TTL_MS = 5 * 60 * 1000

export interface LocationContext {
  /** WGS-84 latitude (caller is responsible for any GCJ-02→WGS-84 reversal). */
  lat: number
  /** WGS-84 longitude. */
  lng: number
  /** Optional accuracy in meters from the source platform. */
  accuracy?: number
  /** Venue title (Telegram venue / Feishu location.name). */
  venueLabel?: string
  /** Venue address line. */
  venueAddress?: string
  /** Internal — used for TTL eviction. */
  createdAt: number
}

const store = new Map<string, LocationContext>()

function evictExpired(now: number): void {
  for (const [k, v] of store) {
    if (now - v.createdAt > TTL_MS) store.delete(k)
  }
}

export function setLocationContext(
  threadKey: string,
  ctx: Omit<LocationContext, 'createdAt'>,
): void {
  evictExpired(Date.now())
  store.set(threadKey, { ...ctx, createdAt: Date.now() })
}

/**
 * Pop the location for this thread if any. Single-shot — consuming a
 * location clears it, so a single share annotates at most one user turn.
 */
export function consumeLocationContext(threadKey: string): LocationContext | null {
  evictExpired(Date.now())
  const c = store.get(threadKey)
  if (c) store.delete(threadKey)
  return c ?? null
}

export function _sizeForTest(): number { return store.size }
export function _clearForTest(): void { store.clear() }

/**
 * Render a single-line annotation that we prepend to the user's next text
 * message before sending it to the agent. Format is a structured tag the
 * agent's system prompt knows about — see save_memo's tool description.
 *
 * Example:
 *   [user just shared location: lat=30.275796, lng=120.127970, name="黄龙国际中心", address="学院路77号", accuracy_m=5]
 */
export function formatLocationAnnotation(c: LocationContext): string {
  const parts: string[] = [
    `lat=${c.lat.toFixed(6)}`,
    `lng=${c.lng.toFixed(6)}`,
  ]
  if (c.venueLabel) parts.push(`name=${JSON.stringify(c.venueLabel)}`)
  if (c.venueAddress) parts.push(`address=${JSON.stringify(c.venueAddress)}`)
  if (typeof c.accuracy === 'number' && Number.isFinite(c.accuracy)) {
    parts.push(`accuracy_m=${Math.round(c.accuracy)}`)
  }
  return `[user just shared location: ${parts.join(', ')}]`
}
