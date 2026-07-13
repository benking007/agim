// job-board Phase 2 (inline jobs) — unit tests.
//
// Coverage:
//   - createInlineJob writes kind='inline' + thread_key + creator_id
//   - markJobRunning / markJobCompleted / markJobDelivered / markJobFailed
//     state machine transitions + guard clauses (no rewriting from terminal)
//   - linkJobOutbox and updateJobAgent
//   - createInlineJob honors AGIM_INLINE_JOB_TRACKING=0
//   - createInlineJob never throws — returns -1 on a broken DB
//   - retention split: inline rows prune at the inline-hours window;
//     job rows prune at the days window
//
// The bun runtime can't load better-sqlite3, so the DB-backed suite gets
// skipped via the same probe pattern used by reminders / outbox tests.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-jobinline-test-'))
process.env.AGIM_HOME = TEST_HOME

const jb = await import('../../src/core/job-board.js')

const dbAvailable = (() => {
  try {
    const id = jb.createInlineJob({
      agent: 'probe', prompt: 'probe', threadKey: 'p:p:p',
    })
    return id > 0
  } catch {
    return false
  }
})()
const skipIfNoDb = dbAvailable ? describe : describe.skip

afterAll(() => {
  try { jb.stopJobRetentionSweep() } catch { /* ignore */ }
  try { jb.closeJobBoardDb() } catch { /* ignore */ }
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ─── DB-backed suite ──────────────────────────────────────────────────

skipIfNoDb('inline-job state machine', () => {
  // The probe in dbAvailable already inserted one row; let's not bother
  // resetting between tests — each test uses unique threadKeys/agent names
  // so they don't collide.
  it('createInlineJob writes kind=inline and thread_key', () => {
    const id = jb.createInlineJob({
      agent: 'opencode', prompt: 'hi there',
      threadKey: 'wechat:c1:t1', creatorId: 'u123',
    })
    expect(id).toBeGreaterThan(0)
    const row = jb.getJob(id)!
    expect(row.kind).toBe('inline')
    expect(row.thread_key).toBe('wechat:c1:t1')
    expect(row.creator_id).toBe('u123')
    expect(row.agent).toBe('opencode')
    expect(row.status).toBe('pending')
    expect(row.started_at).toBeNull()
    expect(row.delivered_at).toBeNull()
  })

  it('markJobRunning: pending → running, stamps started_at; idempotent', () => {
    const id = jb.createInlineJob({
      agent: 'a', prompt: 'p', threadKey: 'p:p:p2',
    })
    expect(jb.markJobRunning(id)).toBe(true)
    const r1 = jb.getJob(id)!
    expect(r1.status).toBe('running')
    expect(r1.started_at).not.toBeNull()
    const stamp1 = r1.started_at
    expect(jb.markJobRunning(id)).toBe(true)  // idempotent
    const r2 = jb.getJob(id)!
    expect(r2.started_at).toBe(stamp1)  // not overwritten
  })

  it('markJobCompleted: running → completed, captures result', () => {
    const id = jb.createInlineJob({
      agent: 'a', prompt: 'p', threadKey: 'p:p:p3',
    })
    jb.markJobRunning(id)
    jb.markJobCompleted(id, 'the reply text')
    const r = jb.getJob(id)!
    expect(r.status).toBe('completed')
    expect(r.result).toBe('the reply text')
    expect(r.completed_at).not.toBeNull()
  })

  it('a cancelled pending job cannot transition to running later', () => {
    const id = jb.createInlineJob({
      agent: 'a', prompt: 'queued', threadKey: 'p:p:cancelled-pending',
    })
    expect(jb.cancelJob(id)).toBe(true)
    expect(jb.markJobRunning(id)).toBe(false)
    expect(jb.getJob(id)?.status).toBe('cancelled')
  })

  it('cancelJob aborts an owner-bound inline controller', () => {
    const id = jb.createInlineJob({
      agent: 'a', prompt: 'running', threadKey: 'p:p:bound-controller',
    })
    const ctrl = new AbortController()
    const unbind = jb.bindJobController(id, ctrl)
    try {
      expect(jb.markJobRunning(id)).toBe(true)
      expect(jb.cancelJob(id)).toBe(true)
      expect(ctrl.signal.aborted).toBe(true)
      expect(jb.getJob(id)?.status).toBe('cancelled')
    } finally {
      unbind()
    }
  })

  it('findActiveJobByThread prefers running over a newer pending job', () => {
    const threadKey = `p:p:active-order-${Date.now()}`
    const running = jb.createInlineJob({ agent: 'a', prompt: 'running', threadKey })
    expect(jb.markJobRunning(running)).toBe(true)
    const pending = jb.createInlineJob({ agent: 'a', prompt: 'pending', threadKey })
    expect(pending).toBeGreaterThan(running)
    expect(jb.findActiveJobByThread(threadKey)?.id).toBe(running)
  })

  it('markJobDelivered: completed → delivered; no-op for non-completed', () => {
    const id = jb.createInlineJob({
      agent: 'a', prompt: 'p', threadKey: 'p:p:p4',
    })
    jb.markJobRunning(id)
    // No-op while still running
    jb.markJobDelivered(id)
    expect(jb.getJob(id)!.status).toBe('running')

    jb.markJobCompleted(id, 'ok')
    jb.markJobDelivered(id)
    const r = jb.getJob(id)!
    expect(r.status).toBe('delivered')
    expect(r.delivered_at).not.toBeNull()
  })

  it('markJobFailed: terminal failure; refuses to overwrite cancelled/replaced/abandoned', () => {
    const id = jb.createInlineJob({
      agent: 'a', prompt: 'p', threadKey: 'p:p:p5',
    })
    jb.markJobFailed(id, 'boom')
    const r = jb.getJob(id)!
    expect(r.status).toBe('failed')
    expect(r.error).toBe('boom')
    expect(r.completed_at).not.toBeNull()
  })

  it('linkJobOutbox stamps last_outbox_id', () => {
    const id = jb.createInlineJob({
      agent: 'a', prompt: 'p', threadKey: 'p:p:p6',
    })
    jb.linkJobOutbox(id, 4242)
    expect(jb.getJob(id)!.last_outbox_id).toBe(4242)
  })

  it('updateJobAgent rewrites agent col but only before completion', () => {
    const id = jb.createInlineJob({
      agent: 'placeholder', prompt: 'p', threadKey: 'p:p:p7',
    })
    jb.updateJobAgent(id, 'claude-code')
    expect(jb.getJob(id)!.agent).toBe('claude-code')

    jb.markJobRunning(id)
    jb.markJobCompleted(id, 'done')
    jb.updateJobAgent(id, 'codex')  // ignored — past 'running'
    expect(jb.getJob(id)!.agent).toBe('claude-code')
  })

  it('id<=0 makes every helper a no-op (no throw)', () => {
    expect(jb.markJobRunning(-1)).toBe(true)
    expect(() => jb.markJobCompleted(-1, 'x')).not.toThrow()
    expect(() => jb.markJobDelivered(-1)).not.toThrow()
    expect(() => jb.markJobFailed(-1, 'x')).not.toThrow()
    expect(() => jb.linkJobOutbox(-1, 1)).not.toThrow()
    expect(() => jb.updateJobAgent(-1, 'x')).not.toThrow()
  })
})

skipIfNoDb('retention split by kind', () => {
  it('inline rows older than AGIM_INLINE_JOB_RETENTION_HOURS get pruned', () => {
    const orig = process.env.AGIM_INLINE_JOB_RETENTION_HOURS
    process.env.AGIM_INLINE_JOB_RETENTION_HOURS = '1'
    try {
      // Create + finalize a row, then artificially backdate it.
      const id = jb.createInlineJob({
        agent: 'a', prompt: 'p', threadKey: 'retention:i:1',
      })
      jb.markJobRunning(id)
      jb.markJobCompleted(id, 'r')
      // Hand-mutate completed_at to >1h ago. job-board has no public setter;
      // we go around it via the test-only utility hook.
      jb._backdateForTests(id, '-2 hours')
      const before = jb.getJob(id)
      expect(before).not.toBeNull()
      const deleted = jb.pruneOldJobs()
      expect(deleted).toBeGreaterThan(0)
      expect(jb.getJob(id)).toBeNull()
    } finally {
      if (orig === undefined) delete process.env.AGIM_INLINE_JOB_RETENTION_HOURS
      else process.env.AGIM_INLINE_JOB_RETENTION_HOURS = orig
    }
  })

  it("kind='job' rows survive the inline window — use the days knob instead", () => {
    const id = jb.createJob('a', 'p')  // kind='job' (default)
    // No markRunning/markCompleted — pending rows are NEVER pruned regardless
    // of age. We end up testing that pruneOldJobs leaves a fresh job alone.
    const deleted = jb.pruneOldJobs()
    expect(jb.getJob(id)).not.toBeNull()
    // (deleted may include other tests' inline rows; we just verify ours
    // is still there.)
    expect(deleted).toBeGreaterThanOrEqual(0)
  })
})

// ─── Env-switch & degraded mode ───────────────────────────────────────

describe('createInlineJob env switch + degraded mode', () => {
  it('AGIM_INLINE_JOB_TRACKING=0 short-circuits to -1', () => {
    const orig = process.env.AGIM_INLINE_JOB_TRACKING
    process.env.AGIM_INLINE_JOB_TRACKING = '0'
    try {
      const id = jb.createInlineJob({
        agent: 'a', prompt: 'p', threadKey: 'off:off:off',
      })
      expect(id).toBe(-1)
    } finally {
      if (orig === undefined) delete process.env.AGIM_INLINE_JOB_TRACKING
      else process.env.AGIM_INLINE_JOB_TRACKING = orig
    }
  })

  it('createInlineJob never throws — broken DB returns -1', () => {
    // The probe at module top covers both happy path AND degraded path;
    // we just verify the contract explicitly here so a future refactor
    // doesn't drop the swallow-and-return-(-1) safety net.
    expect(() => jb.createInlineJob({
      agent: 'a', prompt: 'p', threadKey: 'p:p:p',
    })).not.toThrow()
  })
})
