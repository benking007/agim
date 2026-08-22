/**
 * Offline / first-paint fallback for LLM vendor presets.
 *
 * Runtime SSOT is `GET /api/llm/presets` (see `useLlmPresets`). Keep this
 * mirror aligned with `src/core/llm/presets.ts` — `test/unit/llm-presets-drift.test.ts`
 * fails the build when keys / baseUrl / models diverge.
 */

/** Keep types local so backend drift tests can import this file without SPA path aliases. */
export type LlmPresetKey = 'deepseek' | 'moonshot' | 'zhipu' | 'mimo' | 'custom'

export interface LlmPresetDef {
  key: LlmPresetKey
  label?: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  cheapModel?: string
  models?: string[]
  baseName: string
  apiKeyDoc?: string
  /** Offline mirror may use richer effort labels; wire API uses off|high|max. */
  defaultThinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/** @deprecated Prefer runtime presets from useLlmPresets(); kept as FALLBACK. */
export const LLM_PRESETS: LlmPresetDef[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek (recommended)',
    provider: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    cheapModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    baseName: 'deepseek-agim',
    defaultThinking: 'high',
  },
  {
    key: 'moonshot',
    label: 'Kimi',
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
    label: 'GLM',
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
    label: 'MiMo',
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
    label: 'Custom / other openai-compatible',
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

/**
 * Mirror of server `builtinPresetKeyForBaseUrl` (src/core/llm/presets.ts).
 * Keep host-family rules in sync when adding vendors.
 */
export function builtinPresetKeyForBaseUrl(baseUrl: string | undefined | null): Exclude<LlmPresetKey, 'custom'> | null {
  if (!baseUrl?.trim()) return null
  let host = ''
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    host = baseUrl.toLowerCase()
  }
  if (host.includes('deepseek.com')) return 'deepseek'
  if (
    host.includes('moonshot.cn')
    || host.includes('moonshot.ai')
    || host.includes('kimi.com')
    || host.includes('kimi.ai')
  ) {
    return 'moonshot'
  }
  if (
    host.includes('bigmodel.cn')
    || host.includes('bigmodel.com')
    || host === 'api.z.ai'
    || host.endsWith('.z.ai')
  ) {
    return 'zhipu'
  }
  if (host.includes('xiaomimimo.com') || host.includes('mimo.mi.com')) return 'mimo'
  return null
}

/**
 * Built-in presets already present among configured backends.
 * Matches `label` first (quick-enable writes preset key), then vendor
 * host family (China + intl endpoints).
 * `custom` is never considered "installed" — operators may add many customs.
 */
export function installedBuiltinPresetKeys(
  backends: Array<{ label?: string; baseUrl?: string }>,
  catalog: readonly LlmPresetDef[] = LLM_PRESETS,
): Set<LlmPresetKey> {
  const installed = new Set<LlmPresetKey>()
  const builtin = catalog.filter((p) => p.key !== 'custom')
  for (const b of backends) {
    const label = b.label?.trim().toLowerCase() as LlmPresetKey | undefined
    if (label && label !== 'custom' && builtin.some((p) => p.key === label)) {
      installed.add(label)
      continue
    }
    const family = builtinPresetKeyForBaseUrl(b.baseUrl)
    if (family) installed.add(family)
  }
  return installed
}

/** First preset that is still available (custom always ok). */
export function firstAvailablePreset(
  installed: Set<LlmPresetKey>,
  catalog: readonly LlmPresetDef[] = LLM_PRESETS,
): LlmPresetKey {
  const next = catalog.find((p) => p.key === 'custom' || !installed.has(p.key))
  return next?.key ?? 'custom'
}

/** Resolve runtime catalog or fall back to the offline mirror. */
export function resolvePresetCatalog(
  remote: { presets?: Array<Partial<LlmPresetDef> & { key: string }>; defaultPreset?: string } | undefined,
): { presets: LlmPresetDef[]; defaultPreset: LlmPresetDef } {
  const presets: LlmPresetDef[] = remote?.presets?.length
    ? remote.presets.map((p) => ({
        key: p.key as LlmPresetKey,
        label: p.label,
        provider: (p.provider ?? 'openai-compat') as LlmPresetDef['provider'],
        baseUrl: p.baseUrl ?? '',
        model: p.model ?? '',
        cheapModel: p.cheapModel,
        models: p.models,
        baseName: p.baseName ?? 'agim-api',
        apiKeyDoc: p.apiKeyDoc,
        defaultThinking: p.defaultThinking,
      }))
    : LLM_PRESETS
  const defaultKey = (remote?.defaultPreset as LlmPresetKey | undefined) ?? DEFAULT_LLM_PRESET.key
  const defaultPreset = presets.find((p) => p.key === defaultKey) ?? presets[0] ?? DEFAULT_LLM_PRESET
  return { presets, defaultPreset }
}
