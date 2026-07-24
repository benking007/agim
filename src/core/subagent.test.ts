import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, unlinkSync } from 'node:fs'
import {
  formatSubagentLabel,
  isSameAgent,
  parseCallAgentTarget,
  resolveBackendName,
  resolveSubagentSpawn,
} from './subagent.js'
import { loadFromConfig, _resetRegistry } from './llm/registry.js'
import { saveSecret, envKeyForBackend, LLM_SECRETS_PATH } from './llm/secrets.js'

const BACKENDS = ['deepseek-v4-pro', 'deepseek-v4-flash'] as const

function clearSecrets(): void {
  for (const name of BACKENDS) delete process.env[envKeyForBackend(name)]
  if (existsSync(LLM_SECRETS_PATH)) {
    try { unlinkSync(LLM_SECRETS_PATH) } catch { /* ignore */ }
  }
}

describe('subagent helpers', () => {
  it('isSameAgent treats agim/native aliases as the same agent', () => {
    expect(isSameAgent('agim', 'native')).toBe(true)
    expect(isSameAgent('native', 'agim')).toBe(true)
    expect(isSameAgent('agim', 'agim')).toBe(true)
    expect(isSameAgent('claude-code', 'codex')).toBe(false)
    expect(isSameAgent('claude-code', 'claude-code')).toBe(true)
  })

  it('formatSubagentLabel prefers role then backend', () => {
    expect(formatSubagentLabel('agim')).toBe('agim')
    expect(formatSubagentLabel('native', { role: 'cheap' })).toBe('agim/cheap')
    expect(formatSubagentLabel('agim', { backend: 'deepseek-v4-flash' })).toBe('agim:deepseek-v4-flash')
    expect(formatSubagentLabel('claude-code')).toBe('claude-code')
  })

  it('parseCallAgentTarget normalizes agim/native slash forms', () => {
    expect(parseCallAgentTarget('agim/native')).toEqual({ agent: 'agim', isolate: true })
    expect(parseCallAgentTarget('agim/cheap')).toEqual({ agent: 'agim', role: 'cheap', isolate: true })
    expect(parseCallAgentTarget('native')).toEqual({ agent: 'agim' })
    expect(parseCallAgentTarget('claude-code')).toEqual({ agent: 'claude-code' })
  })
})

describe('resolveSubagentSpawn', () => {
  beforeEach(() => {
    clearSecrets()
    _resetRegistry()
  })

  afterEach(() => {
    clearSecrets()
    _resetRegistry()
  })

  it('refuses vacuous same-agent call without isolate/role/backend', () => {
    const r = resolveSubagentSpawn({ agent: 'agim' }, 'native')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/isolate\/role\/backend/)
  })

  it('allows same-agent with isolate:true (no model pin)', () => {
    const r = resolveSubagentSpawn({ agent: 'agim', isolate: true }, 'native')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sameAgent).toBe(true)
      expect(r.isolate).toBe(true)
      expect(r.model).toBeUndefined()
      expect(r.label).toBe('agim')
    }
  })

  it('accepts legacy agent id agim/native as same-family isolate spawn', () => {
    const r = resolveSubagentSpawn({ agent: 'agim/native', isolate: true }, 'agim')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent).toBe('agim')
      expect(r.sameAgent).toBe(true)
      expect(r.isolate).toBe(true)
      expect(r.label).toBe('agim')
    }
  })

  it('maps agim/cheap slash form to role=cheap', () => {
    saveSecret('deepseek-v4-pro', 'sk-pro')
    saveSecret('deepseek-v4-flash', 'sk-flash')
    loadFromConfig({
      llmBackends: [
        {
          name: 'deepseek-v4-pro',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
        },
        {
          name: 'deepseek-v4-flash',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
        },
      ],
      llmRoles: { 'native-chat': 'deepseek-v4-pro', cheap: 'deepseek-v4-flash' },
    } as never)
    const r = resolveSubagentSpawn({ agent: 'agim/cheap' }, 'agim')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent).toBe('agim')
      expect(r.role).toBe('cheap')
      expect(r.model).toBe('deepseek-v4-flash')
      expect(r.label).toBe('agim/cheap')
    }
  })

  it('resolves role=cheap to configured backend name', () => {
    saveSecret('deepseek-v4-pro', 'sk-pro')
    saveSecret('deepseek-v4-flash', 'sk-flash')
    loadFromConfig({
      llmBackends: [
        {
          name: 'deepseek-v4-pro',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
        },
        {
          name: 'deepseek-v4-flash',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
        },
      ],
      llmRoles: {
        'native-chat': 'deepseek-v4-pro',
        cheap: 'deepseek-v4-flash',
      },
    })
    const r = resolveSubagentSpawn({ agent: 'agim', role: 'cheap' }, 'agim')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.model).toBe('deepseek-v4-flash')
      expect(r.label).toBe('agim/cheap')
      expect(r.isolate).toBe(true)
    }
  })

  it('errors when role=cheap is unbound', () => {
    saveSecret('deepseek-v4-pro', 'sk-pro')
    loadFromConfig({
      llmBackends: [
        {
          name: 'deepseek-v4-pro',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
        },
      ],
      llmRoles: { 'native-chat': 'deepseek-v4-pro' },
    })
    const r = resolveSubagentSpawn({ agent: 'agim', role: 'cheap' }, 'agim')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/llmRoles\.cheap/)
  })

  it('backend wins over role and is case-insensitive', () => {
    saveSecret('deepseek-v4-flash', 'sk-flash')
    loadFromConfig({
      llmBackends: [
        {
          name: 'deepseek-v4-flash',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
        },
      ],
      llmRoles: { cheap: 'deepseek-v4-flash' },
    })
    const r = resolveSubagentSpawn(
      { agent: 'agim', role: 'cheap', backend: 'DeepSeek-V4-Flash' },
      'agim',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.model).toBe('deepseek-v4-flash')
      expect(resolveBackendName('DeepSeek-V4-Flash')).toBe('deepseek-v4-flash')
    }
  })

  it('cross-adapter target does not require isolate', () => {
    const r = resolveSubagentSpawn({ agent: 'claude-code' }, 'agim')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sameAgent).toBe(false)
      expect(r.isolate).toBe(false)
      expect(r.label).toBe('claude-code')
    }
  })
})
