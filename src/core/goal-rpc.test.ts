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
import { beginGoalToolOperation, finishGoalToolOperation } from './goal-evidence.js'
import { appendProgress } from './goals.js'
import { buildTodoDispatcher, clearTodoForThread } from './llm/todo-dispatcher.js'

afterAll(() => {
  try { rmSync(_TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

const CTX = {
  platform: 'test',
  channelId: 'c',
  threadId: 't1',
  userId: 'u',
  callerAgent: 'native',
  traceId: 'trace-goal-rpc',
}

let evidenceSeq = 0
function completionPayload(
  recap: string,
  status: 'completed' | 'cancelled' = 'completed',
): Record<string, unknown> {
  const active = _activeGoalSnapshot(CTX)
  if (!active) throw new Error('expected active goal')
  const evidenceIds: string[] = []
  if (status === 'completed') {
    const op = beginGoalToolOperation({
      context: { goalId: active.id, goalVersion: active.version, traceId: CTX.traceId },
      toolCallId: `evidence-${++evidenceSeq}`,
      toolName: 'native_exec',
      args: { command: 'npm test' },
      kind: 'mutation_verification',
    })
    const evidence = finishGoalToolOperation(op, { ok: true, output: `verified ${active.title}` })
    if (!evidence) throw new Error('failed to issue evidence')
    evidenceIds.push(evidence.id)
  }
  return {
    goalId: active.id,
    goalVersion: active.version,
    evidenceIds,
    status,
    recap,
  }
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
    await handleGoalOp('complete_goal', completionPayload('test cleanup', 'cancelled'), CTX)
    // The probe's completion lands in the F9 idempotency cache; clear it so
    // the probe doesn't leak an `already_completed` into the test body.
    __resetCompletionCacheForTesting()
    return true
  }
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error(`SQLite is required by the Node persistence suite: ${r.error}`)
  }
  return false
}

describe('goal-rpc', () => {
  beforeEach(async () => {
    // Clean: complete any active goal between tests so each starts fresh
    const a = _activeGoalSnapshot(CTX)
    if (a) await handleGoalOp('complete_goal', completionPayload('test cleanup', 'cancelled'), CTX)
    __resetCompletionCacheForTesting()  // F9 idempotency cache must not leak across tests
    clearTodoForThread(`${CTX.platform}:${CTX.channelId}:${CTX.threadId}`)
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

  it('rejects unknown completion status instead of treating it as completed', async () => {
    const r = await handleGoalOp('complete_goal', {
      goalId: 1,
      goalVersion: 1,
      recap: 'invalid status must fail',
      status: 'done-ish',
    }, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('status')
  })

  // ── DB-backed tests (skipped under bun-no-better-sqlite3) ────────

  it('long_task registers a new goal', async () => {
    if (!(await dbAvailable())) return
    const r = await handleGoalOp('long_task', { goal: 'Ship v1.2.63' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(typeof r.result.goalId).toBe('number')
    expect(typeof r.result.goalVersion).toBe('number')
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
    const r = await handleGoalOp('complete_goal', completionPayload('shipped successfully'), CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.status).toBe('completed')
    expect(typeof r.result.goalVersion).toBe('number')
    expect(r.result.recap_length).toBe('shipped successfully'.length)
    expect(_activeGoalSnapshot(CTX)).toBeNull()
  })

  it('complete_goal with status=cancelled marks as cancelled', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Maybe cancel' }, CTX)
    const r = await handleGoalOp('complete_goal', completionPayload('test cleanup', 'cancelled'), CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.status).toBe('cancelled')
  })

  it('complete_goal is idempotent on retry within the window (F9)', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Idempotent task' }, CTX)
    const payload = completionPayload('done the first time')
    const first = await handleGoalOp('complete_goal', payload, CTX)
    expect(first.ok).toBe(true)
    // Retry: no active goal now, but the recent completion replays as ok.
    const retry = await handleGoalOp('complete_goal', payload, CTX)
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.result.already_completed).toBe(true)
    expect(retry.result.status).toBe('completed')
    const changedReplay = await handleGoalOp('complete_goal', {
      ...payload,
      recap: 'different replay payload',
    }, CTX)
    expect(changedReplay.ok).toBe(false)
    if (!changedReplay.ok) expect(changedReplay.error).toContain('differs')
  })

  it('a stale token cannot close a replacement goal', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Original objective' }, CTX)
    const stale = completionPayload('completed original objective')
    await handleGoalOp('long_task', { goal: 'Replacement objective', force: true }, CTX)

    const result = await handleGoalOp('complete_goal', stale, CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('STALE_GOAL')
    expect(_activeGoalSnapshot(CTX)?.title).toBe('Replacement objective')
  })

  it('progress added during a turn invalidates its old completion token', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Versioned objective' }, CTX)
    const stale = completionPayload('should now be stale')
    const active = _activeGoalSnapshot(CTX)!
    expect(appendProgress(active.id, 'user', 'acceptance criteria changed')).toBe(true)

    const result = await handleGoalOp('complete_goal', stale, CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('STALE_GOAL')
  })

  it('mutation invalidates prior evidence until a current verification succeeds', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Implement evidence objective' }, CTX)
    const active = _activeGoalSnapshot(CTX)!
    const oldOp = beginGoalToolOperation({
      context: { goalId: active.id, goalVersion: active.version, traceId: CTX.traceId },
      toolCallId: 'old-observation',
      toolName: 'native_read_file',
      args: { path: 'before.txt' },
      kind: 'observation',
    })
    const oldEvidence = finishGoalToolOperation(oldOp, {
      ok: true,
      output: 'Implement evidence objective before',
    })
    expect(oldEvidence).not.toBeNull()

    const mutation = beginGoalToolOperation({
      context: { goalId: active.id, goalVersion: active.version, traceId: CTX.traceId },
      toolCallId: 'mutation',
      toolName: 'native_write_file',
      args: { path: 'after.txt' },
      kind: 'mutation',
    })
    finishGoalToolOperation(mutation, { ok: true, output: 'wrote' })

    const staleResult = await handleGoalOp('complete_goal', {
      goalId: active.id,
      goalVersion: active.version,
      evidenceIds: [oldEvidence!.id],
      recap: 'attempt with stale evidence',
    }, CTX)
    expect(staleResult.ok).toBe(false)
    if (!staleResult.ok) expect(staleResult.error).toContain('INVALID_EVIDENCE')

    const verify = beginGoalToolOperation({
      context: { goalId: active.id, goalVersion: active.version, traceId: CTX.traceId },
      toolCallId: 'verification',
      toolName: 'native_exec',
      args: { command: 'npm test' },
      kind: 'mutation_verification',
    })
    const currentEvidence = finishGoalToolOperation(verify, { ok: true, output: 'tests passed' })
    const completed = await handleGoalOp('complete_goal', {
      goalId: active.id,
      goalVersion: active.version,
      evidenceIds: [currentEvidence!.id],
      recap: 'verified with passing tests',
    }, CTX)
    expect(completed.ok).toBe(true)
  })

  it('native completion refuses an explicitly incomplete todo checklist', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Todo objective' }, CTX)
    const dispatcher = buildTodoDispatcher(`${CTX.platform}:${CTX.channelId}:${CTX.threadId}`)
    await dispatcher({
      id: 'todo1',
      name: 'native_todo_write',
      arguments: { items: [{ content: 'run tests', status: 'in_progress' }] },
    }, new AbortController().signal)
    const payload = completionPayload('cannot finish with pending todo')
    const refused = await handleGoalOp('complete_goal', payload, CTX)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain('TODO_INCOMPLETE')
  })

  it('cannot bypass native evidence requirements by delegating completion', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Delegation-safe objective' }, CTX)
    const active = _activeGoalSnapshot(CTX)!
    const delegated = await handleGoalOp('complete_goal', {
      goalId: active.id,
      goalVersion: active.version,
      evidenceIds: [],
      recap: 'delegated without evidence',
    }, { ...CTX, callerAgent: 'claude-code' })
    expect(delegated.ok).toBe(false)
    if (!delegated.ok) expect(delegated.error).toContain('EVIDENCE_REQUIRED')
  })

  it('preserves CAS-only completion for goals created by non-native agents', async () => {
    if (!(await dbAvailable())) return
    const otherCtx = { ...CTX, callerAgent: 'claude-code' }
    const created = await handleGoalOp('long_task', { goal: 'Sidecar-owned objective' }, otherCtx)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.result.evidenceRequired).toBe(false)
    const completed = await handleGoalOp('complete_goal', {
      goalId: created.result.goalId,
      goalVersion: created.result.goalVersion,
      recap: 'completed by sidecar safely',
      evidenceIds: [],
    }, otherCtx)
    expect(completed.ok).toBe(true)
  })

  it('complete_goal refuses when no active goal', async () => {
    if (!(await dbAvailable())) return
    const r = await handleGoalOp('complete_goal', {
      goalId: 999999,
      goalVersion: 1,
      recap: 'attempting to complete nothing',
      evidenceIds: [],
    }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/STALE_GOAL/)
  })

  // v1.2.86 — recap is now required (≥10 chars). Structural error
  // (no-active-goal) takes precedence over recap validation, so we
  // register an active goal first to exercise the recap check.
  it('complete_goal refuses when recap is missing or too short', async () => {
    if (!(await dbAvailable())) return
    await handleGoalOp('long_task', { goal: 'Needs a proper recap' }, CTX)

    const active = _activeGoalSnapshot(CTX)!
    const missing = await handleGoalOp('complete_goal', {
      goalId: active.id,
      goalVersion: active.version,
    }, CTX)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toMatch(/recap/)

    const tooShort = await handleGoalOp('complete_goal', {
      goalId: active.id,
      goalVersion: active.version,
      recap: 'short',
    }, CTX)
    expect(tooShort.ok).toBe(false)
    if (!tooShort.ok) expect(tooShort.error).toMatch(/10 characters/)
  })
})
