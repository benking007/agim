import { describe, expect, it } from 'bun:test'
import {
  canParentLoop,
  formatLoopParentRequired,
} from './loop-parent-agent.js'

describe('loop parent agent gate', () => {
  it('allows Agim / legacy native ids', () => {
    expect(canParentLoop('agim')).toBe(true)
    expect(canParentLoop('native')).toBe(true)
  })

  it('rejects CLI backends', () => {
    expect(canParentLoop('codex')).toBe(false)
    expect(canParentLoop('claude-code')).toBe(false)
    expect(canParentLoop('opencode')).toBe(false)
    expect(canParentLoop('')).toBe(false)
    expect(canParentLoop(null)).toBe(false)
  })

  it('formatLoopParentRequired mentions switch + Subagent role', () => {
    const zh = formatLoopParentRequired('codex', 'zh')
    expect(zh).toContain('Agim Agent')
    expect(zh).toContain('codex')
    expect(zh).toContain('E2BIG')
    expect(zh).toContain('子代理')

    const en = formatLoopParentRequired('claude-code', 'en')
    expect(en).toContain('Agim Agent')
    expect(en).toContain('claude-code')
    expect(en).toContain('Subagents')
  })
})
