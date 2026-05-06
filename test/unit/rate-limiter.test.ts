// Unit tests for the per-user/agent token-bucket rate limiter

import { describe, it, expect } from 'bun:test'
import { RateLimiter } from '../../src/core/rate-limiter'

describe('RateLimiter cleanup behavior (H4)', () => {
  it('size() reflects the bucket map after distinct keys are tracked', () => {
    const rl = new RateLimiter(10, 60_000, 5)
    expect(rl.size()).toBe(0)
    rl.allow('a')
    rl.allow('b')
    rl.allow('c')
    expect(rl.size()).toBe(3)
  })

  it('cleanup(idleMs) drops buckets idle longer than the threshold', () => {
    const rl = new RateLimiter(10, 60_000, 5)
    rl.allow('a')
    rl.allow('b')
    expect(rl.size()).toBe(2)
    // -1ms threshold → "anything not actively in the future is idle". The
    // strict `>` means cleanup(0) on freshly-touched buckets is a no-op
    // (zero ms have elapsed yet); cleanup(-1) is the "force flush" knob.
    const dropped = rl.cleanup(-1)
    expect(dropped).toBe(2)
    expect(rl.size()).toBe(0)
  })

  it('cleanup spares a bucket touched within the idle window', () => {
    const rl = new RateLimiter(10, 60_000, 5)
    rl.allow('still-active')
    expect(rl.size()).toBe(1)
    // 60s threshold against a bucket touched ms ago → no drop.
    const dropped = rl.cleanup(60_000)
    expect(dropped).toBe(0)
    expect(rl.size()).toBe(1)
  })

  it('rapid allow() calls do not trigger an unintended sweep within the window', () => {
    // The opportunistic sweep only fires after AUTO_CLEANUP_EVERY_MS (30 min).
    // 200 allow() calls in microseconds must not drop any buckets — otherwise
    // a fresh user would be served from a freshly-created bucket on every
    // second call, defeating the rate limit.
    const rl = new RateLimiter(1000, 60_000, 1000)
    for (let i = 0; i < 200; i++) {
      rl.allow(`user-${i}`)
    }
    expect(rl.size()).toBe(200)
  })
})

describe('RateLimiter', () => {
  it('starts at full burst capacity', () => {
    const rl = new RateLimiter(10, 60_000, 5)
    expect(rl.remaining('user-a')).toBe(5)
  })

  it('decrements per allowed request and rejects when exhausted', () => {
    const rl = new RateLimiter(10, 60_000, 3)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(false)
    expect(rl.remaining('u')).toBe(0)
  })

  it('isolates buckets per key', () => {
    const rl = new RateLimiter(10, 60_000, 1)
    expect(rl.allow('alice')).toBe(true)
    expect(rl.allow('alice')).toBe(false)
    // bob gets his own bucket
    expect(rl.allow('bob')).toBe(true)
  })

  it('refills tokens after a full interval elapses', async () => {
    const rl = new RateLimiter(2, 50, 2)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(true)
    expect(rl.allow('u')).toBe(false)
    await new Promise((r) => setTimeout(r, 80))
    expect(rl.allow('u')).toBe(true)
  })

  it('does not exceed burst on long idle (refill is clamped)', async () => {
    const rl = new RateLimiter(10, 20, 5)
    rl.allow('u') // burn one to force a bucket entry
    await new Promise((r) => setTimeout(r, 200))
    // After 10 intervals, theoretical refill would be 100 tokens; clamped to burst.
    expect(rl.remaining('u')).toBeLessThanOrEqual(5)
  })

  it('status() reports configured rate and interval', () => {
    const rl = new RateLimiter(7, 30_000, 9)
    const s = rl.status('u')
    expect(s.rate).toBe(7)
    expect(s.intervalSec).toBe(30)
    expect(s.remaining).toBe(9)
  })

  it('nextAllowAt returns now() when bucket has tokens', () => {
    const rl = new RateLimiter(5, 60_000, 5)
    const now = Date.now()
    const next = rl.nextAllowAt('u')
    expect(Math.abs(next - now)).toBeLessThan(50)
  })

  it('nextAllowAt advances by intervalMs once the bucket is drained', () => {
    const rl = new RateLimiter(1, 1_000, 1)
    rl.allow('u')
    expect(rl.allow('u')).toBe(false)
    const next = rl.nextAllowAt('u')
    expect(next - Date.now()).toBeGreaterThan(500)
    expect(next - Date.now()).toBeLessThanOrEqual(1_000)
  })

  it('cleanup drops idle buckets', async () => {
    const rl = new RateLimiter(10, 60_000, 5)
    rl.allow('a')
    rl.allow('b')
    await new Promise((r) => setTimeout(r, 30))
    const dropped = rl.cleanup(20)
    expect(dropped).toBe(2)
    // After cleanup, remaining should reflect a fresh bucket.
    expect(rl.remaining('a')).toBe(5)
  })
})
