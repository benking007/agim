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
    const { tools } = assembleNativeTools(baseOpts())
    const names = new Set(tools.map((t) => t.name))
    // built-in / fs / web / exec / todo / agim representatives
    for (const n of [
      'native_echo', 'native_now', 'native_random_uuid',
      'native_read_file', 'native_write_file', 'native_list_dir', 'native_glob', 'native_grep',
      'native_web_fetch', 'native_web_search',
      'native_exec', 'native_todo_write',
      'mcp__agim__read_skill', 'mcp__agim__save_memo', 'mcp__agim__call_agent',
    ]) {
      expect(names.has(n)).toBe(true)
    }
  })

  it('gates the plan-exit TOOL on advertisePlanExit (dispatcher always wired)', () => {
    const off = assembleNativeTools(baseOpts({ advertisePlanExit: false }))
    expect(off.tools.some((t) => t.name === 'native_exit_plan_mode')).toBe(false)
    const on = assembleNativeTools(baseOpts({ advertisePlanExit: true }))
    expect(on.tools.some((t) => t.name === 'native_exit_plan_mode')).toBe(true)
  })

  it('dispatch routes a built-in and falls through for unknown names', async () => {
    const { dispatch } = assembleNativeTools(baseOpts())
    const ctrl = new AbortController()
    const now = await dispatch({ id: '1', name: 'native_now', arguments: {} }, ctrl.signal)
    expect(now.isError).toBe(false)
    expect(now.source).toBe('builtin')
    const unknown = await dispatch({ id: '2', name: 'totally_made_up_tool', arguments: {} }, ctrl.signal)
    expect(unknown.isError).toBe(true)
    expect(unknown.source).toBe('unknown')
  })
})

describe('assembleNativeTools — per-call concurrency classifier (fail-closed)', () => {
  it('marks read-only / pure tools safe and everything else serial', () => {
    const { isParallelSafe } = assembleNativeTools(baseOpts())
    const safe = ['native_echo', 'native_now', 'native_random_uuid',
      'native_read_file', 'native_list_dir', 'native_glob', 'native_grep',
      'native_web_fetch', 'native_web_search',
      'mcp__agim__read_skill', 'mcp__agim__list_skills', 'mcp__agim__search_memos',
      'mcp__agim__memory_list', 'mcp__agim__memory_query']
    for (const n of safe) {
      expect(isParallelSafe({ id: 'x', name: n, arguments: {} })).toBe(true)
    }
    const serial = ['native_write_file', 'native_exec', 'native_sleep_ms', 'native_todo_write',
      'mcp__agim__save_memo', 'mcp__agim__push_message', 'mcp__agim__call_agent',
      'native_exit_plan_mode']
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
