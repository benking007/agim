/**
 * Task → agent/backend dispatch cheat sheet (Plan A).
 *
 * Backends bind via existing llmRoles:
 *   - financeAnalysis → llmRoles.finance
 *   - dataCollect     → llmRoles.cheap
 *
 * Agents for each row live in optional config.dispatchRoutes
 * (dropdowns in Settings → LLM). Prompt renders concrete names only
 * when bound — never hardcodes deepseek.
 */

import { isAgimAgentId, normalizeAgentId } from './naming-migrate.js'
import { getLiveConfig } from './live-config.js'
import { describeRegistry } from './llm/registry.js'

/** llmRoles key for 中文金融分析 / 报告. */
export const DISPATCH_FINANCE_ROLE = 'finance' as const
/** llmRoles key for 批量采集（reuse cheap）. */
export const DISPATCH_DATA_ROLE = 'cheap' as const

export const DEFAULT_DISPATCH_CODING_AGENTS = ['codex', 'claude-code'] as const
export const DEFAULT_DISPATCH_SAME_FAMILY_AGENT = 'agim' as const

export interface DispatchRoutesStored {
  /** Up to 3 CLI agents for coding tasks. */
  codingAgents?: string[]
  /** Agent for finance analysis (usually agim). */
  financeAgent?: string
  /** Agent for bulk data collection (usually agim). */
  dataAgent?: string
}

export interface EffectiveDispatchRoutes {
  codingAgents: string[]
  finance: { agent: string; backend: string | null; role: typeof DISPATCH_FINANCE_ROLE }
  dataCollect: { agent: string; backend: string | null; role: typeof DISPATCH_DATA_ROLE }
}

function cleanAgentId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return normalizeAgentId(raw.trim()) || raw.trim()
}

function cleanAgentList(raw: unknown, max = 3): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const id = cleanAgentId(item)
    if (!id || isAgimAgentId(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

export function readDispatchRoutesStored(config: unknown): DispatchRoutesStored {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const raw = (config as { dispatchRoutes?: unknown }).dispatchRoutes
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const o = raw as Record<string, unknown>
  const out: DispatchRoutesStored = {}
  const coding = cleanAgentList(o.codingAgents)
  if (coding.length) out.codingAgents = coding
  const financeAgent = cleanAgentId(o.financeAgent)
  if (financeAgent) out.financeAgent = financeAgent
  const dataAgent = cleanAgentId(o.dataAgent)
  if (dataAgent) out.dataAgent = dataAgent
  return out
}

/** Persist only non-default agent picks (backends stay in llmRoles). */
export function dispatchRoutesForPersist(stored: DispatchRoutesStored): DispatchRoutesStored | undefined {
  const out: DispatchRoutesStored = {}
  const coding = cleanAgentList(stored.codingAgents)
  const codingDefault = [...DEFAULT_DISPATCH_CODING_AGENTS]
  const codingIsDefault =
    coding.length === codingDefault.length
    && coding.every((a, i) => a === codingDefault[i])
  if (coding.length && !codingIsDefault) out.codingAgents = coding

  const financeAgent = cleanAgentId(stored.financeAgent)
  if (financeAgent && financeAgent !== DEFAULT_DISPATCH_SAME_FAMILY_AGENT) {
    out.financeAgent = financeAgent
  }
  const dataAgent = cleanAgentId(stored.dataAgent)
  if (dataAgent && dataAgent !== DEFAULT_DISPATCH_SAME_FAMILY_AGENT) {
    out.dataAgent = dataAgent
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function resolveDispatchRoutes(opts: {
  config?: unknown
  roles?: Record<string, string>
  /** When set, coding agents are intersected with this enabled list. */
  enabledAgents?: string[]
}): EffectiveDispatchRoutes {
  const stored = readDispatchRoutesStored(opts.config)
  const roles = opts.roles ?? {}

  let codingAgents = cleanAgentList(stored.codingAgents)
  if (codingAgents.length === 0) {
    codingAgents = [...DEFAULT_DISPATCH_CODING_AGENTS]
  }
  if (opts.enabledAgents && opts.enabledAgents.length > 0) {
    const enabled = new Set(
      opts.enabledAgents.map((a) => normalizeAgentId(a)).filter(Boolean),
    )
    const filtered = codingAgents.filter((a) => enabled.has(a))
    // Keep configured order; if none enabled, fall back to configured list
    // (prompt still shows intent; availability is checked at spawn time).
    if (filtered.length > 0) codingAgents = filtered
  }

  const financeAgent =
    cleanAgentId(stored.financeAgent) || DEFAULT_DISPATCH_SAME_FAMILY_AGENT
  const dataAgent =
    cleanAgentId(stored.dataAgent) || DEFAULT_DISPATCH_SAME_FAMILY_AGENT

  const financeBackend = typeof roles[DISPATCH_FINANCE_ROLE] === 'string'
    ? roles[DISPATCH_FINANCE_ROLE].trim() || null
    : null
  const dataBackend = typeof roles[DISPATCH_DATA_ROLE] === 'string'
    ? roles[DISPATCH_DATA_ROLE].trim() || null
    : null

  return {
    codingAgents,
    finance: {
      agent: financeAgent,
      backend: financeBackend,
      role: DISPATCH_FINANCE_ROLE,
    },
    dataCollect: {
      agent: dataAgent,
      backend: dataBackend,
      role: DISPATCH_DATA_ROLE,
    },
  }
}

function formatTarget(agent: string, backend: string | null, role: string): string {
  if (backend) {
    if (isAgimAgentId(agent)) {
      return `agent=agim backend="${backend}" (or role:"${role}")`
    }
    return `agent=${agent} (backend="${backend}" only applies to agim)`
  }
  if (isAgimAgentId(agent)) {
    return `agent=agim + bind llmRoles.${role} in Settings → LLM (pick a backend)`
  }
  return `agent=${agent}`
}

/**
 * Compact cheat sheet for Agim system prompt.
 * Omits fabricated vendor names; uses configured bindings only.
 */
export function formatDispatchCheatSheetForPrompt(routes: EffectiveDispatchRoutes): string {
  const coding = routes.codingAgents.length > 0
    ? routes.codingAgents.map((a) => `agent=${a}`).join(' / ')
    : 'agent=codex / agent=claude-code'

  const lines = [
    'Task → dispatch cheat sheet (operator-configured; prefer these over habit):',
    `  - Coding / bugfix / local refactor → ${coding}`,
    `  - Chinese finance analysis / report / portfolio → ${formatTarget(
      routes.finance.agent,
      routes.finance.backend,
      routes.finance.role,
    )}`,
    `  - Bulk data fetch / quotes / multi-source collect → ${formatTarget(
      routes.dataCollect.agent,
      routes.dataCollect.backend,
      routes.dataCollect.role,
    )}`,
    '  - Principle: coding → CLI agents; analysis/collect → Agim + configured backend. '
      + 'Do not send finance/report work to a pure coding CLI out of inertia.',
  ]
  return lines.join('\n')
}

/** Live cheat sheet from config + llmRoles registry. */
export function getDispatchCheatSheetForPrompt(): string {
  try {
    const cfg = getLiveConfig()
    const roles = describeRegistry().roles
    const effective = resolveDispatchRoutes({
      config: cfg,
      roles,
      enabledAgents: cfg?.agents,
    })
    return formatDispatchCheatSheetForPrompt(effective)
  } catch {
    return formatDispatchCheatSheetForPrompt(
      resolveDispatchRoutes({ roles: {} }),
    )
  }
}
