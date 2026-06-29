// IMPORTANT: goals.ts caches the db path via `process.env.AGIM_GOALS_DB`
// at module-load time (a top-level `const`). Set the test path here,
// BEFORE the import below — otherwise the production AGIM_HOME path is
// captured and the test pollutes (or fails to open) the operator's
// real goals.db.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const _TMP = mkdtempSync(join(tmpdir(), 'agim-goal-rpc-'))
process.env.AGIM_GOALS_DB = join(_TMP, 'goals.db')

import { describe, it, expect, afterAll, beforeEach } from 'bun:test'
import { handleGoalOp, _activeGoalSnapshot, __resetCompletionCacheForTesting } from './goal-rpc.js'

afterAll(() => {
  try { rmSync(_TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

const CTX = {
  platform: 'test',
  channelId: 'c',
  threadId: 't1',
  userId: 'u',
  callerAgent: 'native',
}

/**
 * better-sqlite3 doesn't load under bun (known issue
 * https://github.com/oven-sh/bun/issues/4290 — see goals.test.ts for
 * the same constraint). When goals.ts's getDb() returns null,
 * setActiveGoal returns null and these RPC calls all fail with
 * "failed to register goal (db unavailable …)". We probe once and
 * skip the substantive paths when the DB isn't there — same pattern
 * goals.test.ts uses. The shape tests (refuse empty goal / unknown
 * op / missing ctx) don't touch the DB and run regardless.
 */
async function dbAvailable(): Promise<boolean> {
  const r = await handleGoalOp('long_task', { goal: 'probe' }, CTX)
  if (r.ok) {
    // clean up the probe row
    await handleGoalOp('complete_goal', { status: 'cancelled', recap: 'test cleanup' }, CTX)
    // The probe's completion lands in the F9 idempotency cache; clear it so
    // the probe doesn't leak an `already_completed` into the test body.
    __resetCompletionCacheForTesting()
    return true
  }
  return false
}

describe('goal-rpc', () => {
  beforeEach(async () => {
    // Clean: complete any active goal between tests so each starts fresh
    const a = _activeGoalSnapshot(CTX)
    if (a) await handleGoalOp('complete_goal', { status: 'cancelled', recap: 'test cleanup' }, CTX)
    __resetCompletionCacheForTesting()  // F9 idempotency cache must not leak across tests
  })

  // ── Shape tests (db-independent) ─────────────────────────────────

  it('long_task refuses empty goal', async () => {
    const r = await handleGoalOp('long_task', { goal: '' }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/non-empty/)
  })

  it('rejects unknown op', async () => {
    // @ts-expect-error — testing runtime rejection of bad ops
    const r = await handleGoalOp('not_an_op', {}, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/unknown goal op/)
  })

  it('refuses when ctx missing identity fields', async () => {
    const r = await handleGoalOp('long_task', { goal: 'x' },
      { platform: '', channelId: 'c', threadId: '', userId: '' })
    expect(r.ok).toBe(false)
  })

  // ── DB-backed tests (skipped under bun-no-better-sqlite3) ────────

  it('long_task registers a new goal', async () => {
    if (!(await dbAvailable())) return
    const r = await handleGoalOp('long_task', { goal: 'Ship v1.2.63' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(typeof r.result.goalId).toBe('number')
    expect(r.result.title).toBe('Ship v1.2.63')
    expect(r.result.status).toBe('active')
    expect(r.result.previous_active_goal_paused).toBeNull()
  })

  it('long_task with summary stores body', async () => {
    if (!(await dbAvailable())) return
    const r = await handleGoalOp('long_task',
      { goal: 'Track market', summary: 'daily 9am brief' }, CTX)
    expect(r.ok).toBe(true)
    const active = _activeGoalSnapshot(CTX)
    expect(active?.body).toBe('daily 9am brief')
  })

  it('long_task refuses to override an active goal without force (F7)', async () => {
    if (!(await dbAvailable())) return
    const r1 = await handleGoalOp('long_task', { goal: 'First objective' }, CTX)
    expect(r1.ok).toBe(true)
    const refused = await handleGoalOp('long_task', { goal: 'Second objective' }, CTX)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toMatch(/already exists|force/)
    // The prior goal must remain active (not paused) after a refusal.
    expect(_activeGoalSnapshot(CTX)?.title).toBe('First objective')
  })

  it('long_task with force:true pauses the prior active goal (F7)', async () => {
    if (!(await dbAvailable())) return
    const r1 = await handleGoalOp('long_task', { goal: 'First objective' }, CTX)
    expect(r1.ok).toBe(true)
    const r2 = await handleGoalOp('long_task', { goal: 'Second objective', force: true }, CTX)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    const prior = r2.result.previous_active_goal_paused as { id: number; title: string } | null
    expect(prior).not.toBeNull()
    expect(prior?.title).toBe('First objective')
    const active = _activeGoalSnapshot(CTX)
    expect(active?.title).toBe('Second objective')
  })

  it('complete_goal marks the active goal completed', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Task to finish' }, CTX)
    const r = await handleGoalOp('complete_goal', { recap: 'shipped successfully' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.status).toBe('completed')
    expect(r.result.recap_length).toBe('shipped successfully'.length)
    expect(_activeGoalSnapshot(CTX)).toBeNull()
  })

  it('complete_goal with status=cancelled marks as cancelled', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Maybe cancel' }, CTX)
    const r = await handleGoalOp('complete_goal', { status: 'cancelled', recap: 'test cleanup' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.status).toBe('cancelled')
  })

  it('complete_goal is idempotent on retry within the window (F9)', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Idempotent task' }, CTX)
    const first = await handleGoalOp('complete_goal', { recap: 'done the first time' }, CTX)
    expect(first.ok).toBe(true)
    // Retry: no active goal now, but the recent completion replays as ok.
    const retry = await handleGoalOp('complete_goal', { recap: 'done the first time' }, CTX)
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.result.already_completed).toBe(true)
    expect(retry.result.status).toBe('completed')
  })

  it('complete_goal refuses when no active goal', async () => {
    if (!(await dbAvailable())) return
    const r = await handleGoalOp('complete_goal', { recap: 'attempting to complete nothing' }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/no active goal/)
  })

  // v1.2.86 — recap is now required (≥10 chars). Structural error
  // (no-active-goal) takes precedence over recap validation, so we
  // register an active goal first to exercise the recap check.
  it('complete_goal refuses when recap is missing or too short', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Needs a proper recap' }, CTX)

    const missing = await handleGoalOp('complete_goal', {}, CTX)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toMatch(/recap/)

    const tooShort = await handleGoalOp('complete_goal', { recap: 'short' }, CTX)
    expect(tooShort.ok).toBe(false)
    if (!tooShort.ok) expect(tooShort.error).toMatch(/10 characters/)
  })
})
