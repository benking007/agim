// 4.3 — clock abstraction primitive.
//
// The wrapper exists so tests can pin time without monkey-patching
// Date.now() globally. This test verifies the freeze/restore contract;
// the consumer migration to nowMs() is deferred to follow-up commits
// per the file header.

import { describe, it, expect, afterEach } from 'bun:test'
import { nowMs, setNow, isFrozen } from '../../src/core/clock'

afterEach(() => { setNow(null) })  // always restore live time, even on failure

describe('clock', () => {
  it('nowMs returns live Date.now() by default', () => {
    const before = Date.now()
    const t = nowMs()
    const after = Date.now()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after)
  })

  it('setNow(fixed) freezes the reading', () => {
    setNow(1_700_000_000_000)
    expect(nowMs()).toBe(1_700_000_000_000)
    expect(nowMs()).toBe(1_700_000_000_000) // idempotent reads
  })

  it('setNow(null) restores live time', () => {
    setNow(42)
    expect(nowMs()).toBe(42)
    setNow(null)
    const live = nowMs()
    // We can't assert an exact value but live time is far past 42 ms.
    expect(live).toBeGreaterThan(1_500_000_000_000)
  })

  it('isFrozen reflects whether the clock is pinned', () => {
    expect(isFrozen()).toBe(false)
    setNow(0)
    expect(isFrozen()).toBe(true)
    setNow(null)
    expect(isFrozen()).toBe(false)
  })

  it('setNow(0) is a valid frozen value (not null-equivalent)', () => {
    setNow(0)
    expect(nowMs()).toBe(0)
    expect(isFrozen()).toBe(true)
  })
})
