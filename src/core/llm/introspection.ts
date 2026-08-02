// Introspection helper — bridges the registry to the existing CLI-style
// "give me a string back" pattern that distill / consolidate / intent
// already use.
//
// Callers don't want to know about LlmMessage[] / ChatResult. They have
// a flat prompt string and a per-call deadline; they want a Promise<{
// text, costUsd }> back. This file does that mapping in one place so
// every introspection caller stays a 1-line change.

import { logger as rootLogger } from '../logger.js'
import { getBackendBindingByName, getProvider, type LlmRole } from './registry.js'
import { LlmProviderError, type LlmMessage, type LlmUsage } from './provider-base.js'
import {
  isDeepSeekBaseUrl,
  isKimiBaseUrl,
  isKimiK2Model,
  isKimiK3Model,
  isMimoBaseUrl,
  isZhipuBaseUrl,
} from './presets.js'

const log = rootLogger.child({ component: 'llm-introspection' })

export interface IntrospectionInput {
  /** Role name to look up in the registry. */
  role: LlmRole
  /** The user prompt. Required. */
  prompt: string
  /** Optional system prompt prepended as a system message. */
  system?: string
  /** Hard deadline. Default 30s — short enough that a stuck provider
   *  trips fallback fast, long enough that legitimate JSON extraction
   *  on a free-tier model completes. */
  timeoutMs?: number
  /** Caller may pass through an AbortSignal (e.g. distill's queue is
   *  draining); we merge it with timeoutMs. */
  signal?: AbortSignal
  /** Per-call temperature override (cheap callers usually want 0.2; the
   *  provider default is already low so this is rarely needed). */
  temperature?: number
  /** Per-call model override; falls back to the provider's default. */
  model?: string
  /** Ask the provider for JSON Output when supported (DeepSeek / OpenAI). */
  jsonMode?: boolean
}

export interface IntrospectionResult {
  /** Plain text body. Empty string means "model returned nothing useful";
   *  the caller decides whether that's a failure. */
  text: string
  /** Aggregate usage from the provider. */
  usage: LlmUsage
  /** Backend name that handled the request; useful for audit rows. */
  backendName: string
  /** Provider type label (e.g. "deepseek" / "openai-compat") for the
   *  cost dashboard. */
  providerType: string
  /** Elapsed wall-clock time. */
  durationMs: number
}

/**
 * Try to satisfy the introspection request via the configured backend
 * for `role`. Returns null when:
 *   - no provider is wired for this role, OR
 *   - the provider call failed (errors are logged + classified, never
 *     re-thrown — the caller's fallback path takes over).
 *
 * The "return null on failure" contract is exactly what distill /
 * consolidate / intent want: they then fall back to spawning their
 * CLI agent and the user notices nothing.
 */
export async function tryIntrospect(input: IntrospectionInput): Promise<IntrospectionResult | null> {
  const provider = getProvider(input.role)
  if (!provider) return null

  const messages: LlmMessage[] = [{ role: 'user', content: input.prompt }]
  const startedAt = Date.now()
  // Heuristic: evaluator / JSON-shaped prompts benefit from response_format.
  const wantsJson = input.jsonMode === true
    || input.role === 'evaluator'
    || /\bjson\b/i.test(input.prompt)
    || (input.system ? /\bjson\b/i.test(input.system) : false)
  const providerOptions: Record<string, unknown> = {}
  if (wantsJson) {
    providerOptions.response_format = { type: 'json_object' }
  }
  // DeepSeek / Kimi K2.x / Zhipu / MiMo OpenAICompat path defaults thinking
  // off (see openai-compat-provider). Evaluator / JSON judgment tasks enable
  // low-effort thinking for better verdict quality; ping/distill stay off.
  const binding = getBackendBindingByName(provider.name)
  const modelId = input.model || binding?.model
  // Evaluator role (verdicts / notifications) benefits from low-effort thinking;
  // distill / consolidate / ping stay cheap with thinking off.
  const enableJudgmentThinking = input.role === 'evaluator'
  if (isDeepSeekBaseUrl(binding?.baseUrl)) {
    if (enableJudgmentThinking) {
      providerOptions.thinking = { type: 'enabled' }
      providerOptions.reasoning_effort = 'low'
    } else {
      providerOptions.thinking = { type: 'disabled' }
    }
  } else if (
    isZhipuBaseUrl(binding?.baseUrl)
    || isMimoBaseUrl(binding?.baseUrl)
  ) {
    providerOptions.thinking = enableJudgmentThinking
      ? { type: 'enabled' }
      : { type: 'disabled' }
  } else if (isKimiBaseUrl(binding?.baseUrl) && isKimiK2Model(modelId)) {
    providerOptions.thinking = enableJudgmentThinking
      ? { type: 'enabled' }
      : { type: 'disabled' }
  } else if (isKimiBaseUrl(binding?.baseUrl) && isKimiK3Model(modelId)) {
    providerOptions.reasoning_effort = 'low'
  }
  try {
    const result = await provider.chat(messages, {
      system: input.system,
      timeoutMs: input.timeoutMs ?? 30_000,
      signal: input.signal,
      temperature: input.temperature,
      model: input.model,
      providerOptions,
    })
    return {
      text: result.text,
      usage: result.usage,
      backendName: provider.name,
      providerType: provider.providerType,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    const transient = err instanceof LlmProviderError ? err.transient : false
    const httpStatus = err instanceof LlmProviderError ? err.httpStatus : undefined
    log.warn({
      event: 'llm.introspect.failed',
      role: input.role,
      backend: provider.name,
      providerType: provider.providerType,
      transient,
      httpStatus,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Stage 5 — try a CHAIN of roles in order until one returns a non-null
 * result. The chain is operator-configurable per call (typically
 * ['cheap', 'native-chat', 'evaluator'] for low-stakes introspection
 * that should escalate to a smarter / different vendor on failure).
 *
 * Returns the first successful IntrospectionResult, augmented with
 * `triedRoles` so the caller can audit which roles got skipped. When
 * every role in the chain returns null, returns null — the caller's
 * existing CLI-fallback path takes over (same contract as
 * tryIntrospect).
 */
export interface IntrospectionChainInput
  extends Omit<IntrospectionInput, 'role'> {
  /** Roles to try in order. Empty array returns null immediately. */
  roles: LlmRole[]
  /** Per-role wall-clock cap (default 30s). */
  perRoleTimeoutMs?: number
}

export interface IntrospectionChainResult extends IntrospectionResult {
  /** Roles attempted in order, including the one that succeeded
   *  (always last). Lets the caller log "we fell back twice". */
  triedRoles: LlmRole[]
}

export async function tryIntrospectChain(
  input: IntrospectionChainInput,
): Promise<IntrospectionChainResult | null> {
  if (!input.roles || input.roles.length === 0) return null
  const tried: LlmRole[] = []
  for (const role of input.roles) {
    tried.push(role)
    const r = await tryIntrospect({
      role,
      prompt: input.prompt,
      system: input.system,
      timeoutMs: input.perRoleTimeoutMs ?? input.timeoutMs ?? 30_000,
      signal: input.signal,
      temperature: input.temperature,
      model: input.model,
    })
    if (r) {
      log.info({
        event: 'llm.introspect.chain.success',
        role, attempts: tried.length, totalRoles: input.roles.length,
      })
      return { ...r, triedRoles: tried.slice() }
    }
  }
  log.info({
    event: 'llm.introspect.chain.exhausted',
    attempts: tried.length, roles: tried.join(','),
  })
  return null
}
