// format-age — shared row-age formatter used by persona / memory / future
// memo + reminder snippets (P0 #4).
//
// Why this exists: when the agent reads injected memory facts or the
// persona summary, freshness changes the right action. "User likes
// coffee — last said 4 hours ago" is actionable; "last said 18 months
// ago" should make the agent verify before assuming. Without an
// inline age signal the agent treats every fact as equally current,
// and we end up answering questions about preferences that have
// silently shifted.
//
// The numbers are intentionally human-readable rather than exact —
// "3d" / "2h" / "5min" / "just now" — because the agent uses them as
// rough hints, not for math. ISO timestamps stay in the record for
// callers that need precision (web UI, audit).

/**
 * Format the gap between `then` (any of: epoch ms, epoch sec, ISO
 * string, or Date) and `now` (default = current time, epoch ms) as a
 * short human label.
 *
 *   < 60s            → "just now"
 *   < 60min          → "5min ago"
 *   < 24h            → "3h ago"
 *   < 30d            → "7d ago"
 *   < 12 months      → "4mo ago"
 *   otherwise        → "2y ago"
 *
 * Returns 'unknown' on invalid input rather than throwing — these are
 * presentation labels, not security-critical data.
 *
 * Future-dated `then` (e.g. clock skew) yields 'just now' rather than
 * negative ages.
 */
export function formatAge(then: number | string | Date | null | undefined, now: number = Date.now()): string {
  const thenMs = toMs(then)
  if (thenMs === null) return 'unknown'

  let diff = now - thenMs
  if (diff < 0) diff = 0
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`

  // Switch to year units only after we actually cross the 365-day
  // boundary so we don't have to special-case 12 months (which by our
  // 30-day-month rule resolves to days=360). Below 365 stays in months.
  if (days < 365) {
    const months = Math.floor(days / 30)
    return `${months}mo ago`
  }

  const years = Math.floor(days / 365)
  return `${years}y ago`
}

/** Coerce the supported input shapes into epoch ms. Returns null on
 *  obviously invalid input (NaN, future Infinity, malformed string,
 *  missing). */
function toMs(then: number | string | Date | null | undefined): number | null {
  if (then === null || then === undefined) return null
  if (then instanceof Date) {
    const t = then.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof then === 'number') {
    if (!Number.isFinite(then) || then <= 0) return null
    // Heuristic: if it looks like epoch seconds (10-digit ish, before
    // year 2286), upscale to ms. Anything ≥ 1e12 is treated as ms.
    return then < 1e12 ? then * 1000 : then
  }
  if (typeof then === 'string') {
    const t = Date.parse(then)
    return Number.isFinite(t) ? t : null
  }
  return null
}
