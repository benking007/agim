// clock — single source of "now" so tests can inject time without
// monkey-patching Date.now globally.
//
// Why a wrapper instead of just `Date.now()`:
//
//   1. Several modules (cron / scheduler, reminders, rate-limiter,
//      approval-bus, session TTL, retention sweeps) all read wall-clock
//      time at fire time. Tests that want to assert "after the cooldown
//      elapses, the breaker re-arms" today either pass an explicit
//      `now` argument through layers (the half-fix I shipped in
//      llm-budget.ts) or do `Date.now = () => fake` globally with the
//      attendant cleanup hazards.
//
//   2. Production code stays on a single line per read — `nowMs()` —
//      so the wrapper has zero runtime cost relative to inline
//      `Date.now()` and reads almost identical.
//
//   3. `setNow(fixed)` puts the clock under test control; `setNow(null)`
//      restores the system clock. The setter is intentionally a
//      function rather than an exported mutable export so the test
//      hook is grep-able (`setNow`) and obviously deliberate.
//
// This commit only adds the primitive; the consumer migration to
// nowMs() is deferred to a follow-up so this change stays small and
// reviewable. Existing call sites continue to use Date.now() — they
// keep working, they just don't yet benefit from the test hook.

let _frozenNow: number | null = null

/** Current wall-clock time in ms since the unix epoch. Honours
 *  {@link setNow} when called from test code. */
export function nowMs(): number {
  return _frozenNow ?? Date.now()
}

/** Test-only — freeze the clock at `ms`, or null to restore live time. */
export function setNow(ms: number | null): void {
  _frozenNow = ms
}

/** Test-only — return whether the clock is currently frozen. Useful for
 *  test cleanup helpers that want to assert no test leaked frozen state. */
export function isFrozen(): boolean { return _frozenNow !== null }
