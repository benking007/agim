// Shared LLM vendor presets for Agim Agent first-run / quick-enable.
//
// Single source of truth for CLI + Web (web-app mirrors the wire shape via
// /api/llm/presets). Adding a vendor later = append one entry here.

export type LlmPresetKey =
  | 'deepseek'
  | 'moonshot'
  | 'zhipu'
  | 'mimo'
  | 'custom'

export interface LlmPresetDef {
  key: LlmPresetKey
  /** Human label for CLI lists (Web uses i18n keys). */
  label: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  /** Primary model for Agim Agent (native-chat). */
  model: string
  /** Optional cheaper model for cheap / evaluator roles. */
  cheapModel?: string
  /**
   * All models to register under one API key on quick-enable.
   * Defaults to `[model, cheapModel?]` when omitted.
   */
  models?: readonly string[]
  /** Suggested backend name stem (unique-ified by callers). */
  baseName: string
  /** Where operators get an API key. */
  apiKeyDoc?: string
  /**
   * Default Agim Agent thinking level when session.variant is auto/empty.
   * Mapped onto pi-ai ThinkingLevel at runtime (`max` → `xhigh`).
   */
  defaultThinking?: 'off' | 'high' | 'max'
}

/** Curated presets. First entry is the Agim Agent default. */
export const LLM_PRESETS: readonly LlmPresetDef[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek (recommended)',
    provider: 'openai-compat',
    // Official OpenAI-compatible base (no /v1); `/chat/completions` is appended.
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    cheapModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    baseName: 'deepseek-agim',
    apiKeyDoc: 'platform.deepseek.com → API Keys',
    defaultThinking: 'high',
  },
  {
    key: 'moonshot',
    // Brand label shown in CLI / grouping (Web i18n: "Kimi").
    label: 'Kimi',
    provider: 'openai-compat',
    // China OpenAI-compatible base (platform.kimi.com). International keys
    // use https://api.moonshot.ai/v1 — operators can override in Custom.
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    cheapModel: 'kimi-k2.6',
    models: ['kimi-k3', 'kimi-k2.6'],
    baseName: 'kimi-agim',
    apiKeyDoc: 'platform.kimi.com → API Keys',
    // K3 always thinks; high matches Agim composer default (effort high/max).
    defaultThinking: 'high',
  },
  {
    key: 'zhipu',
    // Brand label (Web i18n: 智谱 GLM / GLM).
    label: 'GLM',
    provider: 'openai-compat',
    // OpenAI-compatible PaaS v4 (docs.bigmodel.cn). Intl: api.z.ai/api/paas/v4.
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    cheapModel: 'glm-4.7-flash',
    models: ['glm-5.2', 'glm-4.7-flash'],
    baseName: 'glm-agim',
    apiKeyDoc: 'open.bigmodel.cn → API Keys',
    // GLM-5.2 thinking defaults on; high matches Agim composer effort chips.
    defaultThinking: 'high',
  },
  {
    key: 'mimo',
    // Brand label (Web i18n: 小米 MiMo / MiMo). Distinct from the MiMo Code CLI agent.
    label: 'MiMo',
    provider: 'openai-compat',
    // Pay-as-you-go OpenAI-compat (mimo.mi.com docs). Token Plan uses a different host.
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    cheapModel: 'mimo-v2.5',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    baseName: 'mimo-agim',
    apiKeyDoc: 'platform.xiaomimimo.com → API Keys',
    // Deep thinking defaults on for V2.5; toggle via thinking.type (no effort field).
    defaultThinking: 'high',
  },
  {
    key: 'custom',
    label: 'Custom / other openai-compatible',
    provider: 'openai-compat',
    baseUrl: '',
    model: '',
    baseName: 'agim-api',
  },
] as const

export const DEFAULT_LLM_PRESET: LlmPresetDef = LLM_PRESETS[0] as LlmPresetDef

export function getLlmPreset(key: string | undefined | null): LlmPresetDef | undefined {
  if (!key) return undefined
  return LLM_PRESETS.find((p) => p.key === key)
}

/** Models registered for a preset (primary first). */
export function presetModels(preset: LlmPresetDef): string[] {
  if (preset.models && preset.models.length > 0) {
    return [...new Set(preset.models.filter((m) => !!m.trim()))]
  }
  const out = [preset.model]
  if (preset.cheapModel && preset.cheapModel !== preset.model) out.push(preset.cheapModel)
  return out.filter((m) => !!m.trim())
}

/**
 * Backend name stem for a preset model.
 * Prefer the model id itself so UI / `/model` switch show the same string
 * operators already know (e.g. `deepseek-v4-pro`).
 */
export function presetBackendStem(baseName: string, model: string, _index: number): string {
  // Keep dots so ids like `kimi-k2.6` stay identical to the vendor model string.
  const safe = model.trim().toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/\.-|-\./g, '-')
    .replace(/^-|-$/g, '')
  if (safe && /^[a-z0-9]/.test(safe)) return safe
  return baseName
}

export function suggestLlmBackendName(base: string, existing: string[]): string {
  const used = new Set(existing.map((n) => n.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; i < 200; i += 1) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}`
}

/** Detect DeepSeek endpoints (official + common proxies that keep the hostname). */
export function isDeepSeekBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes('deepseek.com')
  } catch {
    return /deepseek\.com/i.test(baseUrl)
  }
}

/**
 * Detect Kimi / Moonshot endpoints (China `moonshot.cn` + international
 * `moonshot.ai`, plus hostnames that keep "kimi").
 */
export function isKimiBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host.includes('moonshot.cn')
      || host.includes('moonshot.ai')
      || host.includes('kimi.com')
      || host.includes('kimi.ai')
  } catch {
    return /moonshot\.(cn|ai)|kimi\.(com|ai)/i.test(baseUrl)
  }
}

/** Kimi K3 family — always-on thinking via top-level `reasoning_effort`. */
export function isKimiK3Model(model: string | undefined | null): boolean {
  return /^kimi-k3\b/i.test((model ?? '').trim())
}

/**
 * Kimi K2.x family — `thinking: { type: enabled|disabled }` (+ optional keep).
 * Includes `kimi-k2.5` / `kimi-k2.6` / `kimi-k2.7-code` (+ highspeed).
 */
export function isKimiK2Model(model: string | undefined | null): boolean {
  return /^kimi-k2(\.|-)/i.test((model ?? '').trim())
}

export function isKimiModel(model: string | undefined | null): boolean {
  return isKimiK3Model(model) || isKimiK2Model(model) || /^kimi-/i.test((model ?? '').trim())
}

/**
 * Detect Zhipu / GLM endpoints (China `bigmodel.cn` + international `z.ai`).
 */
export function isZhipuBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host.includes('bigmodel.cn')
      || host.includes('bigmodel.com')
      || host === 'api.z.ai'
      || host.endsWith('.z.ai')
  } catch {
    return /bigmodel\.cn|bigmodel\.com|(^|[/.])z\.ai/i.test(baseUrl)
  }
}

/** GLM-5.2+ — `thinking.type` + `reasoning_effort` (max/high/…). */
export function isGlm52Model(model: string | undefined | null): boolean {
  return /^glm-5\.2\b/i.test((model ?? '').trim())
}

/** Any current GLM chat model id (`glm-4.x` / `glm-5…`). */
export function isGlmModel(model: string | undefined | null): boolean {
  return /^glm-/i.test((model ?? '').trim())
}

/**
 * Detect Xiaomi MiMo API hosts (pay-as-you-go + Token Plan CN/intl).
 * See https://mimo.mi.com/docs/zh-CN/quick-start/faq/api-integration
 */
export function isMimoBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host.includes('xiaomimimo.com') || host.includes('mimo.mi.com')
  } catch {
    return /xiaomimimo\.com|mimo\.mi\.com/i.test(baseUrl)
  }
}

/** Current MiMo chat models (`mimo-v2.5` / `mimo-v2.5-pro` / UltraSpeed…). */
export function isMimoModel(model: string | undefined | null): boolean {
  return /^mimo-v/i.test((model ?? '').trim())
}

/**
 * Map a baseUrl onto a built-in preset key using vendor host families
 * (not exact hostname). Used by quick-enable dedupe so intl hosts
 * (`api.moonshot.ai`, `api.z.ai`, …) collide with the China defaults.
 * `custom` is never returned.
 */
export function builtinPresetKeyForBaseUrl(
  baseUrl: string | undefined | null,
): Exclude<LlmPresetKey, 'custom'> | null {
  if (isDeepSeekBaseUrl(baseUrl)) return 'deepseek'
  if (isKimiBaseUrl(baseUrl)) return 'moonshot'
  if (isZhipuBaseUrl(baseUrl)) return 'zhipu'
  if (isMimoBaseUrl(baseUrl)) return 'mimo'
  return null
}

/**
 * Default /think fallback for a backend URL (and optional model id).
 * DeepSeek / Kimi / GLM / MiMo default to their preset's `defaultThinking`.
 */
export function resolveDefaultThinking(
  baseUrl: string | undefined | null,
  model?: string | undefined | null,
): 'off' | 'high' | 'max' {
  if (isDeepSeekBaseUrl(baseUrl) || /^deepseek/i.test(model ?? '')) {
    return getLlmPreset('deepseek')?.defaultThinking ?? 'high'
  }
  if (isKimiBaseUrl(baseUrl) || isKimiModel(model)) {
    return getLlmPreset('moonshot')?.defaultThinking ?? 'high'
  }
  if (isZhipuBaseUrl(baseUrl) || isGlmModel(model)) {
    return getLlmPreset('zhipu')?.defaultThinking ?? 'high'
  }
  if (isMimoBaseUrl(baseUrl) || isMimoModel(model)) {
    return getLlmPreset('mimo')?.defaultThinking ?? 'high'
  }
  return 'off'
}

/**
 * Map agim session.variant (/think) → pi-ai ThinkingLevel.
 * DeepSeek / Kimi / GLM / MiMo map xhigh→max; unsupported mid levels stay
 * as-is for providers that accept them (Kimi K3 / GLM-5.2 support low/high/max).
 */
export function mapVariantToThinkingLevel(
  variant: string | undefined | null,
  fallback: 'off' | 'high' | 'max' = 'high',
): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const v = (variant ?? '').trim().toLowerCase()
  if (!v || v === 'auto') {
    return fallback === 'max' ? 'xhigh' : fallback
  }
  if (v === 'off' || v === 'none') return 'off'
  if (v === 'max' || v === 'xhigh') return 'xhigh'
  if (v === 'high') return 'high'
  if (v === 'medium') return 'medium'
  if (v === 'low') return 'low'
  if (v === 'minimal') return 'minimal'
  return fallback === 'max' ? 'xhigh' : fallback
}
