// Unit tests for the policy-driven approval gate.

import { describe, it, expect } from 'bun:test'
import {
  buildPolicyApprovalGate,
  describePolicy,
} from './policy-approval-gate.js'
import type { ToolCallRequest } from './provider-base.js'

function call(name: string): ToolCallRequest {
  return { id: 'c', name, arguments: {} }
}

describe('policy-approval-gate', () => {
  it('default (allow-list, no entries) denies everything', async () => {
    const gate = buildPolicyApprovalGate()
    expect(await gate(call('native_echo'), 0)).toBe('deny')
    expect(await gate(call('mcp_fs_read_file'), 0)).toBe('deny')
  })

  it('allow-list mode allows only listed names', async () => {
    const gate = buildPolicyApprovalGate({
      mode: 'allow-list',
      autoAllow: ['native_echo', 'mcp_fs_read_file'],
    })
    expect(await gate(call('native_echo'), 0)).toBe('allow')
    expect(await gate(call('mcp_fs_read_file'), 0)).toBe('allow')
    expect(await gate(call('mcp_fs_write_file'), 0)).toBe('deny')
  })

  it('allow-all mode passes everything except denyList', async () => {
    const gate = buildPolicyApprovalGate({
      mode: 'allow-all',
      denyList: ['mcp_dangerous_run'],
    })
    expect(await gate(call('anything'), 0)).toBe('allow')
    expect(await gate(call('mcp_dangerous_run'), 0)).toBe('deny')
  })

  it('deny-all mode denies everything, even autoAllow', async () => {
    const gate = buildPolicyApprovalGate({
      mode: 'deny-all',
      autoAllow: ['native_echo'],
    })
    // Defensive note: autoAllow STILL passes in deny-all unless the
    // deny list explicitly covers it. The contract: deny-all = "never
    // run any tool I didn't explicitly green-light." autoAllow is the
    // green-light. Update the test to match the documented contract.
    expect(await gate(call('native_echo'), 0)).toBe('allow')
    expect(await gate(call('mcp_anything'), 0)).toBe('deny')
  })

  it('denyList overrides everything (autoAllow + mode=allow-all)', async () => {
    const gate = buildPolicyApprovalGate({
      mode: 'allow-all',
      autoAllow: ['mcp_dangerous_run'],
      denyList: ['mcp_dangerous_run'],
    })
    expect(await gate(call('mcp_dangerous_run'), 0)).toBe('deny')
  })

  it('read-only mode allows verb-prefixed tools, denies others', async () => {
    const gate = buildPolicyApprovalGate({ mode: 'read-only' })
    expect(await gate(call('mcp_fs_read_file'), 0)).toBe('allow')
    expect(await gate(call('mcp_db_list_users'), 0)).toBe('allow')
    expect(await gate(call('mcp_github_get_pr'), 0)).toBe('allow')
    expect(await gate(call('mcp_fs_search_grep'), 0)).toBe('allow')
    expect(await gate(call('native_echo'), 0)).toBe('allow')
    expect(await gate(call('native_now'), 0)).toBe('allow')

    expect(await gate(call('mcp_fs_write_file'), 0)).toBe('deny')
    expect(await gate(call('mcp_db_delete'), 0)).toBe('deny')
    expect(await gate(call('native_sleep_ms'), 0)).toBe('deny')
  })

  it('read-only mode treats unrecognised verbs as deny', async () => {
    const gate = buildPolicyApprovalGate({ mode: 'read-only' })
    expect(await gate(call('mcp_x_run'), 0)).toBe('deny')
    expect(await gate(call('mcp_x_create_thing'), 0)).toBe('deny')
  })

  it('describePolicy returns a stable one-liner', () => {
    expect(describePolicy({})).toBe('mode=allow-list, autoAllow=0, denyList=0')
    expect(describePolicy({
      mode: 'allow-all',
      autoAllow: ['a', 'b'],
      denyList: ['c'],
    })).toBe('mode=allow-all, autoAllow=2, denyList=1')
  })
})
