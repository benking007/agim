// Unit tests for the LLM registry + secrets layer.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  loadFromConfig,
  getProvider,
  getAnyProvider,
  getAnyBackendBinding,
  getProviderByName,
  listProviders,
  describeRegistry,
  _resetRegistry,
} from './registry.js'
import {
  saveSecret,
  removeSecret,
  resolveSecret,
  loadSecretsFile,
  envKeyForBackend,
  describeSecretSource,
  LLM_SECRETS_PATH,
} from './secrets.js'
import { existsSync, statSync, unlinkSync } from 'node:fs'

const ENV_VARS_TO_CLEAR = [
  envKeyForBackend('test-cheap'),
  envKeyForBackend('test-evaluator'),
  envKeyForBackend('only-env'),
]

function clearEnv(): void {
  for (const k of ENV_VARS_TO_CLEAR) delete process.env[k]
}

function clearSecretsFile(): void {
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
}

beforeEach(() => {
  clearEnv()
  clearSecretsFile()
  _resetRegistry()
})

afterEach(() => {
  clearEnv()
  clearSecretsFile()
  _resetRegistry()
})

describe('secrets layer', () => {
  it('envKeyForBackend normalises non-alphanumeric to underscore', () => {
    expect(envKeyForBackend('test-cheap')).toBe('AGIM_LLM_SECRET_TEST_CHEAP')
    expect(envKeyForBackend('deepseek.cheap')).toBe('AGIM_LLM_SECRET_DEEPSEEK_CHEAP')
  })

  it('resolveSecret returns undefined when nothing is configured', () => {
    expect(resolveSecret('test-cheap')).toBeUndefined()
  })

  it('resolveSecret prefers env var over file', () => {
    saveSecret('test-cheap', 'from-file')
    process.env[envKeyForBackend('test-cheap')] = 'from-env'
    expect(resolveSecret('test-cheap')).toBe('from-env')
  })

  it('saveSecret writes 0600 perms and round-trips', () => {
    saveSecret('test-cheap', 'sk-abc')
    expect(existsSync(LLM_SECRETS_PATH)).toBe(true)
    const st = statSync(LLM_SECRETS_PATH)
    expect(st.mode & 0o777).toBe(0o600)
    expect(loadSecretsFile().keys['test-cheap']).toBe('sk-abc')
    expect(resolveSecret('test-cheap')).toBe('sk-abc')
  })

  it('removeSecret deletes the entry but keeps the file', () => {
    saveSecret('test-cheap', 'sk-abc')
    saveSecret('test-evaluator', 'sk-xyz')
    removeSecret('test-cheap')
    expect(resolveSecret('test-cheap')).toBeUndefined()
    expect(resolveSecret('test-evaluator')).toBe('sk-xyz')
  })

  it('describeSecretSource reports correct source ladder', () => {
    expect(describeSecretSource('only-env').source).toBe('none')
    saveSecret('only-env', 'fileval')
    expect(describeSecretSource('only-env').source).toBe('file')
    process.env[envKeyForBackend('only-env')] = 'envval'
    expect(describeSecretSource('only-env').source).toBe('env')
  })
})

describe('LLM registry', () => {
  it('loads providers from config with matching secrets', () => {
    saveSecret('test-cheap', 'sk-cheap')
    loadFromConfig({
      llmBackends: [{
        name: 'test-cheap',
        provider: 'openai-compat',
        model: 'gpt-4o-mini',
      }],
      llmRoles: { cheap: 'test-cheap' },
    })
    const p = getProvider('cheap')
    expect(p).not.toBeNull()
    expect(p?.name).toBe('test-cheap')
    expect(p?.model).toBe('gpt-4o-mini')
    expect(listProviders()).toHaveLength(1)
  })

  it('skips backends with no secret', () => {
    loadFromConfig({
      llmBackends: [{
        name: 'test-cheap',
        provider: 'openai-compat',
        model: 'gpt-4o-mini',
      }],
      llmRoles: { cheap: 'test-cheap' },
    })
    expect(getProvider('cheap')).toBeNull()
    expect(listProviders()).toHaveLength(0)
    expect(describeRegistry().unconfigured).toContain('test-cheap')
  })

  it('handles role pointing at non-existent backend gracefully', () => {
    saveSecret('test-cheap', 'sk-cheap')
    loadFromConfig({
      llmBackends: [{
        name: 'test-cheap',
        provider: 'openai-compat',
        model: 'm',
      }],
      llmRoles: { cheap: 'test-cheap', evaluator: 'missing-backend' },
    })
    expect(getProvider('cheap')).not.toBeNull()
    expect(getProvider('evaluator')).toBeNull()
  })

  it('does not load disabled backends', () => {
    saveSecret('test-cheap', 'sk-cheap')
    loadFromConfig({
      llmBackends: [{
        name: 'test-cheap',
        provider: 'openai-compat',
        model: 'm',
        enabled: false,
      }],
      llmRoles: { cheap: 'test-cheap' },
    })
    expect(getProvider('cheap')).toBeNull()
    expect(getProviderByName('test-cheap')).toBeNull()
  })

  it('ignores unknown provider types but keeps others', () => {
    saveSecret('test-cheap', 'sk-cheap')
    loadFromConfig({
      llmBackends: [
        { name: 'test-cheap', provider: 'openai-compat', model: 'm' },
        // Unknown provider type — should be ignored without crashing.
        { name: 'bogus', provider: 'made-up-protocol' as 'openai-compat', model: 'm' },
      ],
      llmRoles: { cheap: 'test-cheap' },
    })
    expect(getProvider('cheap')).not.toBeNull()
    expect(getProviderByName('bogus')).toBeNull()
  })

  it('idempotent loadFromConfig replaces previous state', () => {
    saveSecret('test-cheap', 'sk-1')
    loadFromConfig({
      llmBackends: [{ name: 'test-cheap', provider: 'openai-compat', model: 'm1' }],
      llmRoles: { cheap: 'test-cheap' },
    })
    expect(getProvider('cheap')?.model).toBe('m1')
    // reload with a totally different backend
    saveSecret('test-evaluator', 'sk-2')
    removeSecret('test-cheap')
    loadFromConfig({
      llmBackends: [{ name: 'test-evaluator', provider: 'openai-compat', model: 'm2' }],
      llmRoles: { evaluator: 'test-evaluator' },
    })
    expect(getProvider('cheap')).toBeNull()
    expect(getProvider('evaluator')?.model).toBe('m2')
  })

  it('returns empty registry when no config given', () => {
    loadFromConfig({})
    expect(listProviders()).toHaveLength(0)
    expect(getProvider('cheap')).toBeNull()
    expect(getAnyProvider()).toBeNull()
    expect(getAnyBackendBinding()).toBeNull()
  })

  it("loads provider='anthropic' as AnthropicProvider", () => {
    saveSecret('claude', 'sk-ant-test')
    loadFromConfig({
      llmBackends: [{
        name: 'claude',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        label: 'anthropic',
      }],
      llmRoles: { cheap: 'claude' },
    })
    const p = getProvider('cheap')
    expect(p).not.toBeNull()
    expect(p?.name).toBe('claude')
    expect(p?.providerType).toBe('anthropic')
    expect(p?.model).toBe('claude-3-5-sonnet-20241022')
  })

    it('describeRegistry surfaces snapshot for the cost dashboard', () => {
    saveSecret('test-cheap', 'sk-cheap')
    loadFromConfig({
      llmBackends: [{
        name: 'test-cheap',
        provider: 'openai-compat',
        model: 'm',
        label: 'deepseek',
      }],
      llmRoles: { cheap: 'test-cheap', evaluator: 'test-cheap' },
    })
    const snap = describeRegistry()
    expect(snap.backends).toHaveLength(1)
    expect(snap.backends[0].providerType).toBe('deepseek')
    expect(snap.roles).toEqual({ cheap: 'test-cheap', evaluator: 'test-cheap' })
  })

  it('returns first configured backend even without role bindings', () => {
    saveSecret('test-cheap', 'sk-cheap')
    loadFromConfig({
      llmBackends: [{
        name: 'test-cheap',
        provider: 'openai-compat',
        model: 'm',
      }],
      llmRoles: {},
    })
    expect(getProvider('native-chat')).toBeNull()
    expect(getAnyProvider()?.name).toBe('test-cheap')
    expect(getAnyBackendBinding()?.name).toBe('test-cheap')
  })
})
