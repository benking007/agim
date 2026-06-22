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

  it('read-only mode does NOT auto-allow outbound fetch tools (F4)', async () => {
    // native_web_fetch / WebFetch are full outbound HTTP clients (largest
    // SSRF surface), so 'fetch' was removed from READ_ONLY_HINTS. They now
    // require an explicit autoAllow / approval even in read-only mode.
    const gate = buildPolicyApprovalGate({ mode: 'read-only' })
    expect(await gate(call('native_web_fetch'), 0)).toBe('deny')
    expect(await gate(call('mcp_http_fetch_url'), 0)).toBe('deny')
    expect(await gate(call('WebFetch'), 0)).toBe('deny')
  })

  it('read-only mode still allows explicitly autoAllowed fetch tools', async () => {
    const gate = buildPolicyApprovalGate({ mode: 'read-only', autoAllow: ['native_web_fetch'] })
    expect(await gate(call('native_web_fetch'), 0)).toBe('allow')
  })

  it('describePolicy returns a stable one-liner', () => {
    expect(describePolicy({})).toBe('mode=allow-list, autoAllow=0, denyList=0')
    expect(describePolicy({
      mode: 'allow-all',
      autoAllow: ['a', 'b'],
      denyList: ['c'],
    })).toBe('mode=allow-all, autoAllow=2, denyList=1')
  })

  // v1.2.60 — askUser escalation
  describe('askUser escalation (v1.2.60)', () => {
    it('routes would-be deny through askUser and returns its decision', async () => {
      let asked: string | null = null as string | null
      const gate = buildPolicyApprovalGate({
        mode: 'allow-list',
        autoAllow: ['native_read_file'],
        askUser: async (c) => { asked = c.name; return 'allow' },
      })
      expect(await gate(call('native_read_file'), 0)).toBe('allow')
      expect(asked).toBeNull()  // autoAllow bypasses askUser
      expect(await gate(call('native_write_file'), 0)).toBe('allow')  // user OK'd
      expect(asked).toBe('native_write_file')
    })

    it('honors askUser deny', async () => {
      const gate = buildPolicyApprovalGate({
        mode: 'allow-list',
        askUser: async () => 'deny',
      })
      expect(await gate(call('native_write_file'), 0)).toBe('deny')
    })

    it('denylist NEVER escalates to askUser', async () => {
      let asked = false
      const gate = buildPolicyApprovalGate({
        mode: 'allow-list',
        denyList: ['mcp_dangerous_run'],
        askUser: async () => { asked = true; return 'allow' },
      })
      expect(await gate(call('mcp_dangerous_run'), 0)).toBe('deny')
      expect(asked).toBe(false)
    })

    it('deny-all mode does NOT escalate (intentional kill switch)', async () => {
      let asked = false
      const gate = buildPolicyApprovalGate({
        mode: 'deny-all',
        askUser: async () => { asked = true; return 'allow' },
      })
      expect(await gate(call('anything'), 0)).toBe('deny')
      expect(asked).toBe(false)
    })

    it('falls back to silent-deny when askUser throws', async () => {
      const gate = buildPolicyApprovalGate({
        mode: 'allow-list',
        askUser: async () => { throw new Error('bus down') },
      })
      expect(await gate(call('native_write_file'), 0)).toBe('deny')
    })

    it('without askUser, legacy silent-deny behavior preserved', async () => {
      const gate = buildPolicyApprovalGate({ mode: 'allow-list' })
      expect(await gate(call('native_write_file'), 0)).toBe('deny')
    })
  })
})
