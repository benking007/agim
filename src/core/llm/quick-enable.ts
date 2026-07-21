// One-shot enable path: pick a vendor preset + paste API key → write
// llmBackends + secret + role bindings + defaultAgent=agim.
// Used by `agim setup llm quick`, POST /api/llm/quick-enable, and Web dialogs.

import { configSchema } from '../config-schema.js'
import { readConfigObject, updateConfigObject } from '../config-store.js'
import { clearAgentCache } from '../onboarding.js'
import { loadFromConfig as loadLlmFromConfig } from './registry.js'
import { saveSecret } from './secrets.js'
import {
  DEFAULT_LLM_PRESET,
  getLlmPreset,
  suggestLlmBackendName,
  type LlmPresetKey,
} from './presets.js'

export interface QuickEnableInput {
  /** Preset key; defaults to DeepSeek. */
  preset?: LlmPresetKey | string
  apiKey: string
  /** Override backend name (else unique stem from preset.baseName). */
  name?: string
  /** Override primary model (else preset.model). */
  model?: string
  /** Override base URL (else preset.baseUrl). Required for `custom`. */
  baseUrl?: string
  /** Also bind cheap/evaluator to the same backend (default true). */
  bindCheapRoles?: boolean
  /** Set defaultAgent to agim (default true). */
  setDefaultAgent?: boolean
}

export interface QuickEnableResult {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  roles: Record<string, string>
  defaultAgent: string
  preset: string
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
  const provider = preset.provider
  const baseUrl = (input.baseUrl?.trim() || preset.baseUrl).trim()
  const model = (input.model?.trim() || preset.model).trim()
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new QuickEnableError('validation', 'baseUrl must be an http(s) URL')
  }
  if (!model) throw new QuickEnableError('validation', 'model is required')

  const current = (await readConfigObject()) as RawConfig
  const existingNames = (current.llmBackends ?? []).map((b) => b.name)
  const name = (input.name?.trim()
    || suggestLlmBackendName(preset.baseName, existingNames)).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) {
    throw new QuickEnableError('validation', 'name must match [A-Za-z0-9][A-Za-z0-9-]*')
  }

  const bindCheap = input.bindCheapRoles !== false
  const setDefault = input.setDefaultAgent !== false

  let result: QuickEnableResult | undefined
  try {
    const update = await updateConfigObject((stored) => {
      const cfg = stored as RawConfig
      const backends = cfg.llmBackends ?? []
      if (backends.some((b) => b.name === name)) {
        throw new QuickEnableError('conflict', `backend "${name}" already exists`)
      }
      const nextBackend: RawBackend = {
        name,
        provider,
        baseUrl,
        model,
        label: preset.key === 'custom' ? undefined : preset.key,
      }
      const roles: Record<string, string> = { ...(cfg.llmRoles ?? {}) }
      roles['native-chat'] = name
      if (bindCheap) {
        roles.cheap = name
        roles.evaluator = name
      }
      const agents = Array.isArray(cfg.agents) ? [...cfg.agents] : []
      if (!agents.includes('agim') && !agents.includes('native')) {
        agents.push('agim')
      }
      const next: RawConfig = {
        ...cfg,
        llmBackends: [...backends, nextBackend],
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
        name,
        provider,
        baseUrl,
        model,
        roles,
        defaultAgent: String(next.defaultAgent ?? 'agim'),
        preset: preset.key,
      }
      return { config: next, result: undefined }
    })
    void update
  } catch (err) {
    if (err instanceof QuickEnableError) throw err
    throw err
  }

  saveSecret(name, apiKey)
  // Reload registry so Agim Agent sees the new backend immediately.
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
