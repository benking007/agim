// llm-budget — shared cost cap + circuit breaker for "system" LLM calls
// (memory distillation, persona consolidation, future helper calls).
//
// What problem this solves:
//
//   The memory subsystem fires an LLM call after every user turn (distill)
//   and once per day per active user (consolidate). Both are operator-paid
//   — the user never sees the cost — so a runaway loop (LLM that won't
//   stop, agent that throws midway and triggers retries, malicious user
//   trying to burn the bot's budget) shows up as a fat invoice, not as a
//   broken IM bubble. There was no per-day budget, no per-call timeout
//   (only a `Date.now() > deadline` check inside the chunk loop, which
//   doesn't help when the agent stalls before the first chunk), and no
//   circuit breaker — three connected failures and the next thousand
//   inbound messages all retry and all fail.
//
//   This module is the missing waist:
//
//     * Budget   — per-purpose, per-user, per-UTC-day spend ceiling.
//     * Timeout  — produces a real AbortSignal callers pass into
//                  AgentAdapter.sendPrompt, which forwards it to the
//                  child-process / HTTP transport.
//     * Circuit  — N consecutive failures opens; subsequent calls skip
//                  cheaply until the cooldown elapses.
//
//   All three are configurable via env so an operator who *wants* an
//   uncapped distill can opt out, but the defaults are safe.

import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'llm-budget' })

/**
 * Parse a positive number from env or return the fallback. Negative /
 * NaN / unparseable values fall back too (and emit one warn so the
 * operator notices their typo).
 */
function parsePositiveEnvNumber(envKey: string, fallback: number): number {
  const raw = process.env[envKey]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    log.warn({ event: 'llm-budget.invalid_env', envKey, raw }, 'invalid env value, using default')
    return fallback
  }
  return n
}

/** UTC-day boundary as "YYYY-MM-DD" — used as the per-day reset key. */
function utcDayKey(ms: number = Date.now()): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Per-(purpose, userKey, UTC-day) spend tracker. Calls are admitted only
 * if the current day's tally is below the configured cap; on admission,
 * caller adds the realized USD via {@link record} after the LLM finishes.
 *
 * State is in-memory, not persisted. Process restart resets all budgets —
 * acceptable for a soft guard whose purpose is to bound a runaway, not
 * to enforce a billing limit. Restarts are rare; even with hourly
 * restarts the operator caps spend at 24× the cap-per-day, which is
 * still finite.
 */
export class LlmBudget {
  private readonly capUsd: number
  /** key = `${purpose}${userKey}${day}`. Map keeps memory
   *  flat; cleanup on date rollover happens lazily inside check/record. */
  private readonly tally = new Map<string, number>()
  private currentDay = utcDayKey()

  constructor(public readonly purpose: string, capUsd: number) {
    this.capUsd = capUsd
  }

  private rotateIfNewDay(now: number): void {
    const today = utcDayKey(now)
    if (today === this.currentDay) return
    // Drop stale day's tallies wholesale — we only ever query "today".
    this.tally.clear()
    this.currentDay = today
  }

  private keyFor(userKey: string): string {
    return `${this.purpose}${userKey}${this.currentDay}`
  }

  /** Returns true if the caller is below the cap (call is admitted). */
  check(userKey: string, now: number = Date.now()): boolean {
    this.rotateIfNewDay(now)
    if (this.capUsd <= 0) return true  // cap disabled
    const spent = this.tally.get(this.keyFor(userKey)) ?? 0
    return spent < this.capUsd
  }

  /** Record realized cost. Negative deltas are ignored (defensive). */
  record(userKey: string, costUsd: number, now: number = Date.now()): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return
    this.rotateIfNewDay(now)
    const k = this.keyFor(userKey)
    this.tally.set(k, (this.tally.get(k) ?? 0) + costUsd)
  }

  /** Test/diagnostic. */
  spent(userKey: string, now: number = Date.now()): number {
    this.rotateIfNewDay(now)
    return this.tally.get(this.keyFor(userKey)) ?? 0
  }

  /** Test only — clears all state. */
  _reset(): void { this.tally.clear(); this.currentDay = utcDayKey() }
}

/**
 * Per-purpose circuit breaker. Opens after `threshold` consecutive
 * failures (any cause), stays open for `cooldownMs`, then closes on the
 * next success.
 *
 * Granularity intentionally per-purpose, not per-(purpose, user): the
 * usual failure mode is "the LLM API is down" or "the user's agent has
 * an auth issue", both of which affect everyone using that purpose.
 * Tracking per-user would let a single misbehaving account jam the
 * cooldown for everyone.
 */
export class LlmCircuitBreaker {
  private fails = 0
  private openedAt = 0

  constructor(
    public readonly purpose: string,
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  /** Returns true if calls should be admitted; false during cooldown. */
  isClosed(now: number = Date.now()): boolean {
    if (this.openedAt === 0) return true
    if (now - this.openedAt >= this.cooldownMs) {
      // Half-open: allow the next call through. If it succeeds, we
      // reset; if it fails, we re-open with a fresh cooldown.
      this.openedAt = 0
      this.fails = this.threshold - 1
      return true
    }
    return false
  }

  recordSuccess(): void {
    this.fails = 0
    this.openedAt = 0
  }

  recordFailure(now: number = Date.now()): void {
    this.fails += 1
    if (this.fails >= this.threshold && this.openedAt === 0) {
      this.openedAt = now
      log.warn({
        event: 'llm-budget.circuit_opened',
        purpose: this.purpose,
        threshold: this.threshold,
        cooldownMs: this.cooldownMs,
      })
    }
  }

  /** Test only. */
  _reset(): void { this.fails = 0; this.openedAt = 0 }
  _state(): { fails: number; openedAt: number } { return { fails: this.fails, openedAt: this.openedAt } }
}

export interface LlmGuardConfig {
  timeoutMs: number
  budgetUsd: number
  circuitThreshold: number
  circuitCooldownMs: number
}

/**
 * Resolve a config bundle from env. Env keys follow the
 * `IMHUB_<PURPOSE_UPPER>_{TIMEOUT_MS,DAILY_BUDGET_USD,CIRCUIT_FAILS,CIRCUIT_COOLDOWN_MS}`
 * convention; each falls back to the provided default.
 *
 * The defaults are deliberately conservative — distill fires per turn,
 * so a hung LLM call should die in tens of seconds, not minutes.
 */
export function resolveLlmGuardConfig(
  purposeKey: string,
  defaults: LlmGuardConfig,
): LlmGuardConfig {
  const upper = purposeKey.toUpperCase().replace(/-/g, '_')
  return {
    timeoutMs:         parsePositiveEnvNumber(`IMHUB_${upper}_TIMEOUT_MS`,         defaults.timeoutMs),
    budgetUsd:         parsePositiveEnvNumber(`IMHUB_${upper}_DAILY_BUDGET_USD`,   defaults.budgetUsd),
    circuitThreshold:  parsePositiveEnvNumber(`IMHUB_${upper}_CIRCUIT_FAILS`,      defaults.circuitThreshold),
    circuitCooldownMs: parsePositiveEnvNumber(`IMHUB_${upper}_CIRCUIT_COOLDOWN_MS`, defaults.circuitCooldownMs),
  }
}
