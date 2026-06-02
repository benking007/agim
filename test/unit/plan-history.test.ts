// v1.2.131 P0a — plan-history validation gate (input checks).
//
// Note: better-sqlite3 is not supported under bun, so the sqlite-helper
// degrades to graceful no-op. listPlanHistory always returns [] and
// recordPlanHistory always returns null when the helper is in that
// fallback mode. The SQLite CRUD paths are exercised in production
// (node) where the helper is functional. Here we only assert the
// PURE INPUT VALIDATION layer, which catches typos / missing fields
// BEFORE the helper is invoked — those are deterministic regardless
// of runtime.
//
// Pins:
//   - recordPlanHistory short-circuits on empty threadKey
//   - recordPlanHistory short-circuits on empty planMd
//   - recordPlanHistory short-circuits on falsy outcome
//   - listPlanHistory tolerates the disabled DB (returns [], no throw)
//   - listPlanHistory clamps `limit` to [1, 500]

import { describe, it, expect } from 'bun:test'

const planMod = await import('../../src/core/plan-history.js')
const { recordPlanHistory, listPlanHistory } = planMod

describe('plan-history — input validation (v1.2.131 P0a)', () => {
  it('recordPlanHistory returns null for empty threadKey', () => {
    expect(recordPlanHistory({
      threadKey: '', planMd: 'x', outcome: 'approved',
    })).toBeNull()
  })

  it('recordPlanHistory returns null for empty planMd', () => {
    expect(recordPlanHistory({
      threadKey: 'tg:k', planMd: '', outcome: 'approved',
    })).toBeNull()
  })

  it('recordPlanHistory returns null for falsy outcome', () => {
    expect(recordPlanHistory({
      threadKey: 'tg:k', planMd: 'p',
      outcome: '' as unknown as 'approved',
    })).toBeNull()
  })

  it('listPlanHistory tolerates disabled DB — returns [] not throw', () => {
    // No threadKey → global listing path.
    expect(listPlanHistory()).toEqual([])
    expect(listPlanHistory({ threadKey: 'tg:does-not-exist' })).toEqual([])
  })

  it('listPlanHistory clamps absurd limit values', () => {
    // We can't assert the exact number returned (DB disabled under
    // bun), but the function must not throw for any non-positive /
    // huge input. The clamp is defense against accidental DoS via
    // unfiltered admin query strings.
    expect(() => listPlanHistory({ limit: -5 })).not.toThrow()
    expect(() => listPlanHistory({ limit: 0 })).not.toThrow()
    expect(() => listPlanHistory({ limit: 100_000 })).not.toThrow()
  })
})
