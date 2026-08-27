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
  it('defines every non-Agim builtin agent with capability dims', () => {
    for (const id of NON_AGIM_AGENT_IDS) {
      const p = DEFAULT_AGENT_PROFILES[id]
      expect(p.summary.length).toBeGreaterThan(8)
      expect(p.strengths.length).toBeGreaterThan(0)
      expect(p.tags.length).toBeGreaterThan(0)
      expect(p.capabilities.coding).toMatch(/strong|medium|weak/)
      expect(p.capabilities.finance).toMatch(/strong|medium|weak/)
      expect(p.capabilities.zhWriting).toMatch(/strong|medium|weak/)
      expect(p.capabilities.reasoning).toMatch(/strong|medium|weak/)
      expect(p.capabilities.dataCheck).toMatch(/strong|medium|weak/)
    }
    expect(NON_AGIM_AGENT_IDS).toContain('claude-code')
    expect(NON_AGIM_AGENT_IDS).toContain('codex')
    expect(NON_AGIM_AGENT_IDS).toContain('pi')
    expect(NON_AGIM_AGENT_IDS).toContain('mimo')
    expect(NON_AGIM_AGENT_IDS).not.toContain('agim')
  })

  it('scores codex strong at coding; finance/zhWriting medium with notes', () => {
    const c = DEFAULT_AGENT_PROFILES.codex
    expect(c.capabilities.coding).toBe('strong')
    expect(c.capabilities.finance).toBe('medium')
    expect(c.capabilities.zhWriting).toBe('medium')
    expect(c.capabilities.reasoning).toBe('strong')
    expect(c.capabilities.dataCheck).toBe('strong')
    expect(c.capabilityNotes?.finance).toMatch(/非专长/)
    expect(c.capabilityNotes?.zhWriting).toMatch(/翻译腔/)
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

  it('formats a prompt catalog with capability matrix', () => {
    const text = formatAgentProfilesForPrompt(mergeAgentProfiles(), {
      enabledAgents: ['codex', 'agim', 'claude-code'],
    })
    expect(text).toContain('codex:')
    expect(text).toContain('claude-code:')
    expect(text).not.toContain('agim:')
    expect(text).toMatch(/specialty catalog/i)
    expect(text).toMatch(/Capability dims/)
    expect(text).toContain('caps: coding=strong')
    expect(text).toMatch(/finance=medium\(非专长\)/)
  })

  it('does not dump all builtin ids when nothing is enabled', () => {
    expect(formatAgentProfilesForPrompt(mergeAgentProfiles())).toBe('')
  })

  it('intersects enabled with available when availability is known', () => {
    const text = formatAgentProfilesForPrompt(mergeAgentProfiles(), {
      enabledAgents: ['codex', 'claude-code'],
      availableAgents: ['codex'],
      availabilityKnown: true,
    })
    expect(text).toContain('codex:')
    expect(text).not.toContain('claude-code:')
  })

  it('normalizeAgentProfile cleans lists and capabilities', () => {
    const p = normalizeAgentProfile({
      summary: '  hi  ',
      strengths: [' a ', '', 1 as unknown as string, 'b'],
      tags: ['x'],
      capabilities: { coding: 'strong' },
      capabilityNotes: { finance: '  note  ' },
    }, DEFAULT_AGENT_PROFILES.codex)
    expect(p.summary).toBe('hi')
    expect(p.strengths).toEqual(['a', 'b'])
    expect(p.tags).toEqual(['x'])
    expect(p.capabilities.coding).toBe('strong')
    expect(p.capabilities.finance).toBe('medium') // from codex fallback
    expect(p.capabilityNotes?.finance).toBe('note')
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
