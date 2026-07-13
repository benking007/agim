// Pure mapping unit test — no network. Verifies agim BackendBinding → pi-ai
// Model translation (api id, baseUrl passthrough, auth, unsupported types).

import { describe, expect, it } from 'bun:test'
import type { LlmBackendBinding } from '../../../core/llm/registry.js'
import { lookupModelMeta } from '../../../core/llm/model-catalog.js'
import { bindingToPiModel } from './provider-resolver.js'

describe('Agim Agent provider-resolver (agim binding → pi-ai model)', () => {
  it('maps an openai-compat backend (deepseek) to openai-completions with its baseUrl', async () => {
    const b: LlmBackendBinding = {
      name: 'deepseek',
      providerType: 'openai-compat',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-xxx',
      extraHeaders: { 'x-foo': 'bar' },
    }
    const binding = bindingToPiModel(b)!
    expect(binding.model.api).toBe('openai-completions')
    expect(binding.model.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(binding.model.id).toBe('deepseek-chat')
    expect(await binding.getApiKeyAndHeaders()).toEqual({ apiKey: 'sk-xxx', headers: { 'x-foo': 'bar' } })
  })

  it('maps an anthropic backend to anthropic-messages', () => {
    const binding = bindingToPiModel({
      name: 'claude',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-5',
    })!
    expect(binding.model.api).toBe('anthropic-messages')
    expect(binding.model.baseUrl).toBe('https://api.anthropic.com') // default when unset
    const catalog = lookupModelMeta('anthropic', 'claude-sonnet-4-5')
    expect(catalog).not.toBeNull()
    if (!catalog) throw new Error('missing catalog metadata for claude-sonnet-4-5')
    expect(binding.costKnown).toBe(true)
    expect(binding.model.contextWindow).toBe(catalog.contextWindow)
    expect(binding.model.maxTokens).toBe(catalog.maxTokens)
  })

  it('returns null for an unsupported provider type', () => {
    expect(bindingToPiModel({ name: 'x', providerType: 'some-future-thing', model: 'm' })).toBeNull()
  })

  it('marks uncatalogued custom models as unknown-cost with a conservative context window', () => {
    const binding = bindingToPiModel({
      name: 'custom',
      providerType: 'openai-compat',
      model: 'private-model-not-in-catalog',
      baseUrl: 'https://llm.internal/v1',
    })!
    expect(binding.costKnown).toBe(false)
    expect(binding.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(binding.model.contextWindow).toBe(32_000)
    expect(binding.model.input).toEqual(['text'])
    expect(binding.model.reasoning).toBe(false)
  })

  it('honors AGIM_NATIVE_UNKNOWN_CONTEXT_WINDOW for uncatalogued models', () => {
    const prev = process.env.AGIM_NATIVE_UNKNOWN_CONTEXT_WINDOW
    process.env.AGIM_NATIVE_UNKNOWN_CONTEXT_WINDOW = '16000'
    try {
      const binding = bindingToPiModel({
        name: 'custom',
        providerType: 'openai-compat',
        model: 'another-private-model',
        baseUrl: 'https://llm.internal/v1',
      })!
      expect(binding.model.contextWindow).toBe(16_000)
    } finally {
      if (prev === undefined) delete process.env.AGIM_NATIVE_UNKNOWN_CONTEXT_WINDOW
      else process.env.AGIM_NATIVE_UNKNOWN_CONTEXT_WINDOW = prev
    }
  })

  it('copies catalog modalities for known vision models', () => {
    const binding = bindingToPiModel({
      name: 'claude',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-5',
    })!
    expect(binding.costKnown).toBe(true)
    expect(Array.isArray(binding.model.input)).toBe(true)
    expect(binding.model.input.length).toBeGreaterThan(0)
  })
})
