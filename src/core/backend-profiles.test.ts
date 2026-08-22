import { describe, expect, it } from 'bun:test'
import {
  formatBackendProfilesForPrompt,
  inferBackendProfile,
  resolveBackendProfile,
} from './backend-profiles.js'

describe('backend-profiles', () => {
  it('infers deepseek as finance/zhWriting strong, coding medium', () => {
    const p = inferBackendProfile({
      name: 'deepseek-v4-pro',
      model: 'deepseek-v4-pro',
      provider: 'openai-compat',
    })
    expect(p.capabilities.coding).toBe('medium')
    expect(p.capabilities.finance).toBe('strong')
    expect(p.capabilities.zhWriting).toBe('strong')
    expect(p.capabilities.reasoning).toBe('strong')
    expect(p.capabilities.dataCheck).toBe('strong')
    expect(p.capabilityNotes?.finance).toMatch(/金融/)
    expect(p.capabilityNotes?.zhWriting).toMatch(/母语/)
  })

  it('infers DeepSeek vision as OCR/screenshot specialist', () => {
    const p = inferBackendProfile({
      name: 'deepseek-v4-flash-vision-exp',
      model: 'deepseek-v4-flash-vision-exp',
    })
    expect(p.summary).toMatch(/识图|OCR/)
    expect(p.capabilities.reasoning).toBe('strong')
    expect(p.capabilityNotes?.reasoning).toMatch(/识图/)
    expect(p.capabilities.coding).toBe('weak')
  })

  it('infers openai/claude-ish coding strong', () => {
    const gpt = inferBackendProfile({ name: 'gpt-5', model: 'gpt-5.2' })
    expect(gpt.capabilities.coding).toBe('strong')
    expect(gpt.capabilities.zhWriting).toBe('medium')

    const claude = inferBackendProfile({
      name: 'claude-sonnet',
      model: 'claude-sonnet-4',
      provider: 'anthropic',
    })
    expect(claude.capabilities.coding).toBe('strong')
    expect(claude.capabilityNotes?.finance).toMatch(/非专长/)
  })

  it('applies sparse overrides', () => {
    const p = resolveBackendProfile(
      { name: 'deepseek-v4-pro', model: 'deepseek-v4-pro' },
      { 'deepseek-v4-pro': { capabilities: { coding: 'strong' } } },
    )
    expect(p.capabilities.coding).toBe('strong')
    expect(p.capabilities.finance).toBe('strong')
  })

  it('formats backend catalog lines with caps', () => {
    const text = formatBackendProfilesForPrompt([
      { name: 'deepseek-v4-pro', model: 'deepseek-v4-pro' },
    ])
    expect(text).toContain('backend deepseek-v4-pro:')
    expect(text).toContain('finance=strong')
    expect(text).toContain('zhWriting=strong')
  })
})
