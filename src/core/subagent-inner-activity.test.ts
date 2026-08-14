import { describe, expect, it } from 'bun:test'
import {
  isChildInnerToolStep,
  lastToolFromChildStep,
  reflectsFromChildStep,
} from './subagent-inner-activity.js'

describe('isChildInnerToolStep', () => {
  it('keeps ordinary tools and skills', () => {
    expect(isChildInnerToolStep({ kind: 'tool', label: 'agim_web_search' })).toBe(true)
    expect(isChildInnerToolStep({ kind: 'skill', label: 'read_skill' })).toBe(true)
  })

  it('drops agent / reflect / call_agent rows', () => {
    expect(isChildInnerToolStep({ kind: 'agent', label: 'agim:deepseek-v4-pro' })).toBe(false)
    expect(isChildInnerToolStep({ kind: 'reflect', label: 'next hop' })).toBe(false)
    expect(isChildInnerToolStep({ kind: 'tool', label: 'mcp__agim__call_agent' })).toBe(false)
    expect(isChildInnerToolStep({ kind: 'tool', label: 'call_agents' })).toBe(false)
  })
})

describe('reflectsFromChildStep', () => {
  it('forwards explicit reflects', () => {
    const reflects = [{ stance: 'keep' as const, next: 'Fetch filings', at: 1 }]
    expect(reflectsFromChildStep({
      kind: 'agent',
      label: 'agim',
      startedAt: 1,
      reflects,
    })).toEqual(reflects)
  })

  it('promotes parent-style kind:reflect onto the card', () => {
    expect(reflectsFromChildStep({
      kind: 'reflect',
      label: 'Query capital flows',
      startedAt: 9,
    })).toEqual([{ stance: 'keep', next: 'Query capital flows', at: 9 }])
  })

  it('ignores empty reflect labels', () => {
    expect(reflectsFromChildStep({ kind: 'reflect', label: '  ', startedAt: 1 })).toBeUndefined()
  })
})

describe('lastToolFromChildStep', () => {
  it('captures a running child tool', () => {
    expect(lastToolFromChildStep({
      kind: 'tool',
      label: 'agim_web_fetch',
      status: 'running',
      startedAt: 10,
    })).toEqual({ label: 'agim_web_fetch', status: 'running', at: 10 })
  })

  it('skips call_agent and reflect', () => {
    expect(lastToolFromChildStep({
      kind: 'reflect',
      label: 'thinking',
      status: 'running',
      startedAt: 1,
    })).toBeUndefined()
  })
})
