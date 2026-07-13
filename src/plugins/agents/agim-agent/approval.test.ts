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
})
