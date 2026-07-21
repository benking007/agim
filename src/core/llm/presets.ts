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
    label: 'Moonshot Kimi',
    provider: 'openai-compat',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    baseName: 'moonshot-agim',
    apiKeyDoc: 'platform.moonshot.cn → API Keys',
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
  const safe = model.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
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
 * Map agim session.variant (/think) → pi-ai ThinkingLevel.
 * DeepSeek catalog maps xhigh→max; low/minimal/medium are clamped to high.
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
