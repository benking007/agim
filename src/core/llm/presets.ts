// Shared LLM vendor presets for Agim Agent first-run / quick-enable.
//
// Single source of truth for CLI + Web (web-app mirrors the wire shape via
// /api/llm/presets). Adding a vendor later = append one entry here.

export type LlmPresetKey =
  | 'deepseek'
  | 'moonshot'
  | 'zhipu'
  | 'openai'
  | 'anthropic'
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
    label: 'Zhipu GLM',
    provider: 'openai-compat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-air',
    baseName: 'zhipu-agim',
    apiKeyDoc: 'open.bigmodel.cn',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    provider: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    baseName: 'openai-agim',
    apiKeyDoc: 'platform.openai.com → API keys',
  },
  {
    key: 'anthropic',
    label: 'Anthropic (native)',
    // No trailing /v1 — Anthropic provider appends `/v1/messages`.
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-20241022',
    baseName: 'anthropic-agim',
    apiKeyDoc: 'console.anthropic.com → API Keys',
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
 * Default /think fallback for a backend URL (and optional model id).
 * DeepSeek + Kimi default to their preset's `defaultThinking` (usually high).
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
  return 'off'
}

/**
 * Map agim session.variant (/think) → pi-ai ThinkingLevel.
 * DeepSeek / Kimi map xhigh→max; unsupported mid levels stay as-is for
 * providers that accept them (Kimi K3 supports low/high/max).
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
