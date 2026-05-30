// v1.2.108 — tests the pure helpers behind the OpenAI-compat retry path
// (parseRetryAfter + computeBackoffMs). The end-to-end retry loop calls
// `fetch`/`sleep` and is left to integration coverage; here we lock the
// arithmetic so DeepSeek/Moonshot 429-with-Retry-After can't regress
// silently back to the old fixed-250ms behaviour.

import { describe, it, expect } from 'bun:test'
import { parseRetryAfter, computeBackoffMs } from '../../src/core/llm/openai-compat-provider.js'

describe('parseRetryAfter', () => {
  it('null / empty / whitespace → null', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('   ')).toBeNull()
  })

  it('delta-seconds integer → ms', () => {
    expect(parseRetryAfter('0')).toBe(0)
    expect(parseRetryAfter('1')).toBe(1000)
    expect(parseRetryAfter('30')).toBe(30_000)
    expect(parseRetryAfter('  15  ')).toBe(15_000)
  })

  it('delta-seconds fractional → ms (floored)', () => {
    expect(parseRetryAfter('1.5')).toBe(1500)
    expect(parseRetryAfter('0.25')).toBe(250)
  })

  it('HTTP-date in the future → positive ms', () => {
    // Use a generous interval — toUTCString() truncates to whole seconds,
    // and Date.parse re-rounds, so sub-second precision is unrecoverable.
    const t = new Date(Date.now() + 60_000).toUTCString()
    const got = parseRetryAfter(t)
    expect(got).not.toBeNull()
    // Window: anything roughly minute-ish from now (±2s covers truncation
    // + call-site clock drift, which is what matters for our use).
    expect(got as number).toBeGreaterThan(57_000)
    expect(got as number).toBeLessThanOrEqual(60_000)
  })

  it('HTTP-date in the past → clamped to 0', () => {
    const t = new Date(Date.now() - 10_000).toUTCString()
    expect(parseRetryAfter(t)).toBe(0)
  })

  it('garbage string → null', () => {
    expect(parseRetryAfter('not-a-thing')).toBeNull()
    expect(parseRetryAfter('-5')).toBeNull() // negative not allowed (matches RFC)
    expect(parseRetryAfter('nan')).toBeNull()
  })
})

describe('computeBackoffMs', () => {
  // Use a deterministic jitter so the math is exact.
  const noJitter = () => 1.0
  const minJitter = () => 0.8
  const maxJitter = () => 1.2

  it('exponential progression on a fresh failure (no Retry-After)', () => {
    // base=250, exp = base * 2^(attempt-1)
    expect(computeBackoffMs(1, null, { jitter: noJitter })).toBe(250)
    expect(computeBackoffMs(2, null, { jitter: noJitter })).toBe(500)
    expect(computeBackoffMs(3, null, { jitter: noJitter })).toBe(1_000)
    expect(computeBackoffMs(4, null, { jitter: noJitter })).toBe(2_000)
  })

  it('cap stops growth at MAX_BACKOFF_MS (default 30s)', () => {
    expect(computeBackoffMs(20, null, { jitter: noJitter })).toBe(30_000)
  })

  it('honors Retry-After as a hard floor', () => {
    // First attempt's exp = 250ms but server said 5s → wait 5s.
    expect(computeBackoffMs(1, 5_000, { jitter: noJitter })).toBe(5_000)
    // Even with full max jitter we still respect the server floor.
    expect(computeBackoffMs(1, 5_000, { jitter: maxJitter })).toBe(5_000)
  })

  it('Retry-After above cap is still capped at MAX_BACKOFF_MS', () => {
    expect(computeBackoffMs(1, 120_000, { jitter: noJitter })).toBe(30_000)
  })

  it('jitter pushes within the [0.8x, 1.2x] band of the exponential', () => {
    const lo = computeBackoffMs(3, null, { jitter: minJitter })
    const hi = computeBackoffMs(3, null, { jitter: maxJitter })
    expect(lo).toBe(800)   // 1000 * 0.8
    expect(hi).toBe(1_200) // 1000 * 1.2
  })

  it('attempt 0 / negative attempt → treated as attempt 1 (no panic)', () => {
    expect(computeBackoffMs(0, null, { jitter: noJitter })).toBe(250)
    expect(computeBackoffMs(-3, null, { jitter: noJitter })).toBe(250)
  })

  it('custom base / cap are honored', () => {
    expect(computeBackoffMs(1, null, { base: 100, cap: 500, jitter: noJitter })).toBe(100)
    expect(computeBackoffMs(5, null, { base: 100, cap: 500, jitter: noJitter })).toBe(500)
  })
})
