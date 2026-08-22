/**
 * Fill missing built-in preset models onto an already-configured vendor
 * group (e.g. DeepSeek pro/flash from an older install → add vision).
 * Reuses the existing sibling API key — operators do not re-paste it.
 */

import { configSchema } from '../config-schema.js'
import { readConfigObject, updateConfigObject } from '../config-store.js'
import { clearAgentCache } from '../onboarding.js'
import { loadFromConfig as loadLlmFromConfig } from './registry.js'
import { loadSecretsFile, resolveSecret, saveSecret } from './secrets.js'
import {
  builtinPresetKeyForBaseUrl,
  getLlmPreset,
  missingPresetModels,
  presetBackendStem,
  suggestLlmBackendName,
  type LlmPresetKey,
} from './presets.js'

export class SyncPresetError extends Error {
  constructor(
    readonly code: 'validation' | 'not_found' | 'config',
    message: string,
  ) {
    super(message)
    this.name = 'SyncPresetError'
  }
}

interface RawBackend {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  label?: string
  strictTools?: boolean
  thinkingFormat?: 'off' | 'deepseek' | 'openai'
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  extraHeaders?: Record<string, string>
  temperature?: number
  maxTokens?: number
  contextWindow?: number
}

interface RawConfig {
  llmBackends?: RawBackend[]
  llmRoles?: Record<string, string>
  [k: string]: unknown
}

export interface SyncPresetResult {
  preset: string
  added: Array<{ name: string; model: string }>
}

function matchesPreset(b: RawBackend, key: LlmPresetKey): boolean {
  if ((b.label ?? '').trim().toLowerCase() === key) return true
  return builtinPresetKeyForBaseUrl(b.baseUrl) === key
}

export async function syncMissingPresetModels(presetKey: string): Promise<SyncPresetResult> {
  const preset = getLlmPreset(presetKey)
  if (!preset || preset.key === 'custom') {
    throw new SyncPresetError('validation', 'preset must be a built-in vendor (deepseek / moonshot / zhipu / mimo)')
  }

  const current = (await readConfigObject()) as RawConfig
  const existing = current.llmBackends ?? []
  const group = existing.filter((b) => matchesPreset(b, preset.key))
  if (group.length === 0) {
    throw new SyncPresetError('not_found', `provider preset "${preset.key}" is not configured`)
  }

  const missing = missingPresetModels(group, preset)
  if (missing.length === 0) {
    return { preset: preset.key, added: [] }
  }

  const secrets = loadSecretsFile()
  let donor: RawBackend | undefined
  let apiKey: string | undefined
  for (const b of group) {
    const key = resolveSecret(b.name, secrets, { provider: b.provider, baseUrl: b.baseUrl })
    if (key) {
      donor = b
      apiKey = key
      break
    }
  }
  if (!donor || !apiKey) {
    throw new SyncPresetError(
      'validation',
      `no API key found on existing "${preset.key}" backends — set a key on one model first`,
    )
  }

  const usedNames = existing.map((b) => b.name)
  const planned: RawBackend[] = []
  for (let i = 0; i < missing.length; i += 1) {
    const modelId = missing[i]
    if (!modelId) continue
    const stem = presetBackendStem(preset.baseName, modelId, i)
    const name = suggestLlmBackendName(stem, usedNames)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new SyncPresetError('validation', `cannot derive a safe backend name for ${modelId}`)
    }
    usedNames.push(name)
    planned.push({
      name,
      provider: donor.provider,
      baseUrl: donor.baseUrl,
      model: modelId,
      label: preset.key,
      ...(donor.strictTools ? { strictTools: true } : {}),
      ...(donor.thinkingFormat ? { thinkingFormat: donor.thinkingFormat } : {}),
      ...(donor.maxTokensField ? { maxTokensField: donor.maxTokensField } : {}),
    })
  }

  try {
    await updateConfigObject((stored) => {
      const cfg = stored as RawConfig
      const backends = cfg.llmBackends ?? []
      for (const b of planned) {
        if (backends.some((x) => x.name.toLowerCase() === b.name.toLowerCase())) {
          throw new SyncPresetError('config', `backend "${b.name}" already exists`)
        }
      }
      const next: RawConfig = { ...cfg, llmBackends: [...backends, ...planned] }
      const parsed = configSchema.safeParse(next)
      if (!parsed.success) {
        throw new SyncPresetError(
          'config',
          `config validation failed: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        )
      }
      return { config: next, result: undefined }
    })
  } catch (err) {
    if (err instanceof SyncPresetError) throw err
    throw err
  }

  for (const b of planned) {
    saveSecret(b.name, apiKey)
  }
  try {
    const cfg = (await readConfigObject()) as RawConfig
    loadLlmFromConfig({
      llmBackends: cfg.llmBackends as never,
      llmRoles: cfg.llmRoles,
    })
  } catch {
    /* next start reloads */
  }
  clearAgentCache()

  return {
    preset: preset.key,
    added: planned.map((b) => ({ name: b.name, model: b.model })),
  }
}
