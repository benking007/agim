/**
 * Web mirror of `src/core/llm/presets.ts`.
 *
 * Keep keys / defaults aligned with the backend — Web can also fetch
 * `/api/llm/presets` at runtime; these constants power first paint and
 * offline form defaults (DeepSeek is the Agim Agent recommended preset).
 */

export type LlmPresetKey = 'deepseek' | 'moonshot' | 'zhipu' | 'mimo' | 'custom'

export interface LlmPresetDef {
  key: LlmPresetKey
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  cheapModel?: string
  models?: string[]
  baseName: string
  defaultThinking?: 'off' | 'high' | 'max'
}

export const LLM_PRESETS: LlmPresetDef[] = [
  {
    key: 'deepseek',
    provider: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    cheapModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    baseName: 'deepseek-agim',
    defaultThinking: 'high',
  },
  {
    key: 'moonshot',
    provider: 'openai-compat',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    cheapModel: 'kimi-k2.6',
    models: ['kimi-k3', 'kimi-k2.6'],
    baseName: 'kimi-agim',
    defaultThinking: 'high',
  },
  {
    key: 'zhipu',
    provider: 'openai-compat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    cheapModel: 'glm-4.7-flash',
    models: ['glm-5.2', 'glm-4.7-flash'],
    baseName: 'glm-agim',
    defaultThinking: 'high',
  },
  {
    key: 'mimo',
    provider: 'openai-compat',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    cheapModel: 'mimo-v2.5',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    baseName: 'mimo-agim',
    defaultThinking: 'high',
  },
  {
    key: 'custom',
    provider: 'openai-compat',
    baseUrl: '',
    model: '',
    baseName: 'agim-api',
  },
]

export const DEFAULT_LLM_PRESET: LlmPresetDef = LLM_PRESETS[0] as LlmPresetDef

export function presetModels(preset: LlmPresetDef): string[] {
  if (preset.models && preset.models.length > 0) {
    return [...new Set(preset.models.filter((m) => !!m.trim()))]
  }
  const out = [preset.model]
  if (preset.cheapModel && preset.cheapModel !== preset.model) out.push(preset.cheapModel)
  return out.filter((m) => !!m.trim())
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

function hostnameOf(url: string | undefined | null): string | null {
  if (!url?.trim()) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Built-in presets already present among configured backends.
 * Matches `label` first (quick-enable writes preset key), then hostname.
 * `custom` is never considered "installed" — operators may add many customs.
 */
export function installedBuiltinPresetKeys(
  backends: Array<{ label?: string; baseUrl?: string }>,
): Set<LlmPresetKey> {
  const installed = new Set<LlmPresetKey>()
  const builtin = LLM_PRESETS.filter((p) => p.key !== 'custom')
  for (const b of backends) {
    const label = b.label?.trim().toLowerCase() as LlmPresetKey | undefined
    if (label && label !== 'custom' && builtin.some((p) => p.key === label)) {
      installed.add(label)
      continue
    }
    const host = hostnameOf(b.baseUrl)
    if (!host) continue
    const matched = builtin.find((p) => {
      const presetHost = hostnameOf(p.baseUrl)
      return !!presetHost && presetHost === host
    })
    if (matched) installed.add(matched.key)
  }
  return installed
}

/** First preset that is still available (custom always ok). */
export function firstAvailablePreset(installed: Set<LlmPresetKey>): LlmPresetKey {
  const next = LLM_PRESETS.find((p) => p.key === 'custom' || !installed.has(p.key))
  return next?.key ?? 'custom'
}
