import { describe, expect, it } from 'bun:test'
import { composeStuckLoopFailureSummary } from './index.js'

describe('composeStuckLoopFailureSummary', () => {
  it('groups repeated failures by tool + reason', () => {
    const summary = composeStuckLoopFailureSummary([
      {
        name: 'agim_exec',
        isError: true,
        preview: 'agim_exec denied: unconfined execution while a versioned goal is active (no bwrap)',
      },
      {
        name: 'agim_exec',
        isError: true,
        preview: 'agim_exec denied: unconfined execution while a versioned goal is active (no bwrap)',
      },
      {
        name: 'agim_read_file',
        isError: true,
        preview: 'sensitive path: file basename ".env" is protected',
      },
      {
        name: 'agim_write_file',
        isError: true,
        preview: 'sensitive path: file basename ".env" is protected',
      },
      { name: 'ok_tool', isError: false, preview: 'fine' },
    ])

    expect(summary).toContain('失败原因汇总')
    expect(summary).toContain('`agim_exec` ×2')
    expect(summary).toContain('unconfined execution')
    expect(summary).toContain('`agim_read_file`')
    expect(summary).toContain('basename ".env"')
    expect(summary).toContain('`agim_write_file`')
    expect(summary).toMatch(/权限|策略|拦截/)
    expect(summary).not.toContain('ok_tool')
  })

  it('returns empty when no failures', () => {
    expect(composeStuckLoopFailureSummary([
      { name: 'agim_read_file', isError: false, preview: 'ok' },
    ])).toBe('')
  })
})
