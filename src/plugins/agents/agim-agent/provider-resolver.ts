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
  getBackendBindingByName,
  getBackendBindingForRole,
  type LlmBackendBinding,
  type LlmRole,
} from '../../../core/llm/registry.js'
import { isDeepSeekBaseUrl } from '../../../core/llm/presets.js'
import type { NativeModelBinding } from './index.js'
import { findCatalogModel } from '../../../core/llm/model-catalog.js'

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

/** DeepSeek catalog maps effort levels; keep a local fallback when the
 *  model id is custom but the baseUrl is still DeepSeek. */
const DEEPSEEK_THINKING_LEVEL_MAP = {
  minimal: null,
  low: null,
  medium: null,
  high: 'high',
  xhigh: 'max',
} as const

export function bindingToPiModel(b: LlmBackendBinding): NativeModelBinding | null {
  const api = API_BY_PROVIDER_TYPE[b.providerType]
  if (!api) return null
  const catalogModel = findCatalogModel(b.providerType, b.model)
  const unknownContextWindow = resolveUnknownContextWindow()
  const baseUrl = b.baseUrl ?? DEFAULT_BASE_URL[api] ?? 'https://api.openai.com/v1'
  const deepseek = isDeepSeekBaseUrl(baseUrl)
    || catalogModel?.provider === 'deepseek'
    || /^deepseek/i.test(b.model)
  // Prefer catalog reasoning; DeepSeek endpoints always support thinking mode
  // even when the model id is not yet in pi-ai's table.
  const reasoning = catalogModel?.reasoning === true || deepseek
  const model = {
    id: b.model,
    name: b.model,
    api,
    // Keep agim backend name as provider id (auth / cost grouping), but copy
    // DeepSeek compat fields so pi-ai emits thinking + reasoning_content.
    provider: b.name,
    baseUrl,
    reasoning,
    input: (catalogModel?.input?.length
      ? [...catalogModel.input]
      : ['text']) as ('text' | 'image')[],
    cost: catalogModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Uncatalogued / private endpoints must not inherit a 128k assumption —
    // that delays compaction until the provider already overflows.
    contextWindow: catalogModel?.contextWindow ?? unknownContextWindow,
    maxTokens: b.maxTokens ?? catalogModel?.maxTokens ?? 8192,
    ...(catalogModel?.thinkingLevelMap
      ? { thinkingLevelMap: { ...(catalogModel.thinkingLevelMap as Record<string, string | null>) } }
      : deepseek
        ? { thinkingLevelMap: { ...DEEPSEEK_THINKING_LEVEL_MAP } }
        : {}),
    ...(catalogModel?.compat
      ? { compat: { ...(catalogModel.compat as Record<string, unknown>) } }
      : deepseek
        ? {
            compat: {
              thinkingFormat: 'deepseek' as const,
              requiresReasoningContentOnAssistantMessages: true,
            },
          }
        : {}),
  } as Model<string>
  return {
    model,
    costKnown: catalogModel !== null,
    getApiKeyAndHeaders: async () => ({ apiKey: b.apiKey ?? '', headers: b.extraHeaders ?? {} }),
  }
}

/** Conservative context window for models missing from the pi catalog.
 *  Override with AGIM_NATIVE_UNKNOWN_CONTEXT_WINDOW (positive integer). */
export function resolveUnknownContextWindow(): number {
  const raw = (process.env.AGIM_NATIVE_UNKNOWN_CONTEXT_WINDOW ?? '').trim()
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 4_096 && n <= 1_000_000) return n
  }
  return 32_000
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

/** Resolve a pi model binding from an explicit agim backend name. */
export function resolvePiModelByBackendName(name: string | undefined): NativeModelBinding | null {
  const trimmed = name?.trim()
  if (!trimmed) return null
  const binding = getBackendBindingByName(trimmed)
  return binding ? bindingToPiModel(binding) : null
}
