// Outbox — unit tests.
//
// Strategy: pin AGIM_HOME to a temp dir so each test file gets a fresh
// outbox.db that's wiped between tests via _resetOutboxForTests. The
// outbox module's helper opens the DB lazily on first call.
//
// bun + better-sqlite3 native binding sometimes can't load. We probe via
// enqueue() and skip the DB-backed suite if it returns -1.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-outbox-test-'))
process.env.AGIM_HOME = TEST_HOME

const outbox = await import('../../src/core/outbox.js')

// Probe: if the native binding isn't loadable, every DB-backed test
// is no-op. Skip the whole DB suite rather than show a wall of red.
const dbAvailable = (() => {
  try {
    const id = outbox.enqueue({
      threadKey: 'probe:probe:probe',
      platform: 'probe', channelId: 'probe', threadId: 'probe',
      payload: 'probe', kind: 'text',
    })
    return id > 0
  } catch {
    return false
  }
})()
const skipIfNoDb = dbAvailable ? describe : describe.skip

afterAll(() => {
  try {
    outbox.stopOutboxRetentionSweep()
    outbox.closeOutboxDb()
  } catch { /* ignore */ }
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

skipIfNoDb('outbox CRUD', () => {
  beforeEach(() => { outbox._resetOutboxForTests() })

  it('enqueue → pickPending returns the row', () => {
    const id = outbox.enqueue({
      threadKey: 't1', platform: 'p', channelId: 'c', threadId: 't',
      payload: 'hello', kind: 'text',
    })
    expect(id).toBeGreaterThan(0)
    const rows = outbox.pickPending(10)
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].status).toBe('pending')
    expect(rows[0].payload).toBe('hello')
  })

  it('markDelivered transitions and stops pickPending from returning it', () => {
    const id = outbox.enqueue({
      threadKey: 't2', platform: 'p', channelId: 'c', threadId: 't',
      payload: 'a', kind: 'text',
    })
    outbox.markDelivered(id)
    expect(outbox.pickPending(10)).toEqual([])
    const row = outbox.getOutbox(id)!
    expect(row.status).toBe('delivered')
    expect(row.delivered_at).not.toBeNull()
    expect(row.attempts).toBe(1)
  })

  it('markFailed schedules next attempt with backoff and keeps row pending', () => {
    const id = outbox.enqueue({
      threadKey: 't3', platform: 'p', channelId: 'c', threadId: 't',
      payload: 'x', kind: 'text',
    })
    const res = outbox.markFailed(id, 'boom')
    expect(res.gaveUp).toBe(false)
    expect(res.attempts).toBe(1)
    const row = outbox.getOutbox(id)!
    expect(row.status).toBe('pending')
    expect(row.last_error).toBe('boom')
    expect(row.next_attempt_at).not.toBeNull()
    // pickPending excludes rows whose next_attempt_at is in the future
    expect(outbox.pickPending(10)).toEqual([])
  })

  it('markFailed transitions to giving_up after MAX_ATTEMPTS', () => {
    const id = outbox.enqueue({
      threadKey: 't4', platform: 'p', channelId: 'c', threadId: 't',
      payload: 'y', kind: 'text',
    })
    let gaveUp = false
    for (let i = 0; i < outbox.MAX_ATTEMPTS; i += 1) {
      const res = outbox.markFailed(id, `err${i}`)
      gaveUp = res.gaveUp
    }
    expect(gaveUp).toBe(true)
    const row = outbox.getOutbox(id)!
    expect(row.status).toBe('giving_up')
    expect(row.attempts).toBe(outbox.MAX_ATTEMPTS)
    expect(outbox.pickPending(10)).toEqual([])
  })

  it('retryGivingUp resurrects a dead row to pending with attempts reset', () => {
    const id = outbox.enqueue({
      threadKey: 't5', platform: 'p', channelId: 'c', threadId: 't',
      payload: 'z', kind: 'text',
    })
    for (let i = 0; i < outbox.MAX_ATTEMPTS; i += 1) outbox.markFailed(id, 'e')
    expect(outbox.getOutbox(id)!.status).toBe('giving_up')
    const ok = outbox.retryGivingUp(id)
    expect(ok).toBe(true)
    const row = outbox.getOutbox(id)!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.last_error).toBeNull()
    // next_attempt_at is "now" so pickPending should see it
    const picked = outbox.pickPending(10)
    expect(picked.map((r) => r.id)).toContain(id)
  })

  it('retryGivingUp returns false for a pending row (no-op)', () => {
    const id = outbox.enqueue({
      threadKey: 't6', platform: 'p', channelId: 'c', threadId: 't',
      payload: 'w', kind: 'text',
    })
    expect(outbox.retryGivingUp(id)).toBe(false)
  })

  it('priority=high is picked before priority=normal', () => {
    const lo = outbox.enqueue({
      threadKey: 'a', platform: 'p', channelId: 'c', threadId: 't',
      payload: 'low', kind: 'text', priority: 'normal',
    })
    const hi = outbox.enqueue({
      threadKey: 'a', platform: 'p', channelId: 'c', threadId: 't',
      payload: 'high', kind: 'text', priority: 'high',
    })
    const rows = outbox.pickPending(10)
    // The high row was inserted later but should come first.
    expect(rows[0].id).toBe(hi)
    expect(rows[1].id).toBe(lo)
  })

  it('getOutboxStats counts by status', () => {
    const a = outbox.enqueue({ threadKey: 'x', platform: 'p', channelId: 'c', threadId: 't', payload: 'a', kind: 'text' })
    const b = outbox.enqueue({ threadKey: 'x', platform: 'p', channelId: 'c', threadId: 't', payload: 'b', kind: 'text' })
    outbox.markDelivered(a)
    for (let i = 0; i < outbox.MAX_ATTEMPTS; i += 1) outbox.markFailed(b, 'e')
    const stats = outbox.getOutboxStats()
    expect(stats.delivered).toBe(1)
    expect(stats.giving_up).toBe(1)
    expect(stats.pending).toBe(0)
  })

  it('listOutbox filters by status and threadKey', () => {
    const a = outbox.enqueue({ threadKey: 'TA', platform: 'p', channelId: 'c', threadId: 't', payload: 'a', kind: 'text' })
    outbox.enqueue({ threadKey: 'TB', platform: 'p', channelId: 'c', threadId: 't', payload: 'b', kind: 'text' })
    outbox.markDelivered(a)

    const onlyDelivered = outbox.listOutbox({ status: 'delivered' })
    expect(onlyDelivered.length).toBe(1)
    expect(onlyDelivered[0].id).toBe(a)

    const onlyTA = outbox.listOutbox({ threadKey: 'TA' })
    expect(onlyTA.length).toBe(1)
    expect(onlyTA[0].thread_key).toBe('TA')
  })
})

// Even without the native binding, the public API must not throw. This
// reproduces what cli.ts / message-sink will see on a degraded host.
describe('outbox degraded-mode contract', () => {
  it('enqueue/pickPending/getOutboxStats never throw even on a fresh module', () => {
    expect(() => outbox.pickPending(5)).not.toThrow()
    expect(() => outbox.getOutboxStats()).not.toThrow()
    expect(() => outbox.listOutbox({ limit: 5 })).not.toThrow()
  })
})
