import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-goal-evidence-'))
process.env.AGIM_HOME = TEST_HOME
process.env.AGIM_GOALS_DB = join(TEST_HOME, 'goals.db')

const {
  _truncateForTests,
  getGoalById,
  getGoalsDatabaseForLedger,
  setActiveGoal,
} = await import('../../src/core/goals.js')
const {
  beginGoalToolOperation,
  __resetGoalEvidenceKeyForTesting,
  classifyGoalEvidence,
  completeGoalCas,
  finishGoalToolOperation,
  getGoalEvidenceReview,
  hashWorkspaceScope,
  isDetachedGoalCommand,
  reconcileInterruptedGoalOperations,
} = await import('../../src/core/goal-evidence.js')
const { agimToolToPi } = await import('../../src/plugins/agents/agim-agent/tool-bridge.js')

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

const describeSqlite = process.env.AGIM_TEST_REQUIRE_SQLITE === '1' ? describe : describe.skip

describeSqlite('goal evidence ledger', () => {
  it('tool bridge returns an opaque evidence capability for successful observations', async () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'bridge',
      userId: 'u',
      title: 'bridge evidence',
    })
    if (!goal) throw new Error('goal unavailable')
    const tool = agimToolToPi(
      {
        name: 'agim_read_file',
        description: 'read',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      async () => ({ text: 'bridge evidence file contents', isError: false, source: 'fs' }),
      {
        traceId: 'trace-bridge',
        parallelSafe: () => true,
        goalEvidence: {
          goalId: goal.id,
          goalVersion: goal.version,
          traceId: 'trace-bridge',
        },
      },
    )
    const result = await tool.execute('bridge-call', { path: 'file.txt' }, new AbortController().signal)
    const text = result.content.find((item) => item.type === 'text')?.text ?? ''
    expect(text).toContain('bridge evidence file contents')
    expect(text).toMatch(/\[agim evidence observation: ev1_/)
  })

  it('tool bridge blocks a duplicate mutation before dispatch replay', async () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'bridge-mutation',
      userId: 'u',
      title: 'dedupe bridge mutation',
    })
    if (!goal) throw new Error('goal unavailable')
    let dispatches = 0
    const tool = agimToolToPi(
      {
        name: 'agim_write_file',
        description: 'write',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      async () => {
        dispatches += 1
        return { text: 'wrote', isError: false, source: 'fs' }
      },
      {
        traceId: 'trace-mutation',
        goalEvidence: {
          goalId: goal.id,
          goalVersion: goal.version,
          traceId: 'trace-mutation',
        },
      },
    )
    await tool.execute('same-call', {}, new AbortController().signal)
    await expect(tool.execute('same-call', {}, new AbortController().signal)).rejects.toThrow(/ledger unavailable/)
    expect(dispatches).toBe(1)
    expect(getGoalById(goal.id)?.mutationEpoch).toBe(1)
  })

  it('tool bridge blocks detached exec while a versioned goal is active', async () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'detached',
      userId: 'u',
      title: 'no detached writes',
    })
    if (!goal) throw new Error('goal unavailable')
    let dispatches = 0
    let asked = 0
    const tool = agimToolToPi(
      {
        name: 'agim_exec',
        description: 'exec',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      async () => {
        dispatches += 1
        return { text: 'started', isError: false }
      },
      {
        goalEvidence: {
          goalId: goal.id,
          goalVersion: goal.version,
          traceId: 'trace-detached',
        },
        // Even if containment is missing, detached must never escalate to a card.
        confirmUnconfinedExec: async () => {
          asked += 1
          return 'allow'
        },
      },
    )
    await expect(tool.execute(
      'detached-call',
      { command: 'nohup worker &' },
      new AbortController().signal,
    )).rejects.toThrow(/detached/)
    expect(dispatches).toBe(0)
    expect(asked).toBe(0)
  })

  it('tool bridge asks explicit approval for unconfined exec when goal is active', async () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'unconfined',
      userId: 'u',
      title: 'approve unconfined',
    })
    if (!goal) throw new Error('goal unavailable')
    let dispatches = 0
    const seen: Array<Record<string, unknown>> = []
    const tool = agimToolToPi(
      {
        name: 'agim_exec',
        description: 'exec',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      async () => {
        dispatches += 1
        return { text: 'ok', isError: false }
      },
      {
        goalEvidence: {
          goalId: goal.id,
          goalVersion: goal.version,
          traceId: 'trace-unconfined',
        },
        confirmUnconfinedExec: async (args) => {
          seen.push(args)
          return 'allow'
        },
      },
    )
    // Force the missing-bwrap branch regardless of host tooling.
    const prev = process.env.AGIM_EXEC_SANDBOX
    process.env.AGIM_EXEC_SANDBOX = 'off'
    try {
      const out = await tool.execute(
        'unconfined-call',
        { command: 'echo hi' },
        new AbortController().signal,
      )
      expect(dispatches).toBe(1)
      expect(seen).toEqual([{ command: 'echo hi' }])
      expect(JSON.stringify(out.content)).toContain('ok')
    } finally {
      if (prev === undefined) delete process.env.AGIM_EXEC_SANDBOX
      else process.env.AGIM_EXEC_SANDBOX = prev
    }
  })

  it('tool bridge denies unconfined exec when operator rejects approval', async () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'deny-unconfined',
      userId: 'u',
      title: 'deny unconfined',
    })
    if (!goal) throw new Error('goal unavailable')
    let dispatches = 0
    const tool = agimToolToPi(
      {
        name: 'agim_exec',
        description: 'exec',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      async () => {
        dispatches += 1
        return { text: 'ok', isError: false }
      },
      {
        goalEvidence: {
          goalId: goal.id,
          goalVersion: goal.version,
          traceId: 'trace-deny',
        },
        confirmUnconfinedExec: async () => 'deny',
      },
    )
    const prev = process.env.AGIM_EXEC_SANDBOX
    process.env.AGIM_EXEC_SANDBOX = 'off'
    try {
      await expect(tool.execute(
        'deny-call',
        { command: 'echo hi' },
        new AbortController().signal,
      )).rejects.toThrow(/denied|unconfined/)
      expect(dispatches).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.AGIM_EXEC_SANDBOX
      else process.env.AGIM_EXEC_SANDBOX = prev
    }
  })

  it('invalidates old evidence after mutation and accepts current verification', () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 't',
      userId: 'u',
      title: 'ship verified change',
    })
    if (!goal) throw new Error('goal unavailable')
    const context = { goalId: goal.id, goalVersion: goal.version, traceId: 'trace-root' }
    const observation = beginGoalToolOperation({
      context,
      toolCallId: 'read-before',
      toolName: 'agim_read_file',
      args: { path: 'a.txt' },
      kind: 'observation',
    })
    const oldEvidence = finishGoalToolOperation(observation, {
      ok: true,
      output: 'ship verified change before',
    })
    expect(oldEvidence?.id).toMatch(/^ev1_/)

    const mutation = beginGoalToolOperation({
      context,
      toolCallId: 'write',
      toolName: 'agim_write_file',
      args: { path: 'a.txt' },
      kind: 'mutation',
    })
    expect(finishGoalToolOperation(mutation, { ok: true, output: 'wrote' })).toBeNull()
    expect(getGoalById(goal.id)?.mutationEpoch).toBe(1)

    const stale = completeGoalCas({
      platform: 'test',
      channelId: 'c',
      threadId: 't',
      userId: 'u',
      goalId: goal.id,
      goalVersion: goal.version,
      evidenceIds: [oldEvidence!.id],
      recap: 'stale evidence must fail',
      status: 'completed',
      traceId: 'trace-root',
    })
    expect(stale.ok).toBe(false)

    const verification = beginGoalToolOperation({
      context,
      toolCallId: 'verify',
      toolName: 'agim_exec',
      args: { command: 'npm test' },
      kind: 'mutation_verification',
    })
    const currentEvidence = finishGoalToolOperation(verification, { ok: true, output: 'all tests passed' })
    expect(currentEvidence?.kind).toBe('verification')
    expect(currentEvidence?.epoch).toBe(2)

    const completed = completeGoalCas({
      platform: 'test',
      channelId: 'c',
      threadId: 't',
      userId: 'u',
      goalId: goal.id,
      goalVersion: goal.version,
      evidenceIds: [currentEvidence!.id],
      recap: 'verified implementation completed',
      status: 'completed',
      traceId: 'trace-root',
    })
    expect(completed.ok).toBe(true)
    if (completed.ok) expect(completed.alreadyCompleted).toBe(false)
  })

  it('requires two distinct observations when no verifier evidence exists', () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'research',
      userId: 'u',
      title: 'research with corroboration',
    })
    if (!goal) throw new Error('goal unavailable')
    const operation = beginGoalToolOperation({
      context: { goalId: goal.id, goalVersion: goal.version, traceId: 'trace-research' },
      toolCallId: 'search-one',
      toolName: 'agim_web_search',
      args: { query: 'research corroboration' },
      kind: 'observation',
    })
    const evidence = finishGoalToolOperation(operation, {
      ok: true,
      output: 'research corroboration from one source',
    })
    const result = completeGoalCas({
      platform: 'test',
      channelId: 'c',
      threadId: 'research',
      userId: 'u',
      goalId: goal.id,
      goalVersion: goal.version,
      evidenceIds: [evidence!.id],
      recap: 'only one source found',
      status: 'completed',
      traceId: 'trace-research',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('EVIDENCE_INSUFFICIENT')
  })

  it('does not issue evidence for observations unrelated to the goal', () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'semantic',
      userId: 'u',
      title: 'research battery recycling',
    })
    if (!goal) throw new Error('goal unavailable')
    const operation = beginGoalToolOperation({
      context: { goalId: goal.id, goalVersion: goal.version, traceId: 'trace-semantic' },
      toolCallId: 'unrelated',
      toolName: 'agim_web_search',
      args: { query: 'football scores' },
      kind: 'observation',
    })
    expect(finishGoalToolOperation(operation, {
      ok: true,
      output: 'latest football league results',
    })).toBeNull()
  })

  it('rejects forged and cross-goal evidence capabilities', () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'forged',
      userId: 'u',
      title: 'reject forged evidence',
    })
    if (!goal) throw new Error('goal unavailable')
    const forged = completeGoalCas({
      platform: 'test',
      channelId: 'c',
      threadId: 'forged',
      userId: 'u',
      goalId: goal.id,
      goalVersion: goal.version,
      evidenceIds: [`ev1_${'a'.repeat(43)}`],
      recap: 'forged evidence rejected',
      status: 'completed',
      traceId: 'trace-root',
    })
    expect(forged.ok).toBe(false)

    const other = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'other-thread',
      userId: 'u',
      title: 'other goal',
    })
    if (!other) throw new Error('other goal unavailable')
    const op = beginGoalToolOperation({
      context: { goalId: other.id, goalVersion: other.version, traceId: 'other-trace' },
      toolCallId: 'read',
      toolName: 'agim_read_file',
      args: { path: 'x' },
      kind: 'observation',
    })
    const evidence = finishGoalToolOperation(op, { ok: true, output: 'other goal evidence' })
    const crossGoal = completeGoalCas({
      platform: 'test',
      channelId: 'c',
      threadId: 'forged',
      userId: 'u',
      goalId: goal.id,
      goalVersion: goal.version,
      evidenceIds: [evidence!.id],
      recap: 'cross trace evidence rejected',
      status: 'completed',
      traceId: 'trace-root',
    })
    expect(crossGoal.ok).toBe(false)
  })

  it('stores only hashes, never raw evidence tokens or tool data', () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'privacy',
      userId: 'u',
      title: 'private evidence',
    })
    if (!goal) throw new Error('goal unavailable')
    const op = beginGoalToolOperation({
      context: { goalId: goal.id, goalVersion: goal.version, traceId: 'trace-private' },
      toolCallId: 'private-call',
      toolName: 'agim_read_file',
      args: { path: '/secret/private.txt' },
      kind: 'observation',
    })
    const evidence = finishGoalToolOperation(op, {
      ok: true,
      output: 'private evidence secret-output-value',
    })
    const review = getGoalEvidenceReview({
      platform: 'test',
      channelId: 'c',
      threadId: 'privacy',
      userId: 'u',
      goalId: goal.id,
      goalVersion: goal.version,
      evidenceIds: [evidence!.id],
      traceId: 'trace-private',
    })
    expect(review?.recentToolCalls[0]?.preview).toContain('server-attested')
    expect(review?.recentToolCalls[0]?.preview).not.toContain('secret-output-value')
    const dbBytes = readFileSync(process.env.AGIM_GOALS_DB!)
    expect(dbBytes.includes(Buffer.from(evidence!.id))).toBe(false)
    expect(dbBytes.includes(Buffer.from('/secret/private.txt'))).toBe(false)
    expect(dbBytes.includes(Buffer.from('secret-output-value'))).toBe(false)
  })

  it('conservatively invalidates evidence after an uncertain mutation timeout', () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'uncertain',
      userId: 'u',
      title: 'uncertain mutation',
    })
    if (!goal) throw new Error('goal unavailable')
    const operation = beginGoalToolOperation({
      context: { goalId: goal.id, goalVersion: goal.version, traceId: 'trace' },
      toolCallId: 'timeout-write',
      toolName: 'agim_write_file',
      args: { path: 'x' },
      kind: 'mutation',
    })
    finishGoalToolOperation(operation, {
      ok: false,
      uncertain: true,
      output: 'tool timed out',
    })
    expect(getGoalById(goal.id)?.mutationEpoch).toBe(1)
  })

  it('rejects duplicate mutation operation ids before a side effect can replay', () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'duplicate',
      userId: 'u',
      title: 'dedupe mutation',
    })
    if (!goal) throw new Error('goal unavailable')
    const input = {
      context: { goalId: goal.id, goalVersion: goal.version, traceId: 'trace' },
      toolCallId: 'same-call-id',
      toolName: 'agim_write_file',
      args: { path: 'x' },
      kind: 'mutation' as const,
    }
    expect(beginGoalToolOperation(input)).not.toBeNull()
    expect(() => beginGoalToolOperation(input)).toThrow(/duplicate goal tool operation/)
  })

  it('reconciles mutation intents owned by a dead process', () => {
    _truncateForTests()
    const goal = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'orphan',
      userId: 'u',
      title: 'recover orphan mutation',
    })
    if (!goal) throw new Error('goal unavailable')
    const db = getGoalsDatabaseForLedger()
    if (!db) throw new Error('goals db unavailable')
    db.prepare(`
      INSERT INTO goal_ledger (
        op_hash, goal_id, goal_version, epoch, kind, state, workspace_scope,
        trace_hash, tool_call_hash, tool_name, input_hash, owner_id, owner_pid, owner_start
      ) VALUES ('orphan-op', ?, ?, 0, 'mutation', 'started', '',
        'trace', 'call', 'agim_write_file', 'input', 'dead-owner', ?, 'reused-pid-start')
    `).run(goal.id, goal.version, process.pid)
    __resetGoalEvidenceKeyForTesting()

    expect(reconcileInterruptedGoalOperations()).toBe(1)
    expect(getGoalById(goal.id)?.mutationEpoch).toBe(1)
    const state = db.prepare(`SELECT state FROM goal_ledger WHERE op_hash = 'orphan-op'`)
      .get() as { state: string }
    expect(state.state).toBe('unknown')
  })

  it('scopes mutation epoch bumps to the shared workspace', () => {
    _truncateForTests()
    const scopeA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const scopeB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const goalA = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'scope-a',
      userId: 'u',
      title: 'workspace A goal',
      workspaceScope: scopeA,
    })
    const goalB = setActiveGoal({
      platform: 'test',
      channelId: 'c',
      threadId: 'scope-b',
      userId: 'u',
      title: 'workspace B goal',
      workspaceScope: scopeB,
    })
    if (!goalA || !goalB) throw new Error('goals unavailable')

    const mutation = beginGoalToolOperation({
      context: {
        goalId: goalA.id,
        goalVersion: goalA.version,
        traceId: 'trace-a',
        workspaceScope: scopeA,
      },
      toolCallId: 'write-a',
      toolName: 'agim_write_file',
      args: { path: 'a.txt' },
      kind: 'mutation',
    })
    expect(finishGoalToolOperation(mutation, { ok: true, output: 'wrote a' })).toBeNull()
    expect(getGoalById(goalA.id)?.mutationEpoch).toBe(1)
    expect(getGoalById(goalB.id)?.mutationEpoch).toBe(0)

    const observation = beginGoalToolOperation({
      context: {
        goalId: goalB.id,
        goalVersion: goalB.version,
        traceId: 'trace-b',
        workspaceScope: scopeB,
      },
      toolCallId: 'read-b',
      toolName: 'agim_read_file',
      args: { path: 'b.txt' },
      kind: 'observation',
    })
    const evidence = finishGoalToolOperation(observation, {
      ok: true,
      output: 'workspace B goal contents',
    })
    expect(evidence?.id).toMatch(/^ev1_/)
    expect(evidence?.epoch).toBe(0)
  })
})

describe('goal evidence classification', () => {
  it('classifies control, observation, mutation, and strict verifier commands', () => {
    expect(classifyGoalEvidence('agim_todo_write', {}, false)).toBe('control')
    expect(classifyGoalEvidence('agim_read_file', {}, true)).toBe('observation')
    expect(classifyGoalEvidence('agim_write_file', {}, false)).toBe('mutation')
    expect(classifyGoalEvidence('agim_exec', { command: 'npm test' }, false)).toBe('mutation_verification')
    expect(classifyGoalEvidence('agim_exec', { command: 'npm test && rm -rf out' }, false)).toBe('mutation')
    expect(classifyGoalEvidence('agim_exec', { command: 'npm test\ntrue' }, false)).toBe('mutation')
    expect(classifyGoalEvidence('mcp__external__read', {}, true)).toBe('mutation')
    expect(isDetachedGoalCommand({ command: 'nohup worker &' })).toBe(true)
    expect(isDetachedGoalCommand({ command: 'npm test' })).toBe(false)
  })

  it('hashes workspace scopes opaquely and treats empty cwd as unknown', () => {
    expect(hashWorkspaceScope('')).toBe('')
    expect(hashWorkspaceScope(undefined)).toBe('')
    const a = hashWorkspaceScope('/tmp/ws-a')
    const b = hashWorkspaceScope('/tmp/ws-b')
    expect(a).toHaveLength(32)
    expect(b).toHaveLength(32)
    expect(a).not.toBe(b)
    expect(a).toBe(hashWorkspaceScope('/tmp/ws-a'))
  })
})
