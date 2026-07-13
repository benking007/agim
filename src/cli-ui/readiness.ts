// cli-ui/readiness.ts — shared "what can this install run right now?"
// probes for quickstart / doctor. These helpers intentionally avoid the
// onboarding module's 2-minute cache so first-run flows reflect changes the
// user just made in the same terminal session.

import { registry } from '../core/registry.js'
import { setLiveConfig } from '../core/live-config.js'
import type { Config } from '../core/onboarding.js'
import type { Config as CoreConfig } from '../core/types.js'

export const AGENT_PRIORITY = [
  'agim',
  'native',
  'claude-code',
  'codex',
  'copilot',
  'cursor',
  'kimi-code',
  'qoder',
  'pi',
  'mimo',
  'opencode',
  'antigravity',
] as const

export interface AgentReadiness {
  available: string[]
  missing: string[]
}

async function withQuietLogs<T>(fn: () => Promise<T>): Promise<T> {
  const { logger } = await import('../core/logger.js')
  const prev = logger.level
  if (process.env.AGIM_DOCTOR_VERBOSE !== '1') logger.level = 'silent'
  try {
    return await fn()
  } finally {
    logger.level = prev
  }
}

export async function loadAgentRuntime(config: Config): Promise<void> {
  setLiveConfig(config as CoreConfig)
  await withQuietLogs(async () => {
    await registry.loadBuiltInPlugins()
    try {
      const { loadFromConfig } = await import('../core/llm/registry.js')
      loadFromConfig(config)
    } catch {
      // Keep CLI setup usable even if a partially-written LLM config fails
      // to load. The concrete error is surfaced by `agim diag llm`.
    }
    if (config.acpAgents?.length) {
      await registry.loadACPAgents(config.acpAgents)
    }
  })
}

export async function checkAgentsFresh(config: Config): Promise<AgentReadiness> {
  await loadAgentRuntime(config)
  const available: string[] = []
  const missing: string[] = []
  await withQuietLogs(async () => {
    for (const name of registry.listAgents()) {
      const agent = registry.getAgent(name)
      if (!agent) continue
      try {
        if (await agent.isAvailable()) available.push(name)
        else missing.push(name)
      } catch {
        missing.push(name)
      }
    }
  })
  return { available, missing }
}

export function pickPreferredAgent(available: string[], currentDefault?: string): string | null {
  if (currentDefault && available.includes(currentDefault)) return currentDefault
  for (const name of AGENT_PRIORITY) {
    if (available.includes(name)) return name
  }
  return available[0] ?? null
}
