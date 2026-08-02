// One-shot enable path: pick a vendor preset + paste API key → write
// llmBackends + secret + role bindings + defaultAgent=agim.
// Used by `agim setup llm quick`, POST /api/llm/quick-enable, and Web dialogs.
//
// Presets with multiple models (e.g. DeepSeek pro + flash) register every
// model under the same API key so chat can switch with `/model <backend>`.

import { configSchema } from '../config-schema.js'
import { readConfigObject, updateConfigObject } from '../config-store.js'
import { clearAgentCache } from '../onboarding.js'
import { loadFromConfig as loadLlmFromConfig } from './registry.js'
import { saveSecret } from './secrets.js'
import {
  DEEPSEEK_ANTHROPIC_BASE,
  DEEPSEEK_OPENAI_BASE,
  type DeepSeekApiDialect,
} from './deepseek-compat.js'
import {
  DEFAULT_LLM_PRESET,
  builtinPresetKeyForBaseUrl,
  getLlmPreset,
  presetBackendStem,
  presetModels,
  suggestLlmBackendName,
  type LlmPresetKey,
} from './presets.js'

export interface QuickEnableInput {
  /** Preset key; defaults to DeepSeek. */
  preset?: LlmPresetKey | string
  apiKey: string
  /** Override primary backend name (else unique stem from preset.baseName). */
  name?: string
  /** Override primary model (else preset.model). Custom-only for multi-field. */
  model?: string
  /** Override base URL (else preset.baseUrl). Required for `custom`. */
  baseUrl?: string
  /**
   * DeepSeek API dialect. `openai` (default) → Chat Completions;
   * `anthropic` → `https://api.deepseek.com/anthropic` + provider anthropic.
   */
  dialect?: DeepSeekApiDialect
  /** DeepSeek: enable beta strict tool schemas (default false). */
  strictTools?: boolean
  /** Also bind cheap/evaluator (default true; prefers secondary model). */
  bindCheapRoles?: boolean
  /** Set defaultAgent to agim (default true). */
  setDefaultAgent?: boolean
}

export interface QuickEnableBackend {
  name: string
  model: string
}

export interface QuickEnableResult {
  /** Primary backend name (native-chat). */
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  /** Primary model id. */
  model: string
  /** All backends created in this call (primary first). */
  backends: QuickEnableBackend[]
  roles: Record<string, string>
  defaultAgent: string
  preset: string
  dialect?: DeepSeekApiDialect
  strictTools?: boolean
}

export class QuickEnableError extends Error {
  constructor(
    readonly code: 'validation' | 'conflict' | 'config',
    message: string,
  ) {
    super(message)
    this.name = 'QuickEnableError'
  }
}

interface RawBackend {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  label?: string
  strictTools?: boolean
}

interface RawConfig {
  llmBackends?: RawBackend[]
  llmRoles?: Record<string, string>
  defaultAgent?: string
  agents?: string[]
  [k: string]: unknown
}

export async function quickEnableLlmPreset(input: QuickEnableInput): Promise<QuickEnableResult> {
  const apiKey = input.apiKey.trim()
  if (!apiKey) throw new QuickEnableError('validation', 'apiKey is required')

  const preset = getLlmPreset(input.preset) ?? DEFAULT_LLM_PRESET
  const dialect: DeepSeekApiDialect =
    input.dialect === 'anthropic' ? 'anthropic' : 'openai'
  const useDeepSeekAnthropic = preset.key === 'deepseek' && dialect === 'anthropic'
  const provider: 'openai-compat' | 'anthropic' = useDeepSeekAnthropic
    ? 'anthropic'
    : preset.provider
  const baseUrl = (
    input.baseUrl?.trim()
    || (useDeepSeekAnthropic ? DEEPSEEK_ANTHROPIC_BASE : preset.baseUrl)
    || (preset.key === 'deepseek' ? DEEPSEEK_OPENAI_BASE : '')
  ).trim()
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new QuickEnableError('validation', 'baseUrl must be an http(s) URL')
  }
  const strictTools = preset.key === 'deepseek' && input.strictTools === true
  try {
    const { assertSafeUrl } = await import('../url-guard.js')
    await assertSafeUrl(baseUrl, { forwardsCredentials: false })
  } catch (err) {
    const { UnsafeUrlError } = await import('../url-guard.js')
    if (err instanceof UnsafeUrlError) {
      throw new QuickEnableError('validation', `baseUrl blocked: ${err.message}`)
    }
    throw err
  }

  const isCustom = preset.key === 'custom'
  let models = isCustom
    ? [(input.model?.trim() || preset.model).trim()].filter(Boolean)
    : presetModels(preset)
  if (input.model?.trim() && isCustom) {
    models = [input.model.trim()]
  }
  if (models.length === 0 || !models[0]) {
    throw new QuickEnableError('validation', 'model is required')
  }

  const current = (await readConfigObject()) as RawConfig
  const existingBackends = current.llmBackends ?? []
  // Built-in presets are one-shot: match label (quick-enable writes preset key)
  // or the same vendor host family (hand-added custom without label — includes
  // intl hosts like api.moonshot.ai ↔ moonshot.cn). Operators must delete the
  // group before re-adding — mirrors Web installedBuiltinPresetKeys.
  if (!isCustom) {
    const already = existingBackends.some((b) => {
      if ((b.label ?? '').trim().toLowerCase() === preset.key) return true
      return builtinPresetKeyForBaseUrl(b.baseUrl) === preset.key
    })
    if (already) {
      throw new QuickEnableError(
        'conflict',
        `provider preset "${preset.key}" is already configured`,
      )
    }
  }
  const existingNames = existingBackends.map((b) => b.name)
  const usedNames = [...existingNames]
  const planned: RawBackend[] = []

  for (let i = 0; i < models.length; i += 1) {
    const modelId = models[i]!
    const stem = i === 0 && input.name?.trim()
      ? input.name.trim()
      : presetBackendStem(preset.baseName, modelId, i)
    const name = i === 0 && input.name?.trim()
      ? input.name.trim()
      : suggestLlmBackendName(stem, usedNames)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new QuickEnableError('validation', 'name must match [A-Za-z0-9][A-Za-z0-9._-]*')
    }
    if (usedNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
      throw new QuickEnableError('conflict', `backend "${name}" already exists`)
    }
    usedNames.push(name)
    planned.push({
      name,
      provider,
      baseUrl,
      model: modelId,
      label: isCustom ? undefined : preset.key,
      ...(strictTools ? { strictTools: true } : {}),
    })
  }

  const bindCheap = input.bindCheapRoles !== false
  const setDefault = input.setDefaultAgent !== false
  const primary = planned[0]!
  const secondary = planned[1]

  let result: QuickEnableResult | undefined
  try {
    const update = await updateConfigObject((stored) => {
      const cfg = stored as RawConfig
      const backends = cfg.llmBackends ?? []
      for (const b of planned) {
        if (backends.some((x) => x.name === b.name)) {
          throw new QuickEnableError('conflict', `backend "${b.name}" already exists`)
        }
      }
      const roles: Record<string, string> = { ...(cfg.llmRoles ?? {}) }
      roles['native-chat'] = primary.name
      if (bindCheap) {
        const cheapName = secondary?.name ?? primary.name
        roles.cheap = cheapName
        roles.evaluator = cheapName
      }
      const agents = Array.isArray(cfg.agents) ? [...cfg.agents] : []
      if (!agents.includes('agim') && !agents.includes('native')) {
        agents.push('agim')
      }
      const next: RawConfig = {
        ...cfg,
        llmBackends: [...backends, ...planned],
        llmRoles: roles,
        agents,
        ...(setDefault ? { defaultAgent: 'agim' } : {}),
      }
      const parsed = configSchema.safeParse(next)
      if (!parsed.success) {
        throw new QuickEnableError(
          'config',
          `config validation failed: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        )
      }
      result = {
        name: primary.name,
        provider,
        baseUrl,
        model: primary.model,
        backends: planned.map((b) => ({ name: b.name, model: b.model })),
        roles,
        defaultAgent: String(next.defaultAgent ?? 'agim'),
        preset: preset.key,
        ...(preset.key === 'deepseek' ? { dialect } : {}),
        ...(strictTools ? { strictTools: true } : {}),
      }
      return { config: next, result: undefined }
    })
    void update
  } catch (err) {
    if (err instanceof QuickEnableError) throw err
    throw err
  }

  for (const b of planned) {
    saveSecret(b.name, apiKey)
  }
  // Reload registry so Agim Agent sees the new backends immediately.
  try {
    const cfg = (await readConfigObject()) as RawConfig
    loadLlmFromConfig({
      llmBackends: cfg.llmBackends as never,
      llmRoles: cfg.llmRoles,
    })
  } catch {
    /* best-effort — next start will reload */
  }
  clearAgentCache()

  if (!result) throw new QuickEnableError('config', 'quick-enable failed unexpectedly')
  return result
}
