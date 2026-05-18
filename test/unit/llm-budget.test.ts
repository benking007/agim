// H-N5 — shared LLM cost cap + circuit breaker for system calls
// (memory distill, persona consolidate).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  LlmBudget,
  LlmCircuitBreaker,
  resolveLlmGuardConfig,
} from '../../src/core/llm-budget'

describe('LlmBudget', () => {
  it('admits calls while under cap, blocks once exceeded', () => {
    const b = new LlmBudget('distill', 0.10)
    expect(b.check('u1')).toBe(true)
    b.record('u1', 0.05)
    expect(b.check('u1')).toBe(true)
    b.record('u1', 0.05)
    // total == cap → next check should report at-or-over.
    expect(b.check('u1')).toBe(false)
  })

  it('partitions tally by userKey', () => {
    const b = new LlmBudget('distill', 0.10)
    b.record('alice', 0.10)
    expect(b.check('alice')).toBe(false)
    expect(b.check('bob')).toBe(true)
  })

  it('partitions tally by purpose (separate instances)', () => {
    const a = new LlmBudget('distill', 0.10)
    const c = new LlmBudget('consolidate', 0.10)
    a.record('u1', 0.10)
    expect(a.check('u1')).toBe(false)
    expect(c.check('u1')).toBe(true)
  })

  it('cap=0 means disabled (always admit)', () => {
    const b = new LlmBudget('distill', 0)
    b.record('u1', 1000)
    expect(b.check('u1')).toBe(true)
  })

  it('rotates the tally on UTC-day rollover', () => {
    const b = new LlmBudget('distill', 0.10)
    const t0 = Date.parse('2026-05-18T23:50:00Z')
    const t1 = Date.parse('2026-05-19T00:10:00Z')
    b.record('u1', 0.10, t0)
    expect(b.check('u1', t0)).toBe(false)
    // New UTC day starts — tally resets.
    expect(b.check('u1', t1)).toBe(true)
    expect(b.spent('u1', t1)).toBe(0)
  })

  it('ignores negative / NaN / non-finite costs', () => {
    const b = new LlmBudget('distill', 0.10)
    b.record('u1', -1)
    b.record('u1', NaN)
    b.record('u1', Infinity)
    expect(b.spent('u1')).toBe(0)
  })
})

describe('LlmCircuitBreaker', () => {
  it('closed → admits calls', () => {
    const c = new LlmCircuitBreaker('distill', 3, 60_000)
    expect(c.isClosed()).toBe(true)
  })

  it('opens after threshold consecutive failures', () => {
    const c = new LlmCircuitBreaker('distill', 3, 60_000)
    c.recordFailure()
    c.recordFailure()
    expect(c.isClosed()).toBe(true)  // still 2 fails
    c.recordFailure()
    expect(c.isClosed()).toBe(false)  // 3rd fail opens
  })

  it('recordSuccess resets the failure count', () => {
    const c = new LlmCircuitBreaker('distill', 3, 60_000)
    c.recordFailure()
    c.recordFailure()
    c.recordSuccess()
    c.recordFailure()
    c.recordFailure()
    expect(c.isClosed()).toBe(true)  // counter reset after success
  })

  it('reopens after cooldown elapses (half-open)', () => {
    const c = new LlmCircuitBreaker('distill', 2, 1000)
    const t0 = 1_000_000
    c.recordFailure(t0)
    c.recordFailure(t0)
    expect(c.isClosed(t0)).toBe(false)
    // Still in cooldown
    expect(c.isClosed(t0 + 500)).toBe(false)
    // Cooldown elapsed → half-open, admit one
    expect(c.isClosed(t0 + 1500)).toBe(true)
    // If that half-open call fails immediately, we re-open
    c.recordFailure(t0 + 1500)
    expect(c.isClosed(t0 + 1500)).toBe(false)
  })

  it('half-open success closes the breaker', () => {
    const c = new LlmCircuitBreaker('distill', 2, 1000)
    const t0 = 1_000_000
    c.recordFailure(t0); c.recordFailure(t0)
    // Trigger half-open transition.
    expect(c.isClosed(t0 + 2000)).toBe(true)
    c.recordSuccess()
    // Subsequent fails count from zero again.
    c.recordFailure(t0 + 3000)
    expect(c.isClosed(t0 + 3000)).toBe(true)
  })
})

describe('resolveLlmGuardConfig', () => {
  const SAVED_ENV: Record<string, string | undefined> = {}
  const KEYS = [
    'IMHUB_DISTILL_TIMEOUT_MS',
    'IMHUB_DISTILL_DAILY_BUDGET_USD',
    'IMHUB_DISTILL_CIRCUIT_FAILS',
    'IMHUB_DISTILL_CIRCUIT_COOLDOWN_MS',
    'IMHUB_CONSOLIDATE_TIMEOUT_MS',
  ]

  beforeEach(() => { for (const k of KEYS) { SAVED_ENV[k] = process.env[k]; delete process.env[k] } })
  afterEach(() => {
    for (const k of KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k]
      else process.env[k] = SAVED_ENV[k]
    }
  })

  it('uses defaults when env unset', () => {
    const c = resolveLlmGuardConfig('distill', {
      timeoutMs: 30_000, budgetUsd: 0.10, circuitThreshold: 3, circuitCooldownMs: 600_000,
    })
    expect(c).toEqual({ timeoutMs: 30_000, budgetUsd: 0.10, circuitThreshold: 3, circuitCooldownMs: 600_000 })
  })

  it('overrides from env per-purpose', () => {
    process.env.IMHUB_DISTILL_TIMEOUT_MS = '15000'
    process.env.IMHUB_DISTILL_DAILY_BUDGET_USD = '0.50'
    process.env.IMHUB_DISTILL_CIRCUIT_FAILS = '5'
    process.env.IMHUB_DISTILL_CIRCUIT_COOLDOWN_MS = '120000'
    const c = resolveLlmGuardConfig('distill', {
      timeoutMs: 30_000, budgetUsd: 0.10, circuitThreshold: 3, circuitCooldownMs: 600_000,
    })
    expect(c).toEqual({ timeoutMs: 15_000, budgetUsd: 0.50, circuitThreshold: 5, circuitCooldownMs: 120_000 })
  })

  it('falls back on invalid env (negative / NaN / empty)', () => {
    process.env.IMHUB_DISTILL_TIMEOUT_MS = '-1'
    process.env.IMHUB_DISTILL_DAILY_BUDGET_USD = 'abc'
    process.env.IMHUB_DISTILL_CIRCUIT_FAILS = '0'
    process.env.IMHUB_DISTILL_CIRCUIT_COOLDOWN_MS = ''
    const c = resolveLlmGuardConfig('distill', {
      timeoutMs: 30_000, budgetUsd: 0.10, circuitThreshold: 3, circuitCooldownMs: 600_000,
    })
    expect(c.timeoutMs).toBe(30_000)
    expect(c.budgetUsd).toBe(0.10)
    expect(c.circuitThreshold).toBe(3)
    expect(c.circuitCooldownMs).toBe(600_000)
  })

  it('purpose key uppercased + underscored for env lookup', () => {
    // 'consolidate' → IMHUB_CONSOLIDATE_*
    process.env.IMHUB_CONSOLIDATE_TIMEOUT_MS = '45000'
    const c = resolveLlmGuardConfig('consolidate', {
      timeoutMs: 60_000, budgetUsd: 0.10, circuitThreshold: 3, circuitCooldownMs: 600_000,
    })
    expect(c.timeoutMs).toBe(45_000)
  })
})
