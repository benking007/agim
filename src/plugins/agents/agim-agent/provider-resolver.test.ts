// Pure mapping unit test — no network. Verifies agim BackendBinding → pi-ai
// Model translation (api id, baseUrl passthrough, auth, unsupported types).

import { describe, expect, it } from 'bun:test'
import type { LlmBackendBinding } from '../../../core/llm/registry.js'
import { lookupModelMeta } from '../../../core/llm/model-catalog.js'
import { bindingToPiModel } from './provider-resolver.js'

/** pi-ai Model.compat is a narrow/empty type in some builds — read as a bag. */
function compatOf(model: { compat?: unknown }): Record<string, unknown> | undefined {
  return model.compat && typeof model.compat === 'object'
    ? model.compat as Record<string, unknown>
    : undefined
}

describe('Agim Agent provider-resolver (agim binding → pi-ai model)', () => {
  it('maps an openai-compat backend (deepseek) to openai-completions with its baseUrl', async () => {
    const b: LlmBackendBinding = {
      name: 'deepseek',
      providerType: 'openai-compat',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-xxx',
      extraHeaders: { 'x-foo': 'bar' },
    }
    const binding = bindingToPiModel(b)!
    expect(binding.model.api).toBe('openai-completions')
    expect(binding.model.baseUrl).toBe('https://api.deepseek.com')
    expect(binding.model.id).toBe('deepseek-v4-pro')
    expect(binding.model.reasoning).toBe(true)
    expect(binding.model.thinkingLevelMap?.xhigh).toBe('max')
    expect(binding.costKnown).toBe(true)
    expect(await binding.getApiKeyAndHeaders()).toEqual({ apiKey: 'sk-xxx', headers: { 'x-foo': 'bar' } })
  })

  it('enables DeepSeek thinking compat even for uncatalogued model ids on deepseek.com', () => {
    const binding = bindingToPiModel({
      name: 'ds-custom',
      providerType: 'openai-compat',
      model: 'deepseek-custom-agent',
      baseUrl: 'https://api.deepseek.com',
    })!
    expect(binding.model.reasoning).toBe(true)
    expect(compatOf(binding.model)?.thinkingFormat).toBe('deepseek')
    expect(binding.model.thinkingLevelMap?.high).toBe('high')
    // Vendor fallback (no catalog row): 1M / 384K matches V4 API defaults.
    expect(binding.model.contextWindow).toBe(1_000_000)
    expect(binding.model.maxTokens).toBe(384_000)
  })

  it('enables Kimi K3 thinking via reasoning_effort (openai format)', () => {
    const binding = bindingToPiModel({
      name: 'kimi-k3',
      providerType: 'openai-compat',
      model: 'kimi-k3',
      baseUrl: 'https://api.moonshot.cn/v1',
    })!
    expect(binding.model.reasoning).toBe(true)
    expect(compatOf(binding.model)?.thinkingFormat).toBe('openai')
    expect(compatOf(binding.model)?.supportsReasoningEffort).toBe(true)
    expect(compatOf(binding.model)?.requiresReasoningContentOnAssistantMessages).toBe(true)
    expect(binding.model.thinkingLevelMap?.low).toBe('low')
    expect(binding.model.thinkingLevelMap?.high).toBe('high')
    expect(binding.model.thinkingLevelMap?.xhigh).toBe('max')
    expect(binding.model.contextWindow).toBe(1_000_000)
  })

  it('enables Kimi K2.6 thinking via deepseek-style thinking.type', () => {
    const binding = bindingToPiModel({
      name: 'kimi-k2.6',
      providerType: 'openai-compat',
      model: 'kimi-k2.6',
      baseUrl: 'https://api.moonshot.ai/v1',
    })!
    expect(binding.model.reasoning).toBe(true)
    expect(compatOf(binding.model)?.thinkingFormat).toBe('deepseek')
    // Catalog may supply 262144; uncatalogued fallback is 256k.
    expect(binding.model.contextWindow).toBeGreaterThanOrEqual(256_000)
  })

  it('enables GLM-5.2 thinking via thinking.type + reasoning_effort', () => {
    const binding = bindingToPiModel({
      name: 'glm-5.2',
      providerType: 'openai-compat',
      model: 'glm-5.2',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    })!
    expect(binding.model.reasoning).toBe(true)
    expect(compatOf(binding.model)?.thinkingFormat).toBe('deepseek')
    expect(compatOf(binding.model)?.supportsReasoningEffort).toBe(true)
    expect(binding.model.thinkingLevelMap?.high).toBe('high')
    expect(binding.model.thinkingLevelMap?.xhigh).toBe('max')
    expect(binding.model.thinkingLevelMap?.low).toBe('high')
    expect(binding.model.contextWindow).toBe(1_000_000)
  })

  it('enables GLM-4.7-flash thinking without reasoning_effort', () => {
    const binding = bindingToPiModel({
      name: 'glm-4.7-flash',
      providerType: 'openai-compat',
      model: 'glm-4.7-flash',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    })!
    expect(binding.model.reasoning).toBe(true)
    expect(compatOf(binding.model)?.thinkingFormat).toBe('deepseek')
    expect(compatOf(binding.model)?.supportsReasoningEffort).toBe(false)
    expect(binding.model.contextWindow).toBe(200_000)
  })

  it('enables MiMo V2.5 thinking via thinking.type + max_completion_tokens', () => {
    const binding = bindingToPiModel({
      name: 'mimo-v2.5-pro',
      providerType: 'openai-compat',
      model: 'mimo-v2.5-pro',
      baseUrl: 'https://api.xiaomimimo.com/v1',
    })!
    expect(binding.model.reasoning).toBe(true)
    expect(compatOf(binding.model)?.thinkingFormat).toBe('deepseek')
    expect(compatOf(binding.model)?.supportsReasoningEffort).toBeFalsy()
    expect(compatOf(binding.model)?.maxTokensField).toBe('max_completion_tokens')
    expect(compatOf(binding.model)?.requiresReasoningContentOnAssistantMessages).toBe(true)
    expect(binding.model.thinkingLevelMap?.high).toBe('high')
    // Catalog may report 1048576 (1Mi); vendor fallback is 1_000_000.
    expect(binding.model.contextWindow).toBeGreaterThanOrEqual(1_000_000)
    expect(binding.model.input).toContain('text')
  })

  it('honors explicit thinkingFormat / contextWindow on custom backends', () => {
    const on = bindingToPiModel({
      name: 'proxy-think',
      providerType: 'openai-compat',
      model: 'my-proxy-model',
      baseUrl: 'https://llm.internal/v1',
      thinkingFormat: 'deepseek',
      contextWindow: 200_000,
      maxTokens: 16_384,
      maxTokensField: 'max_completion_tokens',
    })!
    expect(on.model.reasoning).toBe(true)
    expect(compatOf(on.model)?.thinkingFormat).toBe('deepseek')
    expect(compatOf(on.model)?.maxTokensField).toBe('max_completion_tokens')
    expect(on.model.contextWindow).toBe(200_000)
    expect(on.model.maxTokens).toBe(16_384)

    const off = bindingToPiModel({
      name: 'proxy-off',
      providerType: 'openai-compat',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      thinkingFormat: 'off',
      maxTokensField: 'max_completion_tokens',
    })!
    expect(off.model.reasoning).toBe(false)
    expect(off.model.thinkingLevelMap).toBeUndefined()
    expect(compatOf(off.model)?.thinkingFormat).toBeUndefined()
    expect(compatOf(off.model)?.maxTokensField).toBe('max_completion_tokens')
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
