import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  evaluateTodoMutationGate,
  evaluateTodoPresenceGate,
  isTodoGateExemptTool,
  isTodoGateOn,
} from '../../src/core/llm/todo-gate.js'
import {
  buildTodoDispatcher,
  clearTodoForThread,
} from '../../src/core/llm/todo-dispatcher.js'

const KEY = 'test:c:todo-gate'

describe('todo-gate', () => {
  const prev = process.env.AGIM_TODO_GATE

  beforeEach(() => {
    process.env.AGIM_TODO_GATE = 'on'
    clearTodoForThread(KEY)
  })

  afterEach(() => {
    clearTodoForThread(KEY)
    if (prev === undefined) delete process.env.AGIM_TODO_GATE
    else process.env.AGIM_TODO_GATE = prev
  })

  it('is on by default and off via AGIM_TODO_GATE=off', () => {
    delete process.env.AGIM_TODO_GATE
    expect(isTodoGateOn()).toBe(true)
    process.env.AGIM_TODO_GATE = 'off'
    expect(isTodoGateOn()).toBe(false)
  })

  it('exempts read / ask / todo tools', () => {
    expect(isTodoGateExemptTool('agim_read_file')).toBe(true)
    expect(isTodoGateExemptTool('native_read_file')).toBe(true)
    expect(isTodoGateExemptTool('agim_todo_write')).toBe(true)
    expect(isTodoGateExemptTool('mcp__agim__ask_user')).toBe(true)
    expect(isTodoGateExemptTool('agim_git_status')).toBe(true)
    expect(isTodoGateExemptTool('agim_diagnostics')).toBe(true)
    expect(isTodoGateExemptTool('agim_exec')).toBe(false)
    expect(isTodoGateExemptTool('agim_write_file')).toBe(false)
    expect(isTodoGateExemptTool('agim_git_commit')).toBe(false)
    expect(isTodoGateExemptTool('agim_quality_gate')).toBe(false)
  })

  it('blocks mutations without a checklist and allows after write', async () => {
    expect(evaluateTodoMutationGate(KEY, 'agim_exec').ok).toBe(false)
    expect(evaluateTodoMutationGate(KEY, 'agim_read_file').ok).toBe(true)

    const d = buildTodoDispatcher(KEY)
    await d({
      id: '1',
      name: 'agim_todo_write',
      arguments: { items: [{ content: 'do work', status: 'in_progress' }] },
    }, new AbortController().signal)

    expect(evaluateTodoMutationGate(KEY, 'agim_exec').ok).toBe(true)
    expect(evaluateTodoPresenceGate(KEY).ok).toBe(true)
  })

  it('presence gate requires a non-empty checklist when on', () => {
    expect(evaluateTodoPresenceGate(KEY).ok).toBe(false)
    process.env.AGIM_TODO_GATE = 'off'
    expect(evaluateTodoPresenceGate(KEY).ok).toBe(true)
  })
})
