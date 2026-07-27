import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_AGENT_PROFILES,
  NON_AGIM_AGENT_IDS,
  agentProfileOverridesFromEffective,
  formatAgentProfilesForPrompt,
  mergeAgentProfiles,
  normalizeAgentProfile,
  profilesEqual,
  readAgentProfileOverrides,
} from './agent-profiles.js'

describe('agent profiles', () => {
  it('defines every non-Agim builtin agent', () => {
    for (const id of NON_AGIM_AGENT_IDS) {
      const p = DEFAULT_AGENT_PROFILES[id]
      expect(p.summary.length).toBeGreaterThan(8)
      expect(p.strengths.length).toBeGreaterThan(0)
      expect(p.tags.length).toBeGreaterThan(0)
    }
    expect(NON_AGIM_AGENT_IDS).toContain('claude-code')
    expect(NON_AGIM_AGENT_IDS).toContain('codex')
    expect(NON_AGIM_AGENT_IDS).toContain('pi')
    expect(NON_AGIM_AGENT_IDS).toContain('mimo')
    expect(NON_AGIM_AGENT_IDS).not.toContain('agim')
  })

  it('merges sparse overrides onto defaults', () => {
    const merged = mergeAgentProfiles({
      codex: { summary: '自定义 Codex', strengths: ['只做补丁'] },
    })
    expect(merged.codex.summary).toBe('自定义 Codex')
    expect(merged.codex.strengths).toEqual(['只做补丁'])
    expect(merged.codex.avoid).toEqual(DEFAULT_AGENT_PROFILES.codex.avoid)
    expect(merged['claude-code'].summary).toBe(DEFAULT_AGENT_PROFILES['claude-code'].summary)
  })

  it('persists only profiles that differ from defaults', () => {
    const effective = mergeAgentProfiles({
      pi: { summary: '更轻量' },
    })
    const overrides = agentProfileOverridesFromEffective(effective)
    expect(Object.keys(overrides)).toEqual(['pi'])
    expect(overrides.pi?.summary).toBe('更轻量')
  })

  it('formats a prompt catalog', () => {
    const text = formatAgentProfilesForPrompt(mergeAgentProfiles(), {
      enabledAgents: ['codex', 'agim', 'claude-code'],
    })
    expect(text).toContain('codex:')
    expect(text).toContain('claude-code:')
    expect(text).not.toContain('agim:')
    expect(text).toMatch(/specialty catalog/i)
  })

  it('normalizeAgentProfile cleans lists', () => {
    const p = normalizeAgentProfile({
      summary: '  hi  ',
      strengths: [' a ', '', 1 as unknown as string, 'b'],
      tags: ['x'],
    })
    expect(p.summary).toBe('hi')
    expect(p.strengths).toEqual(['a', 'b'])
    expect(p.tags).toEqual(['x'])
  })

  it('readAgentProfileOverrides ignores Agim / junk', () => {
    const o = readAgentProfileOverrides({
      agentProfiles: {
        agim: { summary: 'nope' },
        native: { summary: 'nope' },
        codex: { summary: 'ok' },
        'bad': 'x',
      },
    })
    expect(o.codex?.summary).toBe('ok')
    expect(o.agim).toBeUndefined()
  })

  it('profilesEqual works', () => {
    const a = DEFAULT_AGENT_PROFILES.opencode
    expect(profilesEqual(a, { ...a, strengths: [...a.strengths] })).toBe(true)
    expect(profilesEqual(a, { ...a, summary: 'x' })).toBe(false)
  })
})
