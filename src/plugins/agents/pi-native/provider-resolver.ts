// Maps agim's resolved LLM backend binding (provider type / model / baseUrl /
// key) onto a pi-ai Model + auth, so Agim Agent drives real LLMs
// using agim's existing backend config + secrets (no new key plumbing).
//
// pi-ai facts (probed against the installed package):
//   - registered stream apis include 'openai-completions' and 'anthropic-messages'
//   - agim's openai-compat backends (deepseek / qwen / …) speak the chat
//     completions wire format → 'openai-completions'
//   - the openai-completions client uses model.baseUrl verbatim (provider.js:391),
//     so a hand-built Model pointed at agim's baseUrl reaches the right endpoint
//   - model.baseUrl must be a string (the provider calls .includes on it)
//   - auth flows via getApiKeyAndHeaders → stream options.apiKey/headers

import type { Model } from '@earendil-works/pi-ai'
import {
  getAnyBackendBinding,
  getBackendBindingForRole,
  type LlmBackendBinding,
  type LlmRole,
} from '../../../core/llm/registry.js'
import type { NativeModelBinding } from './index.js'

/** agim providerType → pi-ai stream api id. Unmapped types are unsupported
 *  by the pi engine (resolver returns null → adapter reports unavailable). */
const API_BY_PROVIDER_TYPE: Record<string, string> = {
  'openai-compat': 'openai-completions',
  anthropic: 'anthropic-messages',
}

const DEFAULT_BASE_URL: Record<string, string> = {
  'openai-completions': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
}

export function bindingToPiModel(b: LlmBackendBinding): NativeModelBinding | null {
  const api = API_BY_PROVIDER_TYPE[b.providerType]
  if (!api) return null
  const model = {
    id: b.model,
    name: b.model,
    api,
    provider: b.name,
    baseUrl: b.baseUrl ?? DEFAULT_BASE_URL[api] ?? 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: b.maxTokens ?? 8192,
  } as Model<string>
  return {
    model,
    getApiKeyAndHeaders: async () => ({ apiKey: b.apiKey ?? '', headers: b.extraHeaders ?? {} }),
  }
}

/** Resolve a pi model binding for an agim LLM role, or null when no usable
 *  backend (or an unsupported provider type) is configured. */
export function resolvePiModelForRole(role: LlmRole): NativeModelBinding | null {
  const binding = getBackendBindingForRole(role)
  return binding ? bindingToPiModel(binding) : null
}

/** Resolve a pi model binding from the first configured backend, ignoring roles. */
export function resolveAnyPiModel(): NativeModelBinding | null {
  const binding = getAnyBackendBinding()
  return binding ? bindingToPiModel(binding) : null
}
