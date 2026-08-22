// LLM registry — role-based provider lookup, Stage 1.
//
// Callers don't know (or care) which concrete backend handles their
// request; they ask the registry for a *role* ('cheap' for distill /
// intent-llm, 'evaluator' for future heartbeat) and the registry hands
// back a configured LlmProvider — or null when nothing is configured,
// in which case the caller falls back to its CLI agent path.
//
// Lifecycle:
//   - `loadFromConfig(cfg)` is called once at startup from cli.ts; it
//     instantiates one provider per `llmBackends` entry, filters out
//     unconfigured backends (no secret), and builds the role index.
//   - `reload()` re-reads the config + secrets from disk (used by web
//     "Test connection" and future hot-config reload). Tests use it to
//     swap out fixtures without restarting bun.
//   - `getProvider(role)` is the hot path; returns null fast.
//
// The registry is intentionally a module-level singleton — the same
// pattern as `core/registry.ts` (agents). Module-level state is
// acceptable here because every Stage-1 caller is server-side and
// agim's process model is single-instance.

import { logger as rootLogger } from '../logger.js'
import type { ValidatedConfig } from '../config-schema.js'
import { OpenAICompatProvider } from './openai-compat-provider.js'
import { AnthropicProvider } from './anthropic-provider.js'
import type { LlmProvider } from './provider-base.js'
import { resolveSecret, loadSecretsFile } from './secrets.js'
import {
  DEEPSEEK_VISION_MODEL,
  isDeepSeekBaseUrl,
  isDeepSeekVisionModel,
} from './presets.js'

const log = rootLogger.child({ component: 'llm-registry' })

/** Role names recognised by Stage 1 callers. Strings rather than enum so
 *  forward-compat roles (added in later stages) compile against an older
 *  agim without type errors. */
export type LlmRole = 'cheap' | 'evaluator' | 'native-chat' | 'distill' | string

/** Resolved backend wiring exposed for engines that drive their own LLM
 *  client (e.g. Agim Agent feeds this to pi-ai). Mirrors the same
 *  resolution loadFromConfig already does for the built-in providers, so the
 *  vendor-env key fallback and per-backend settings stay single-sourced. */
export type LlmThinkingFormat = 'off' | 'deepseek' | 'openai'
export type LlmMaxTokensField = 'max_tokens' | 'max_completion_tokens'

export interface LlmBackendBinding {
  name: string
  providerType: string
  model: string
  baseUrl?: string
  apiKey?: string
  extraHeaders?: Record<string, string>
  temperature?: number
  maxTokens?: number
  contextWindow?: number
  thinkingFormat?: LlmThinkingFormat
  maxTokensField?: LlmMaxTokensField
  /** DeepSeek beta strict tool schemas (see config-schema). */
  strictTools?: boolean
  /** `chat` (default) or `responses` (DeepSeek / OpenAI Responses API). */
  apiSurface?: 'chat' | 'responses'
}

interface RegistryState {
  providers: Map<string, LlmProvider>   // backend name → provider
  roles: Map<string, string>            // role name → backend name
  unconfigured: Set<string>             // backend names that lack a secret
  duplicates: Set<string>               // backend names that collided
  bindings: Map<string, LlmBackendBinding> // backend name → resolved binding
}

let state: RegistryState = freshState()

function freshState(): RegistryState {
  return {
    providers: new Map(),
    roles: new Map(),
    unconfigured: new Set(),
    duplicates: new Set(),
    bindings: new Map(),
  }
}

/**
 * Build the registry from a validated config. Idempotent — repeated
 * calls fully replace the previous state. Logs (info / warn) the load
 * outcome so operators see what landed at startup.
 */
export function loadFromConfig(cfg: ValidatedConfig | { llmBackends?: unknown; llmRoles?: unknown }): void {
  const next = freshState()
  const backends = Array.isArray((cfg as { llmBackends?: unknown[] }).llmBackends)
    ? (cfg as { llmBackends: unknown[] }).llmBackends
    : []

  // Pre-load secrets file once so each provider construction doesn't
  // re-read it from disk.
  const secrets = loadSecretsFile()

  for (const raw of backends) {
    const cfg = raw as BackendConfig
    if (!cfg || typeof cfg !== 'object' || typeof cfg.name !== 'string') continue
    if (cfg.enabled === false) {
      log.debug({ event: 'llm-registry.skip_disabled', name: cfg.name })
      continue
    }
    if (next.providers.has(cfg.name)) {
      next.duplicates.add(cfg.name)
      log.warn({ event: 'llm-registry.duplicate_name', name: cfg.name },
        `Duplicate llmBackends entry "${cfg.name}"; last wins`)
    }
    // v1.2.141 — pass backend hint so resolveSecret can fall back to
    // vendor-standard envs (DEEPSEEK_API_KEY / OPENAI_API_KEY / …) when
    // neither AGIM_LLM_SECRET_<NAME> nor llm-secrets.json carries the
    // key. Hint is best-effort — keys missing from cfg leave the hint
    // empty and the vendor fallback simply yields null.
    const apiKey = resolveSecret(cfg.name, secrets, {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
    })
    const provider = buildProvider(cfg, apiKey)
    if (!provider) continue
    if (!provider.isConfigured()) {
      next.unconfigured.add(cfg.name)
      log.info({ event: 'llm-registry.unconfigured', name: cfg.name },
        `LLM backend "${cfg.name}" has no secret; skipped (caller will fall back to CLI agent)`)
      continue
    }
    next.providers.set(cfg.name, provider)
    next.bindings.set(cfg.name, {
      name: cfg.name,
      providerType: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey,
      extraHeaders: cfg.extraHeaders,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      contextWindow: cfg.contextWindow,
      thinkingFormat: cfg.thinkingFormat,
      maxTokensField: cfg.maxTokensField,
      strictTools: cfg.strictTools,
      apiSurface: cfg.apiSurface,
    })
  }

  const roleMap = (cfg as { llmRoles?: Record<string, unknown> }).llmRoles
  if (roleMap && typeof roleMap === 'object') {
    for (const [role, backendName] of Object.entries(roleMap)) {
      if (typeof backendName !== 'string' || !backendName) continue
      next.roles.set(role, backendName)
      if (!next.providers.has(backendName)) {
        log.warn({ event: 'llm-registry.role_dangling', role, backend: backendName },
          `llmRoles.${role} points at "${backendName}" which has no configured backend`)
      }
    }
  }

  ensureVirtualDeepSeekVision(next)
  state = next
  log.info({
    event: 'llm-registry.loaded',
    backends: state.providers.size,
    roles: state.roles.size,
    unconfigured: state.unconfigured.size,
  })
}

/**
 * Get the provider configured for `role`, or null when no usable
 * backend is wired. Callers should NEVER throw on null — that's how the
 * registry tells them "fall back to your CLI path".
 */
export function getProvider(role: LlmRole): LlmProvider | null {
  const backend = state.roles.get(role)
  if (!backend) return null
  return state.providers.get(backend) ?? null
}

/** Return the first configured provider regardless of role bindings.
 *  Used as a safe fallback so native chat remains usable after adding
 *  a backend even before optional role wiring is configured. */
export function getAnyProvider(): LlmProvider | null {
  const first = state.providers.values().next()
  return first.done ? null : first.value
}

/** Look up a provider directly by backend name (mostly for the web
 *  "Test connection" button and unit tests). */
export function getProviderByName(name: string): LlmProvider | null {
  return state.providers.get(name) ?? null
}

/** Resolved backend binding for `role`, or null when no usable backend is
 *  wired. Used by engines that drive their own LLM client and
 *  need the raw provider type / model / baseUrl / key rather than agim's
 *  built-in LlmProvider object. */
export function getBackendBindingForRole(role: LlmRole): LlmBackendBinding | null {
  const backend = state.roles.get(role)
  if (!backend) return null
  return state.bindings.get(backend) ?? null
}

/** First configured backend binding regardless of role bindings. */
export function getAnyBackendBinding(): LlmBackendBinding | null {
  const first = state.bindings.values().next()
  return first.done ? null : first.value
}

/** Resolved backend binding by backend name. */
export function getBackendBindingByName(name: string): LlmBackendBinding | null {
  const exact = state.bindings.get(name)
  if (exact) return exact
  const lower = name.trim().toLowerCase()
  if (!lower) return null
  for (const [key, binding] of state.bindings) {
    if (key.toLowerCase() === lower || binding.model.toLowerCase() === lower) {
      return binding
    }
  }
  return null
}

/** List all configured backends — handy for the web UI roster. */
export function listProviders(): { name: string; providerType: string; model: string }[] {
  return Array.from(state.providers.values()).map(p => ({
    name: p.name,
    providerType: p.providerType,
    model: p.model,
  }))
}

/** Test/diagnostic: clear the registry. Used by bun tests so module
 *  state doesn't leak across cases. */
export function _resetRegistry(): void {
  state = freshState()
}

/** Diagnostic snapshot for the cost dashboard's "LLM backends" tile. */
export function describeRegistry(): {
  backends: { name: string; providerType: string; model: string }[]
  roles: Record<string, string>
  unconfigured: string[]
} {
  return {
    backends: listProviders(),
    roles: Object.fromEntries(state.roles),
    unconfigured: Array.from(state.unconfigured).sort(),
  }
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

interface BackendConfig {
  name: string
  provider: string
  model: string
  baseUrl?: string
  label?: string
  extraHeaders?: Record<string, string>
  temperature?: number
  maxTokens?: number
  contextWindow?: number
  thinkingFormat?: LlmThinkingFormat
  maxTokensField?: LlmMaxTokensField
  strictTools?: boolean
  apiSurface?: 'chat' | 'responses'
  retryOnTransient?: number
  enabled?: boolean
}

/**
 * Existing DeepSeek installs only have pro/flash rows. Parent
 * `call_agent({ backend })` must name a live registry backend, so clone
 * the first usable DeepSeek key onto the official vision SKU (in-memory,
 * not written to config.json).
 */
function ensureVirtualDeepSeekVision(next: RegistryState): void {
  const hasVision = [...next.bindings.values()].some(
    (b) => isDeepSeekVisionModel(b.model) || isDeepSeekVisionModel(b.name),
  )
  if (hasVision) return
  if (next.bindings.has(DEEPSEEK_VISION_MODEL) || next.providers.has(DEEPSEEK_VISION_MODEL)) {
    return
  }
  let donor: LlmBackendBinding | undefined
  for (const b of next.bindings.values()) {
    if (isDeepSeekBaseUrl(b.baseUrl) || /^deepseek/i.test(b.model) || /^deepseek/i.test(b.name)) {
      donor = b
      break
    }
  }
  if (!donor?.apiKey) return
  const cfg: BackendConfig = {
    name: DEEPSEEK_VISION_MODEL,
    provider: donor.providerType,
    model: DEEPSEEK_VISION_MODEL,
    baseUrl: donor.baseUrl,
    extraHeaders: donor.extraHeaders,
    temperature: donor.temperature,
    maxTokens: donor.maxTokens,
    contextWindow: donor.contextWindow,
    thinkingFormat: donor.thinkingFormat,
    maxTokensField: donor.maxTokensField,
    strictTools: donor.strictTools,
    apiSurface: donor.apiSurface,
  }
  const provider = buildProvider(cfg, donor.apiKey)
  if (!provider?.isConfigured()) return
  next.providers.set(DEEPSEEK_VISION_MODEL, provider)
  next.bindings.set(DEEPSEEK_VISION_MODEL, {
    ...donor,
    name: DEEPSEEK_VISION_MODEL,
    model: DEEPSEEK_VISION_MODEL,
  })
}

function buildProvider(cfg: BackendConfig, apiKey: string | undefined): LlmProvider | null {
  switch (cfg.provider) {
    case 'openai-compat':
      return new OpenAICompatProvider({
        name: cfg.name,
        model: cfg.model,
        apiKey,
        baseUrl: cfg.baseUrl,
        providerLabel: cfg.label,
        extraHeaders: cfg.extraHeaders,
        defaultTemperature: cfg.temperature,
        defaultMaxTokens: cfg.maxTokens,
        maxTokensField: cfg.maxTokensField,
        retryOnTransient: cfg.retryOnTransient,
        strictTools: cfg.strictTools,
      })
    case 'anthropic':
      return new AnthropicProvider({
        name: cfg.name,
        model: cfg.model,
        apiKey,
        baseUrl: cfg.baseUrl,
        providerLabel: cfg.label,
        extraHeaders: cfg.extraHeaders,
        defaultTemperature: cfg.temperature,
        defaultMaxTokens: cfg.maxTokens,
        retryOnTransient: cfg.retryOnTransient,
      })
    default:
      // Future: ollama-native, bedrock, vertex.
      log.warn({ event: 'llm-registry.unknown_provider', name: cfg.name, provider: cfg.provider },
        `Unknown LLM provider "${cfg.provider}" for backend "${cfg.name}"; skipped`)
      return null
  }
}
