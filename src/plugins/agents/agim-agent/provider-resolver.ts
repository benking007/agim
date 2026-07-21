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
import {
  isDeepSeekBaseUrl,
  isKimiBaseUrl,
  isKimiK2Model,
  isKimiK3Model,
  isKimiModel,
} from '../../../core/llm/presets.js'
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

/** Kimi K3: always-on thinking via top-level `reasoning_effort`. */
const KIMI_K3_THINKING_LEVEL_MAP = {
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: 'max',
} as const

/**
 * Kimi K2.x: `thinking: { type }` (deepseek-style). Effort maps onto
 * enabled/disabled — mid levels are treated as enabled.
 */
const KIMI_K2_THINKING_LEVEL_MAP = {
  minimal: null,
  low: null,
  medium: null,
  high: 'high',
  xhigh: 'max',
} as const

function resolveKimiContextWindow(modelId: string): number | undefined {
  if (isKimiK3Model(modelId)) return 1_000_000
  if (/^kimi-k2\.7/i.test(modelId)) return 256_000
  if (/^kimi-k2\.6/i.test(modelId)) return 256_000
  if (/^kimi-k2\.5/i.test(modelId)) return 256_000
  if (isKimiModel(modelId)) return 256_000
  return undefined
}

function resolveKimiMaxTokens(modelId: string): number | undefined {
  if (isKimiK3Model(modelId)) return 131_072
  if (isKimiK2Model(modelId)) return 32_768
  return undefined
}

export function bindingToPiModel(b: LlmBackendBinding): NativeModelBinding | null {
  const api = API_BY_PROVIDER_TYPE[b.providerType]
  if (!api) return null
  const catalogModel = findCatalogModel(b.providerType, b.model)
  const unknownContextWindow = resolveUnknownContextWindow()
  const baseUrl = b.baseUrl ?? DEFAULT_BASE_URL[api] ?? 'https://api.openai.com/v1'
  const deepseek = isDeepSeekBaseUrl(baseUrl)
    || catalogModel?.provider === 'deepseek'
    || /^deepseek/i.test(b.model)
  const kimi = isKimiBaseUrl(baseUrl)
    || catalogModel?.provider === 'moonshot'
    || isKimiModel(b.model)
  const kimiK3 = kimi && isKimiK3Model(b.model)
  const kimiK2 = kimi && isKimiK2Model(b.model)
  // Prefer catalog reasoning; DeepSeek / Kimi endpoints always support
  // thinking mode even when the model id is not yet in pi-ai's table.
  const reasoning = catalogModel?.reasoning === true || deepseek || kimi
  const kimiContext = resolveKimiContextWindow(b.model)
  const kimiMaxTokens = resolveKimiMaxTokens(b.model)
  const model = {
    id: b.model,
    name: b.model,
    api,
    // Keep agim backend name as provider id (auth / cost grouping), but copy
    // vendor compat fields so pi-ai emits thinking + reasoning_content.
    provider: b.name,
    baseUrl,
    reasoning,
    input: (catalogModel?.input?.length
      ? [...catalogModel.input]
      : (kimi ? ['text', 'image'] : ['text'])) as ('text' | 'image')[],
    cost: catalogModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Uncatalogued / private endpoints must not inherit a 128k assumption —
    // that delays compaction until the provider already overflows.
    contextWindow: catalogModel?.contextWindow ?? kimiContext ?? unknownContextWindow,
    maxTokens: b.maxTokens ?? catalogModel?.maxTokens ?? kimiMaxTokens ?? 8192,
    ...(catalogModel?.thinkingLevelMap
      ? { thinkingLevelMap: { ...(catalogModel.thinkingLevelMap as Record<string, string | null>) } }
      : deepseek
        ? { thinkingLevelMap: { ...DEEPSEEK_THINKING_LEVEL_MAP } }
        : kimiK3
          ? { thinkingLevelMap: { ...KIMI_K3_THINKING_LEVEL_MAP } }
          : kimiK2 || kimi
            ? { thinkingLevelMap: { ...KIMI_K2_THINKING_LEVEL_MAP } }
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
        : kimiK3
          ? {
              // K3: top-level reasoning_effort (openai format) + preserve
              // reasoning_content across tool turns.
              compat: {
                thinkingFormat: 'openai' as const,
                supportsReasoningEffort: true,
                supportsDeveloperRole: false,
                requiresReasoningContentOnAssistantMessages: true,
                maxTokensField: 'max_completion_tokens' as const,
              },
            }
          : kimiK2 || kimi
            ? {
                // K2.x: thinking: { type } (+ reasoning_effort when mapped).
                compat: {
                  thinkingFormat: 'deepseek' as const,
                  supportsDeveloperRole: false,
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
