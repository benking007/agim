// M-N2 — event-bus uses a fixed-size ring buffer for the "recent events"
// log. The previous design used `recent.push(ev)` followed by
// `while (recent.length > CAP) recent.shift()`, which is O(n) per
// publish once the cap is reached. Under approval storms / audit bursts
// (1k events / sec at agent boot) the shift cost was measurable.

import { describe, it, expect, beforeEach } from 'bun:test'
import { eventBus } from '../../src/core/event-bus'
import type { JobEvent } from '../../src/core/event-bus'

function jobEvent(id: number): JobEvent {
  return { type: 'job', phase: 'created', jobId: id, agent: 'stub' }
}

describe('eventBus ring buffer (M-N2)', () => {
  beforeEach(() => {
    // Cast to access the test-only helper.
    ;(eventBus as unknown as { _resetRecent(): void })._resetRecent()
  })

  it('returns inserted events oldest-first while buffer is still filling', () => {
    eventBus.publish(jobEvent(1))
    eventBus.publish(jobEvent(2))
    eventBus.publish(jobEvent(3))
    const out = eventBus.getRecent() as JobEvent[]
    expect(out.map((e) => e.jobId)).toEqual([1, 2, 3])
  })

  it('caps stored events at RECENT_CAP', () => {
    const CAP = (eventBus.constructor as unknown as { RECENT_CAP: number }).RECENT_CAP
    for (let i = 0; i < CAP + 50; i++) eventBus.publish(jobEvent(i))
    const out = eventBus.getRecent() as JobEvent[]
    expect(out.length).toBe(CAP)
  })

  it('drops oldest events on overflow (FIFO order preserved)', () => {
    const CAP = (eventBus.constructor as unknown as { RECENT_CAP: number }).RECENT_CAP
    // Push CAP + 5 events; the first 5 (ids 0..4) should fall off.
    for (let i = 0; i < CAP + 5; i++) eventBus.publish(jobEvent(i))
    const out = eventBus.getRecent() as JobEvent[]
    expect(out[0].jobId).toBe(5)
    expect(out[out.length - 1].jobId).toBe(CAP + 4)
  })

  it('handles multiple full-cycle wraps cleanly', () => {
    const CAP = (eventBus.constructor as unknown as { RECENT_CAP: number }).RECENT_CAP
    // Two full rotations + a partial — final state must be a contiguous
    // strictly-increasing slice of the most recent CAP ids.
    const total = CAP * 2 + 37
    for (let i = 0; i < total; i++) eventBus.publish(jobEvent(i))
    const out = eventBus.getRecent() as JobEvent[]
    expect(out.length).toBe(CAP)
    expect(out[0].jobId).toBe(total - CAP)
    expect(out[out.length - 1].jobId).toBe(total - 1)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].jobId).toBe(out[i - 1].jobId + 1)
    }
  })

  it('publish remains O(1) — no per-publish shift cost', () => {
    // Smoke test: 10k pushes should comfortably fit a few ms on any
    // reasonable machine. We assert "under 100ms" to leave plenty of
    // headroom for CI noise but still catch a regression to O(n) push.
    const start = process.hrtime.bigint()
    for (let i = 0; i < 10_000; i++) eventBus.publish(jobEvent(i))
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    expect(elapsedMs).toBeLessThan(100)
  })

  it('listeners still receive every published event', () => {
    const seen: number[] = []
    const handler = (e: unknown): void => {
      const ev = e as JobEvent
      if (ev.type === 'job') seen.push(ev.jobId)
    }
    eventBus.on('event', handler)
    try {
      for (let i = 0; i < 10; i++) eventBus.publish(jobEvent(i))
      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    } finally {
      eventBus.off('event', handler)
    }
  })
})
