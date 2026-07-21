/**
 * Web mirror of `src/core/llm/presets.ts`.
 *
 * Keep keys / defaults aligned with the backend — Web can also fetch
 * `/api/llm/presets` at runtime; these constants power first paint and
 * offline form defaults (DeepSeek is the Agim Agent recommended preset).
 */

export type LlmPresetKey = 'deepseek' | 'moonshot' | 'zhipu' | 'openai' | 'anthropic' | 'custom'

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
    model: 'glm-4-air',
    baseName: 'zhipu-agim',
  },
  {
    key: 'openai',
    provider: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    baseName: 'openai-agim',
  },
  {
    key: 'anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-20241022',
    baseName: 'anthropic-agim',
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
