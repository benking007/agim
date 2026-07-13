// Persistence + completion-gate coverage for todo-dispatcher.
// Under Bun, better-sqlite3 is unavailable so describeSqlite is skipped;
// the Node suite (AGIM_TEST_REQUIRE_SQLITE=1) exercises the real DB.

import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agim-todo-persist-'))
process.env.AGIM_HOME = home
process.env.AGIM_TODO_DB = join(home, 'todos.db')

const {
  buildTodoDispatcher,
  clearTodoForThread,
  closeTodoDbForTesting,
  evaluateTodoCompletionGate,
  getTodoForThread,
  getTodoSnapshot,
  getTodoTools,
  _truncateTodosForTests,
} = await import('../../src/core/llm/todo-dispatcher.js')
const { resolveCompleteGoalToolTimeoutMs, resolveGoalConfirmationTimeoutMs } =
  await import('../../src/core/goal-rpc.js')

afterAll(() => {
  closeTodoDbForTesting()
  rmSync(home, { recursive: true, force: true })
})

const describeSqlite = process.env.AGIM_TEST_REQUIRE_SQLITE === '1' ? describe : describe.skip
const SIG = new AbortController().signal

describe('todo completion gate', () => {
  beforeEach(() => {
    clearTodoForThread('gate-a')
  })

  it('allows completion when no checklist was ever written', () => {
    expect(getTodoSnapshot('gate-a')).toEqual({ status: 'absent' })
    expect(evaluateTodoCompletionGate('gate-a')).toEqual({ ok: true })
  })

  it('refuses completion while checklist items remain incomplete', async () => {
    const d = buildTodoDispatcher('gate-a')
    await d({
      id: 't1',
      name: 'native_todo_write',
      arguments: { items: [{ content: 'still open', status: 'pending' }] },
    }, SIG)
    const gate = evaluateTodoCompletionGate('gate-a')
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toContain('TODO_INCOMPLETE')
  })

  it('allows completion after every checklist item is completed', async () => {
    const d = buildTodoDispatcher('gate-a')
    await d({
      id: 't2',
      name: 'native_todo_write',
      arguments: { items: [{ content: 'done', status: 'completed' }] },
    }, SIG)
    expect(evaluateTodoCompletionGate('gate-a')).toEqual({ ok: true })
  })

  it('allows completion after an explicit empty checklist clear', async () => {
    const d = buildTodoDispatcher('gate-a')
    await d({
      id: 't3a',
      name: 'native_todo_write',
      arguments: { items: [{ content: 'x', status: 'pending' }] },
    }, SIG)
    await d({
      id: 't3b',
      name: 'native_todo_write',
      arguments: { items: [] },
    }, SIG)
    expect(getTodoSnapshot('gate-a')).toEqual({ status: 'present', items: [] })
    expect(evaluateTodoCompletionGate('gate-a')).toEqual({ ok: true })
  })
})

describe('complete_goal confirmation timeout helpers', () => {
  it('keeps the tool wall budget above the confirmation timeout', () => {
    const confirm = resolveGoalConfirmationTimeoutMs()
    const tool = resolveCompleteGoalToolTimeoutMs()
    expect(tool).toBe(confirm + 60_000)
    expect(tool).toBeGreaterThan(60_000)
  })

  it('exposes mcp__agim__complete_goal with a raised timeoutMs', async () => {
    const { getAgimTools } = await import('../../src/core/llm/agim-dispatcher.js')
    const tool = getAgimTools().find((t) => t.name === 'mcp__agim__complete_goal')
    expect(tool?.timeoutMs).toBe(resolveCompleteGoalToolTimeoutMs())
  })

  it('todo tool still advertises a short timeout', () => {
    expect(getTodoTools()[0]?.timeoutMs).toBe(5_000)
  })
})

describeSqlite('todo sqlite persistence', () => {
  beforeEach(() => {
    _truncateTodosForTests()
  })

  it('survives a simulated process restart (close + reopen)', async () => {
    const d = buildTodoDispatcher('persist-a')
    await d({
      id: 'p1',
      name: 'native_todo_write',
      arguments: {
        items: [
          { content: 'keep me', status: 'in_progress' },
          { content: 'also keep', status: 'pending' },
        ],
      },
    }, SIG)
    expect(getTodoForThread('persist-a')).toHaveLength(2)

    // Simulate restart: drop memory + close the sqlite handle, then read again.
    closeTodoDbForTesting()
    expect(getTodoSnapshot('persist-a')).toEqual({
      status: 'present',
      items: [
        { content: 'keep me', status: 'in_progress' },
        { content: 'also keep', status: 'pending' },
      ],
    })
    const gate = evaluateTodoCompletionGate('persist-a')
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.error).toContain('TODO_INCOMPLETE')
  })
})
