// Pure mapping unit test — no network. Verifies agim BackendBinding → pi-ai
// Model translation (api id, baseUrl passthrough, auth, unsupported types).

import { describe, expect, it } from 'bun:test'
import type { LlmBackendBinding } from '../../../core/llm/registry.js'
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
  })

  it('returns null for an unsupported provider type', () => {
    expect(bindingToPiModel({ name: 'x', providerType: 'some-future-thing', model: 'm' })).toBeNull()
  })
})
