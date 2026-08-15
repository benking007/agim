// First-run onboarding status — shared by CLI (`agim` / `agim go`) and
// `GET /api/onboarding/status`. Pure decision lives in getOnboardingStatus();
// loadOnboardingStatus() gathers config + agent probes + secret presence.

import { loadConfig, saveConfigChanges, type Config } from './onboarding.js'
import { checkAgentsFresh } from '../cli-ui/readiness.js'
import { loadSecretsFile, resolveSecret } from './llm/secrets.js'

export type OnboardingReason =
  | 'no-usable-agent'
  | 'no-llm'
  | 'cli-agent-available'
  | 'ready'

export interface OnboardingStatus {
  firstRun: boolean
  reason: OnboardingReason
  hasLlmSecret: boolean
  availableCliAgents: string[]
  defaultAgent: string
  skipped: boolean
}

interface LlmBackendRef {
  name: string
  provider?: string
  baseUrl?: string
}

export function readLlmBackends(config: Config): LlmBackendRef[] {
  const raw = config.llmBackends
  if (!Array.isArray(raw)) return []
  const out: LlmBackendRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const name = (item as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim()) continue
    const provider = (item as { provider?: unknown }).provider
    const baseUrl = (item as { baseUrl?: unknown }).baseUrl
    out.push({
      name,
      ...(typeof provider === 'string' ? { provider } : {}),
      ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
    })
  }
  return out
}

/** True when at least one llmBackends row has a resolvable secret. */
export function hasUsableLlmSecret(config: Config): boolean {
  const backends = readLlmBackends(config)
  if (backends.length === 0) return false
  const secrets = loadSecretsFile()
  return backends.some((b) => {
    const value = resolveSecret(b.name, secrets, {
      provider: b.provider,
      baseUrl: b.baseUrl,
    })
    return typeof value === 'string' && value.length > 0
  })
}

/**
 * Decide whether the install still needs the first-run wizard.
 *
 * firstRun is true only when there is no usable LLM secret, no available
 * agent (CLI or native), and the operator has not skipped setup.
 */
export function getOnboardingStatus(input: {
  config: Config
  availableAgents: string[]
  hasLlmSecret: boolean
}): OnboardingStatus {
  const skipped = input.config.setupSkipped === true
  const defaultAgent = typeof input.config.defaultAgent === 'string' && input.config.defaultAgent
    ? input.config.defaultAgent
    : 'agim'
  const availableCliAgents = [...input.availableAgents]
  const cliOk = availableCliAgents.length > 0
  const usableLlm = input.hasLlmSecret

  let reason: OnboardingReason
  if (usableLlm) reason = 'ready'
  else if (cliOk) reason = 'cli-agent-available'
  else reason = 'no-usable-agent'

  return {
    firstRun: !skipped && !usableLlm && !cliOk,
    reason,
    hasLlmSecret: usableLlm,
    availableCliAgents,
    defaultAgent,
    skipped,
  }
}

export async function loadOnboardingStatus(opts?: {
  availableAgents?: string[]
}): Promise<OnboardingStatus> {
  const config = await loadConfig()
  const availableAgents = opts?.availableAgents
    ?? (await checkAgentsFresh(config)).available
  return getOnboardingStatus({
    config,
    availableAgents,
    hasLlmSecret: hasUsableLlmSecret(config),
  })
}

export async function markSetupSkipped(): Promise<OnboardingStatus> {
  const config = await loadConfig()
  if (config.setupSkipped !== true) {
    await saveConfigChanges(config, { ...config, setupSkipped: true })
  }
  return loadOnboardingStatus()
}
