import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, unlinkSync } from 'node:fs'
import {
  applyCallAgentOutputFormat,
  formatSubagentLabel,
  intersectAllowedTools,
  isSameAgent,
  parseCallAgentTarget,
  parseCallAgentTask,
  parseCallAgentsArgs,
  resolveBackendName,
  resolveSubagentSpawn,
  resolveSubtreeMaxDepth,
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

  it('parseCallAgentTarget normalizes agim/native and prefers backend over role', () => {
    expect(parseCallAgentTarget('agim/native')).toEqual({ agent: 'agim', isolate: true })
    expect(parseCallAgentTarget('native')).toEqual({ agent: 'agim' })
    expect(parseCallAgentTarget('claude-code')).toEqual({ agent: 'claude-code' })
    // Unconfigured cheap → treated as backend candidate (error lists real backends).
    expect(parseCallAgentTarget('agim/cheap')).toEqual({
      agent: 'agim',
      backend: 'cheap',
      isolate: true,
    })
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

  it('maps agim/cheap slash form to role=cheap when role is configured', () => {
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

  it('maps agim/<backend> and agim:<backend> to concrete backend names', () => {
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
      llmRoles: {},
    } as never)
    const slash = resolveSubagentSpawn({ agent: 'agim/deepseek-v4-flash' }, 'agim')
    expect(slash.ok).toBe(true)
    if (slash.ok) {
      expect(slash.model).toBe('deepseek-v4-flash')
      expect(slash.role).toBeUndefined()
      expect(slash.label).toBe('agim:deepseek-v4-flash')
    }
    const colon = resolveSubagentSpawn({ agent: 'agim:deepseek-v4-flash' }, 'agim')
    expect(colon.ok).toBe(true)
    if (colon.ok) expect(colon.model).toBe('deepseek-v4-flash')

    const explicit = resolveSubagentSpawn(
      { agent: 'agim', backend: 'deepseek-v4-flash' },
      'agim',
    )
    expect(explicit.ok).toBe(true)
    if (explicit.ok) expect(explicit.model).toBe('deepseek-v4-flash')
  })

  it('fails clearly when agim/cheap is used but cheap role is unbound', () => {
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
      llmRoles: {},
    } as never)
    const r = resolveSubagentSpawn({ agent: 'agim/cheap' }, 'agim')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/backend "cheap" not found/)
      expect(r.error).toMatch(/Configured backends: deepseek-v4-pro/)
      expect(r.error).toMatch(/Prefer call_agent/)
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

  it('resolves DeepSeek vision backend even when only pro is configured', () => {
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
    const byName = resolveSubagentSpawn(
      { agent: 'agim', backend: 'deepseek-v4-flash-vision-exp' },
      'agim',
    )
    expect(byName.ok).toBe(true)
    if (byName.ok) {
      expect(byName.model).toBe('deepseek-v4-flash-vision-exp')
      expect(byName.label).toBe('agim:deepseek-v4-flash-vision-exp')
    }
    const alias = resolveSubagentSpawn({ agent: 'agim', backend: 'vision' }, 'agim')
    expect(alias.ok).toBe(true)
    if (alias.ok) expect(alias.model).toBe('deepseek-v4-flash-vision-exp')
    expect(resolveBackendName('deepseek-v4-flash-vision-exp')).toBe('deepseek-v4-flash-vision-exp')
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

describe('call_agent task contract (fail-loud)', () => {
  it('rejects unknown keys', () => {
    const r = parseCallAgentTask({
      agent: 'agim',
      prompt: 'hi',
      isolate: true,
      foo: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown key/i)
  })

  it('parses outputFormat, maxDepth, allowedTools', () => {
    const r = parseCallAgentTask({
      agent: 'agim',
      prompt: 'research X',
      isolate: true,
      outputFormat: 'markdown table',
      maxDepth: 2,
      allowedTools: ['agim_read_file', 'agim_grep'],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.task.outputFormat).toBe('markdown table')
    expect(r.task.maxDepth).toBe(2)
    expect(r.task.allowedTools).toEqual(['agim_read_file', 'agim_grep'])
    expect(applyCallAgentOutputFormat(r.task.prompt, r.task.outputFormat)).toContain('[Output format]')
  })

  it('rejects maxDepth < 1 and empty allowedTools', () => {
    expect(parseCallAgentTask({ agent: 'agim', prompt: 'x', isolate: true, maxDepth: 0 }).ok).toBe(false)
    expect(parseCallAgentTask({ agent: 'agim', prompt: 'x', isolate: true, allowedTools: [] }).ok).toBe(false)
  })

  it('call_agents refuses extra root keys and per-task unknown keys', () => {
    const extraRoot = parseCallAgentsArgs({
      tasks: [{ agent: 'agim', prompt: 'a', isolate: true }],
      parallel: true,
    })
    expect(extraRoot.ok).toBe(false)
    const extraTask = parseCallAgentsArgs({
      tasks: [{ agent: 'agim', prompt: 'a', isolate: true, mystery: 1 }],
    })
    expect(extraTask.ok).toBe(false)
    if (!extraTask.ok) expect(extraTask.error).toMatch(/tasks\[0\]/)
  })

  it('intersects allowedTools with the parent list', () => {
    const inherit = intersectAllowedTools(['agim_read_file', 'agim_grep'], undefined)
    expect(inherit.ok).toBe(true)
    if (inherit.ok) expect(inherit.tools).toEqual(['agim_read_file', 'agim_grep'])
    const ok = intersectAllowedTools(['agim_read_file', 'agim_grep'], ['agim_grep', 'agim_exec'])
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.tools).toEqual(['agim_grep'])
    const empty = intersectAllowedTools(['agim_read_file'], ['agim_exec'])
    expect(empty.ok).toBe(false)
  })

  it('refuses maxDepth above global or inherited cap', () => {
    expect(resolveSubtreeMaxDepth({ requested: 9, globalMax: 8 }).ok).toBe(false)
    expect(resolveSubtreeMaxDepth({ requested: 4, inherited: 2, globalMax: 8 }).ok).toBe(false)
    const ok = resolveSubtreeMaxDepth({ requested: 2, inherited: 4, globalMax: 8 })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.maxDepth).toBe(2)
  })
})
