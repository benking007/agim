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
  isGlm52Model,
  isGlmModel,
  isKimiBaseUrl,
  isKimiK2Model,
  isKimiK3Model,
  isKimiModel,
  isMimoBaseUrl,
  isMimoModel,
  isZhipuBaseUrl,
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

/**
 * GLM-5.2+: `thinking: { type }` + `reasoning_effort`.
 * Docs map low/medium → high, xhigh → max; none/minimal abandon thinking.
 */
const GLM52_THINKING_LEVEL_MAP = {
  minimal: 'none',
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
} as const

/** Older GLM thinking models (4.5–4.7 / 5.x without effort): type only. */
const GLM_THINKING_LEVEL_MAP = {
  minimal: null,
  low: null,
  medium: null,
  high: 'high',
  xhigh: 'max',
} as const

/**
 * Xiaomi MiMo V2.5: `thinking: { type: enabled|disabled }` only
 * (no reasoning_effort). Defaults thinking on for Pro / base.
 */
const MIMO_THINKING_LEVEL_MAP = {
  minimal: null,
  low: null,
  medium: null,
  high: 'high',
  xhigh: 'max',
} as const

function resolveVendorContextWindow(modelId: string): number | undefined {
  if (isKimiK3Model(modelId)) return 1_000_000
  if (/^kimi-k2\./i.test(modelId)) return 256_000
  if (isKimiModel(modelId)) return 256_000
  if (isGlm52Model(modelId) || /^glm-5\b/i.test(modelId)) return 1_000_000
  if (/^glm-4\.7/i.test(modelId)) return 200_000
  if (isGlmModel(modelId)) return 128_000
  if (isMimoModel(modelId)) return 1_000_000
  return undefined
}

function resolveVendorMaxTokens(modelId: string): number | undefined {
  if (isKimiK3Model(modelId)) return 131_072
  if (isKimiK2Model(modelId)) return 32_768
  if (isGlm52Model(modelId)) return 128_000
  if (/^glm-4\.7/i.test(modelId)) return 65_536
  if (isGlmModel(modelId)) return 16_384
  if (isMimoModel(modelId)) return 128_000
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
  const zhipu = isZhipuBaseUrl(baseUrl)
    || catalogModel?.provider === 'zhipu'
    || isGlmModel(b.model)
  const glm52 = zhipu && isGlm52Model(b.model)
  const mimo = isMimoBaseUrl(baseUrl) || isMimoModel(b.model)
  // Explicit thinkingFormat on the backend wins over URL/model heuristics
  // (custom OpenAI-compat gateways that clone DeepSeek/Kimi wire shapes).
  const thinkingOverride = b.thinkingFormat
  const heuristicReasoning = catalogModel?.reasoning === true || deepseek || kimi || zhipu || mimo
  const reasoning = thinkingOverride === 'off'
    ? false
    : thinkingOverride === 'deepseek' || thinkingOverride === 'openai'
      ? true
      : heuristicReasoning
  const vendorContext = resolveVendorContextWindow(b.model)
  const vendorMaxTokens = resolveVendorMaxTokens(b.model)
  // Vendor maps win when we recognize the endpoint/model — pi catalog may
  // only carry partial compat (e.g. glm-5.2 → maxTokensField only).
  const overrideThinkingLevelMap = thinkingOverride === 'openai'
    ? { ...KIMI_K3_THINKING_LEVEL_MAP }
    : thinkingOverride === 'deepseek'
      ? { ...DEEPSEEK_THINKING_LEVEL_MAP }
      : undefined
  const heuristicThinkingLevelMap = thinkingOverride
    ? undefined
    : deepseek
      ? { ...DEEPSEEK_THINKING_LEVEL_MAP }
      : kimiK3
        ? { ...KIMI_K3_THINKING_LEVEL_MAP }
        : kimiK2 || kimi
          ? { ...KIMI_K2_THINKING_LEVEL_MAP }
          : glm52
            ? { ...GLM52_THINKING_LEVEL_MAP }
            : zhipu
              ? { ...GLM_THINKING_LEVEL_MAP }
              : mimo
                ? { ...MIMO_THINKING_LEVEL_MAP }
                : undefined
  const vendorThinkingLevelMap = overrideThinkingLevelMap ?? heuristicThinkingLevelMap
  // Explicit 'off' must also suppress catalog thinkingLevelMap (e.g. deepseek-v4-pro).
  const thinkingLevelMap = thinkingOverride === 'off'
    ? undefined
    : vendorThinkingLevelMap
      ?? (catalogModel?.thinkingLevelMap
        ? { ...(catalogModel.thinkingLevelMap as Record<string, string | null>) }
        : undefined)
  const overrideCompat = thinkingOverride === 'deepseek'
    ? {
        thinkingFormat: 'deepseek' as const,
        supportsDeveloperRole: false,
        requiresReasoningContentOnAssistantMessages: true,
        ...(b.maxTokensField ? { maxTokensField: b.maxTokensField } : {}),
      }
    : thinkingOverride === 'openai'
      ? {
          thinkingFormat: 'openai' as const,
          supportsReasoningEffort: true,
          supportsDeveloperRole: false,
          requiresReasoningContentOnAssistantMessages: true,
          maxTokensField: (b.maxTokensField ?? 'max_completion_tokens') as 'max_completion_tokens',
        }
      : undefined
  const heuristicCompat = thinkingOverride
    ? undefined
    : deepseek
      ? {
          thinkingFormat: 'deepseek' as const,
          requiresReasoningContentOnAssistantMessages: true,
        }
      : kimiK3
        ? {
            thinkingFormat: 'openai' as const,
            supportsReasoningEffort: true,
            supportsDeveloperRole: false,
            requiresReasoningContentOnAssistantMessages: true,
            maxTokensField: 'max_completion_tokens' as const,
          }
        : kimiK2 || kimi
          ? {
              thinkingFormat: 'deepseek' as const,
              supportsDeveloperRole: false,
              requiresReasoningContentOnAssistantMessages: true,
            }
          : zhipu
            ? {
                // GLM OpenAI-compat: thinking.type (+ reasoning_effort on 5.2+).
                thinkingFormat: 'deepseek' as const,
                supportsReasoningEffort: glm52,
                supportsDeveloperRole: false,
                requiresReasoningContentOnAssistantMessages: true,
              }
            : mimo
              ? {
                  // MiMo OpenAI-compat: thinking.type only; max_completion_tokens.
                  thinkingFormat: 'deepseek' as const,
                  supportsDeveloperRole: false,
                  requiresReasoningContentOnAssistantMessages: true,
                  maxTokensField: 'max_completion_tokens' as const,
                }
              : undefined
  const vendorCompat = overrideCompat ?? heuristicCompat
  const catalogCompat = catalogModel?.compat
    ? { ...(catalogModel.compat as Record<string, unknown>) }
    : undefined
  // 'off' clears catalog/vendor thinking compat entirely; token-field may still apply.
  let compat: Record<string, unknown> | undefined = thinkingOverride === 'off'
    ? undefined
    : vendorCompat
      ? { ...(catalogCompat ?? {}), ...vendorCompat }
      : catalogCompat
  // Allow custom backends to override only the token field (including when thinking is off).
  if (b.maxTokensField) {
    compat = { ...(compat ?? {}), maxTokensField: b.maxTokensField }
  }
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
      : (kimi || zhipu || mimo ? ['text', 'image'] : ['text'])) as ('text' | 'image')[],
    cost: catalogModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Explicit contextWindow wins; else catalog / vendor / conservative default.
    contextWindow: b.contextWindow
      ?? catalogModel?.contextWindow
      ?? vendorContext
      ?? unknownContextWindow,
    maxTokens: b.maxTokens ?? catalogModel?.maxTokens ?? vendorMaxTokens ?? 8192,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(compat ? { compat } : {}),
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
