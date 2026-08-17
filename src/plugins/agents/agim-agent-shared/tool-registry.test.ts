// Unit tests for the native tool registry (Stage 2 / T2).
//
// Locks the invariants that replaced three hand-maintained parallel lists:
//   - one assembly produces tools + dispatch from the same sources;
//   - plan-exit tool is advertised only when advertisePlanExit is true,
//     while its dispatcher is always wired;
//   - per-call concurrency classification is fail-closed (unknown → serial);
//   - external MCP is a name-sorted partition that follows the built-ins.

import { describe, it, expect } from 'bun:test'
import { assembleNativeTools, type AssembleOpts } from './tool-registry.js'

function baseOpts(overrides: Partial<AssembleOpts> = {}): AssembleOpts {
  return {
    cwd: '/tmp/agim-registry-test',
    todoThreadKey: 'native:test',
    planExitCtx: { threadKey: 'native:test', runId: 'run-1' },
    advertisePlanExit: false,
    agimCtx: {
      platform: 'native-agent', channelId: 'default', threadId: 'test',
      userId: 'u', callerAgent: 'native', callerDepth: 0,
    },
    ...overrides,
  }
}

describe('assembleNativeTools — single source of truth', () => {
  it('advertises every native source plus the agim tools', () => {
    const { tools } = assembleNativeTools(baseOpts({
      toolPacks: { git: true, codingGate: true },
    }))
    const names = new Set(tools.map((t) => t.name))
    // built-in / fs / git / coding / web(core) / exec / todo / agim representatives
    for (const n of [
      'agim_echo', 'agim_now', 'agim_random_uuid',
      'agim_read_file', 'agim_write_file', 'agim_edit_file', 'agim_list_dir', 'agim_glob', 'agim_grep',
      'agim_git_status', 'agim_git_diff', 'agim_git_log', 'agim_git_add', 'agim_git_commit',
      'agim_diagnostics', 'agim_test_run', 'agim_quality_gate',
      'agim_web_fetch', 'agim_web_search',
      'agim_exec', 'agim_todo_write',
      'mcp__agim__read_skill', 'mcp__agim__save_memo', 'mcp__agim__call_agent',
    ]) {
      expect(names.has(n)).toBe(true)
    }
  })

  it('gates the plan-exit TOOL on advertisePlanExit (dispatcher always wired)', () => {
    const off = assembleNativeTools(baseOpts({ advertisePlanExit: false }))
    expect(off.tools.some((t) => t.name === 'agim_exit_plan_mode')).toBe(false)
    const on = assembleNativeTools(baseOpts({ advertisePlanExit: true }))
    expect(on.tools.some((t) => t.name === 'agim_exit_plan_mode')).toBe(true)
  })

  it('dispatch routes a built-in and falls through for unknown names', async () => {
    const { dispatch } = assembleNativeTools(baseOpts())
    const ctrl = new AbortController()
    const now = await dispatch({ id: '1', name: 'agim_now', arguments: {} }, ctrl.signal)
    expect(now.isError).toBe(false)
    expect(now.source).toBe('builtin')
    const unknown = await dispatch({ id: '2', name: 'totally_made_up_tool', arguments: {} }, ctrl.signal)
    expect(unknown.isError).toBe(true)
    expect(unknown.source).toBe('unknown')
  })
})

describe('assembleNativeTools — per-call concurrency classifier (fail-closed)', () => {
  it('marks read-only / pure tools safe and everything else serial', () => {
    const { isParallelSafe } = assembleNativeTools(baseOpts({
      toolPacks: { git: true, codingGate: true },
    }))
    const safe = ['agim_echo', 'agim_now', 'agim_random_uuid',
      'agim_read_file', 'agim_list_dir', 'agim_glob', 'agim_grep',
      'agim_git_status', 'agim_git_diff', 'agim_git_log', 'agim_diagnostics',
      'agim_web_fetch', 'agim_web_search',
      'mcp__agim__read_skill', 'mcp__agim__list_skills', 'mcp__agim__search_memos',
      'mcp__agim__memory_list', 'mcp__agim__memory_query']
    for (const n of safe) {
      expect(isParallelSafe({ id: 'x', name: n, arguments: {} })).toBe(true)
    }
    const serial = ['agim_write_file', 'agim_edit_file', 'agim_git_add', 'agim_git_commit',
      'agim_test_run', 'agim_quality_gate',
      'agim_exec', 'agim_sleep_ms', 'agim_todo_write',
      'mcp__agim__save_memo', 'mcp__agim__push_message', 'mcp__agim__call_agent',
      'agim_exit_plan_mode']
    for (const n of serial) {
      expect(isParallelSafe({ id: 'x', name: n, arguments: {} })).toBe(false)
    }
  })

  it('returns false (serial) for an unknown / external-MCP tool name', () => {
    const { isParallelSafe } = assembleNativeTools(baseOpts())
    expect(isParallelSafe({ id: 'x', name: 'mcp_someserver_dostuff', arguments: {} })).toBe(false)
    expect(isParallelSafe({ id: 'x', name: 'nonexistent', arguments: {} })).toBe(false)
  })
})
