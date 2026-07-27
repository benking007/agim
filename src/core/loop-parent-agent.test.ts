import { describe, expect, it } from 'bun:test'
import {
  canParentLoop,
  formatLoopParentRequired,
  isLoopWorkerAgent,
  nextPreferredWorkerAgent,
  resolvePreferredWorkerAgent,
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
    expect(zh).toContain('call_agents')

    const en = formatLoopParentRequired('claude-code', 'en')
    expect(en).toContain('Agim Agent')
    expect(en).toContain('claude-code')
    expect(en).toContain('call_agents')
  })

  it('tracks preferred Loop worker across sticky switches', () => {
    expect(isLoopWorkerAgent('codex')).toBe(true)
    expect(isLoopWorkerAgent('agim')).toBe(false)
    expect(nextPreferredWorkerAgent('agim', 'codex')).toBe('codex')
    expect(nextPreferredWorkerAgent('codex', 'agim')).toBe('codex')
    expect(nextPreferredWorkerAgent('codex', 'claude-code')).toBe('claude-code')
    expect(nextPreferredWorkerAgent('agim', 'agim', 'codex')).toBe('codex')
    expect(resolvePreferredWorkerAgent('agim', 'codex')).toBe('codex')
    expect(resolvePreferredWorkerAgent('codex', undefined)).toBe('codex')
  })
})
