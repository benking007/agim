// Unit tests for the exponential-with-jitter Backoff helper used by the
// telegram + wechat polling-loop reconnect paths (M9, code-review-2026-05-06).
//
// Determinism: every test that asserts an exact value pins the RNG via
// the `random` option. Jitter sampling is otherwise non-deterministic by
// design (defends against fleet thundering-herd) — those tests assert
// only the bound `[exp * (1 - jitter), exp * (1 + jitter)]`.

import { describe, it, expect } from 'bun:test'
import { Backoff } from '../../src/utils/backoff'

describe('Backoff (M9)', () => {
  describe('exponential schedule, no jitter', () => {
    it('starts at baseMs and doubles each call', () => {
      const b = new Backoff({ baseMs: 1000, capMs: 1_000_000, jitter: 0 })
      expect(b.nextDelayMs()).toBe(1000)   // 1000 * 2^0
      expect(b.nextDelayMs()).toBe(2000)   // 2^1
      expect(b.nextDelayMs()).toBe(4000)   // 2^2
      expect(b.nextDelayMs()).toBe(8000)   // 2^3
    })

    it('caps at capMs once the exponent exceeds it', () => {
      const b = new Backoff({ baseMs: 1000, capMs: 5000, jitter: 0 })
      expect(b.nextDelayMs()).toBe(1000)   // 1000
      expect(b.nextDelayMs()).toBe(2000)   // 2000
      expect(b.nextDelayMs()).toBe(4000)   // 4000
      expect(b.nextDelayMs()).toBe(5000)   // would be 8000, capped to 5000
      expect(b.nextDelayMs()).toBe(5000)   // stays capped
      expect(b.nextDelayMs()).toBe(5000)
    })

    it('reset() returns the schedule to baseMs', () => {
      const b = new Backoff({ baseMs: 1000, capMs: 1_000_000, jitter: 0 })
      b.nextDelayMs()
      b.nextDelayMs()
      b.nextDelayMs()
      expect(b.currentAttempt()).toBe(3)
      b.reset()
      expect(b.currentAttempt()).toBe(0)
      expect(b.nextDelayMs()).toBe(1000)
    })
  })

  describe('jitter', () => {
    it('with jitter=0.5, delays land in [exp * 0.5, exp * 1.5]', () => {
      // Pin the RNG to the jitter boundary values to assert the math.
      // factor = 1 + (random() * 2 - 1) * jitter
      //   random() = 0   → factor = 0.5
      //   random() = 1   → factor = 1.5
      //   random() = 0.5 → factor = 1.0  (no jitter applied)
      const seq = [0, 1, 0.5]
      let i = 0
      const b = new Backoff({ baseMs: 1000, capMs: 1_000_000, jitter: 0.5, random: () => seq[i++] })
      expect(b.nextDelayMs()).toBe(500)    // exp=1000, factor=0.5 → 500
      expect(b.nextDelayMs()).toBe(3000)   // exp=2000, factor=1.5 → 3000
      expect(b.nextDelayMs()).toBe(4000)   // exp=4000, factor=1.0 → 4000
    })

    it('jitter never produces a negative delay', () => {
      // Even with random()=0 (factor=0) the floor at 0 protects callers.
      const b = new Backoff({ baseMs: 1000, capMs: 1_000_000, jitter: 1, random: () => 0 })
      // factor = 1 + (0 * 2 - 1) * 1 = 0  → delay = 0
      expect(b.nextDelayMs()).toBe(0)
    })

    it('clamps jitter input to [0, 1]', () => {
      // jitter=2 should clamp to 1 — at random()=0, factor=0; random()=1, factor=2
      const seq = [0, 1]
      let i = 0
      const b = new Backoff({ baseMs: 1000, capMs: 1_000_000, jitter: 2, random: () => seq[i++] })
      expect(b.nextDelayMs()).toBe(0)
      expect(b.nextDelayMs()).toBe(4000)  // exp=2000, factor=2 → 4000

      const b2 = new Backoff({ baseMs: 1000, capMs: 1_000_000, jitter: -1 })
      // negative jitter clamps to 0 → deterministic
      expect(b2.nextDelayMs()).toBe(1000)
      expect(b2.nextDelayMs()).toBe(2000)
    })

    it('many random samples stay within the jitter bound', () => {
      const b = new Backoff({ baseMs: 1000, capMs: 1000, jitter: 0.5 })  // pin exp=1000
      const lo = 500
      const hi = 1500
      for (let i = 0; i < 200; i++) {
        const d = b.nextDelayMs()
        expect(d).toBeGreaterThanOrEqual(lo)
        expect(d).toBeLessThanOrEqual(hi)
      }
    })
  })

  describe('defaults', () => {
    it('defaults are 1s base / 60s cap / 0.5 jitter', () => {
      // Pin random=0.5 so factor=1, surfacing the unjittered schedule.
      const b = new Backoff({ random: () => 0.5 })
      expect(b.nextDelayMs()).toBe(1000)
      expect(b.nextDelayMs()).toBe(2000)
      expect(b.nextDelayMs()).toBe(4000)
      expect(b.nextDelayMs()).toBe(8000)
      expect(b.nextDelayMs()).toBe(16000)
      expect(b.nextDelayMs()).toBe(32000)
      expect(b.nextDelayMs()).toBe(60000)  // 64000 capped
      expect(b.nextDelayMs()).toBe(60000)  // stays at cap
    })
  })

  describe('edge cases', () => {
    it('baseMs=0 yields 0 forever', () => {
      const b = new Backoff({ baseMs: 0, capMs: 1000, jitter: 0 })
      expect(b.nextDelayMs()).toBe(0)
      expect(b.nextDelayMs()).toBe(0)
      expect(b.nextDelayMs()).toBe(0)
    })

    it('capMs lower than baseMs is bumped to baseMs', () => {
      // Otherwise nextDelayMs would yield baseMs once then drop to capMs,
      // an inversion of the intended schedule. Constructor enforces
      // capMs >= baseMs.
      const b = new Backoff({ baseMs: 5000, capMs: 1000, jitter: 0 })
      expect(b.nextDelayMs()).toBe(5000)
      expect(b.nextDelayMs()).toBe(5000)  // stays at the corrected cap
    })
  })
})
