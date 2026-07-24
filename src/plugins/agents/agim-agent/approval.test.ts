import { afterEach, describe, expect, it } from 'bun:test'
import { PLAN_EXIT_TOOL_NAME } from '../../../core/llm/plan-exit-dispatcher.js'
import { buildPiApprovalGate } from './approval.js'

const savedMode = process.env.AGIM_NATIVE_AGENT_MODE
const savedDeny = process.env.AGIM_NATIVE_AGENT_DENYLIST

afterEach(() => {
  if (savedMode === undefined) delete process.env.AGIM_NATIVE_AGENT_MODE
  else process.env.AGIM_NATIVE_AGENT_MODE = savedMode
  if (savedDeny === undefined) delete process.env.AGIM_NATIVE_AGENT_DENYLIST
  else process.env.AGIM_NATIVE_AGENT_DENYLIST = savedDeny
})

describe('pi-native plan-exit approval routing', () => {
  it('lets the dispatcher own the one-time prompt under normal policy', async () => {
    process.env.AGIM_NATIVE_AGENT_MODE = 'allow-list'
    delete process.env.AGIM_NATIVE_AGENT_DENYLIST
    const gate = buildPiApprovalGate(undefined, 'session-1')
    expect(await gate({ id: 'p1', name: PLAN_EXIT_TOOL_NAME, arguments: {} }, 0)).toBe('allow')
  })

  it('still honors operator deny-all and explicit deny-list', async () => {
    process.env.AGIM_NATIVE_AGENT_MODE = 'deny-all'
    let gate = buildPiApprovalGate(undefined, 'session-1')
    expect(await gate({ id: 'p1', name: PLAN_EXIT_TOOL_NAME, arguments: {} }, 0)).toBe('deny')

    process.env.AGIM_NATIVE_AGENT_MODE = 'allow-list'
    process.env.AGIM_NATIVE_AGENT_DENYLIST = PLAN_EXIT_TOOL_NAME
    gate = buildPiApprovalGate(undefined, 'session-2')
    expect(await gate({ id: 'p2', name: PLAN_EXIT_TOOL_NAME, arguments: {} }, 0)).toBe('deny')
  })

  it('auto-allows agim_todo_write so Plan can surface mid-turn without HITL', async () => {
    process.env.AGIM_NATIVE_AGENT_MODE = 'allow-list'
    delete process.env.AGIM_NATIVE_AGENT_DENYLIST
    const gate = buildPiApprovalGate(undefined, 'session-todo')
    expect(await gate({
      id: 't1',
      name: 'agim_todo_write',
      arguments: { items: [{ content: 'a', status: 'in_progress' }] },
    }, 0)).toBe('allow')
  })

  it('auto-allows side-effect-free builtins (agim_now etc.) without empty HITL cards', async () => {
    process.env.AGIM_NATIVE_AGENT_MODE = 'allow-list'
    delete process.env.AGIM_NATIVE_AGENT_DENYLIST
    const gate = buildPiApprovalGate(undefined, 'session-builtin')
    expect(await gate({ id: 'n1', name: 'agim_now', arguments: {} }, 0)).toBe('allow')
    expect(await gate({ id: 'n2', name: 'native_now', arguments: {} }, 0)).toBe('allow')
    expect(await gate({ id: 'e1', name: 'agim_echo', arguments: { text: 'hi' } }, 0)).toBe('allow')
    expect(await gate({ id: 'u1', name: 'agim_random_uuid', arguments: {} }, 0)).toBe('allow')
  })

  it('still denies builtins under deny-all / explicit deny-list', async () => {
    process.env.AGIM_NATIVE_AGENT_MODE = 'deny-all'
    let gate = buildPiApprovalGate(undefined, 'session-deny-all')
    expect(await gate({ id: 'n1', name: 'agim_now', arguments: {} }, 0)).toBe('deny')

    process.env.AGIM_NATIVE_AGENT_MODE = 'allow-list'
    process.env.AGIM_NATIVE_AGENT_DENYLIST = 'agim_now'
    gate = buildPiApprovalGate(undefined, 'session-deny-list')
    expect(await gate({ id: 'n2', name: 'agim_now', arguments: {} }, 0)).toBe('deny')
  })
})
