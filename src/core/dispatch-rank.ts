/**
 * Live preferred-pick ranking for Subagent dispatch.
 *
 * Reads capability dims (strong|medium|weak) plus a live availability
 * snapshot so the parent system prompt lists workers that can actually
 * be spawned — ranked, not dumped as a 10-CLI roster.
 *
 * This is prompt ranking, not a hard pre-LLM router (vision stays the
 * only automatic route).
 */

import {
  type CapabilityDim,
  type CapabilityLevel,
  type CapabilityMap,
} from './capability-dims.js'
import {
  type AgentProfile,
  NON_AGIM_AGENT_IDS,
  resolveAgentProfiles,
} from './agent-profiles.js'
import {
  readBackendProfileOverrides,
  resolveBackendProfile,
} from './backend-profiles.js'
import { resolveDispatchRoutes } from './dispatch-routes.js'
import { getLiveConfig } from './live-config.js'
import { describeRegistry, listProviders } from './llm/registry.js'
import { isAgimAgentId, normalizeAgentId } from './naming-migrate.js'
import { peekAgentAvailabilitySnapshot } from './onboarding.js'

export const CAPABILITY_LEVEL_SCORE: Record<CapabilityLevel, number> = {
  strong: 3,
  medium: 2,
  weak: 1,
}

export type DispatchCandidateKind = 'cli' | 'backend'

export interface DispatchCandidate {
  kind: DispatchCandidateKind
  /** CLI agent id or llmBackends.name */
  id: string
  level: CapabilityLevel
  /** Prompt token, e.g. `agent=codex` or `agent=agim backend="pro"` */
  label: string
}

const PRIMARY_PICK_DIMS: CapabilityDim[] = ['coding', 'finance', 'zhWriting']

export function rankDispatchCandidates(
  candidates: DispatchCandidate[],
  opts?: { preferKind?: DispatchCandidateKind; tieOrder?: string[] },
): DispatchCandidate[] {
  const tie = opts?.tieOrder ?? []
  const prefer = opts?.preferKind
  return [...candidates].sort((a, b) => {
    const byLevel = CAPABILITY_LEVEL_SCORE[b.level] - CAPABILITY_LEVEL_SCORE[a.level]
    if (byLevel !== 0) return byLevel
    if (prefer) {
      if (a.kind === prefer && b.kind !== prefer) return -1
      if (b.kind === prefer && a.kind !== prefer) return 1
    }
    const ia = tie.indexOf(a.id)
    const ib = tie.indexOf(b.id)
    const ra = ia === -1 ? 999 : ia
    const rb = ib === -1 ? 999 : ib
    if (ra !== rb) return ra - rb
    return a.id.localeCompare(b.id)
  })
}

/** CLI ids that may appear in catalog / live picks. Never dumps all builtins. */
export function resolveListedCliAgentIds(opts: {
  enabledAgents?: string[]
  availableAgents?: string[]
  availabilityKnown?: boolean
}): string[] {
  const enabled = [
    ...new Set(
      (opts.enabledAgents || [])
        .map((a) => normalizeAgentId(a))
        .filter((a) => a && !isAgimAgentId(a)),
    ),
  ]
  const available = new Set(
    (opts.availableAgents || [])
      .map((a) => normalizeAgentId(a))
      .filter((a) => a && !isAgimAgentId(a)),
  )

  let ids: string[]
  if (enabled.length > 0) {
    ids = NON_AGIM_AGENT_IDS.filter((id) => enabled.includes(id))
  } else if (opts.availabilityKnown && available.size > 0) {
    ids = NON_AGIM_AGENT_IDS.filter((id) => available.has(id))
  } else {
    ids = []
  }
  if (opts.availabilityKnown) {
    ids = ids.filter((id) => available.has(id))
  }
  return ids
}

export function formatPreferredPickLine(ranked: DispatchCandidate[], limit = 3): string {
  if (ranked.length === 0) return ''
  return ranked
    .slice(0, limit)
    .map((c) => `${c.label} (${c.level})`)
    .join(' then ')
}

export function buildLivePreferredPicks(input: {
  cliIds: string[]
  cliProfiles: Record<string, Pick<AgentProfile, 'capabilities'>>
  backends: Array<{ name: string; capabilities: CapabilityMap }>
  codingTieOrder?: string[]
  availabilityKnown: boolean
}): string {
  const header = input.availabilityKnown
    ? 'Live preferred picks (available now; rank = caps strong>medium>weak, coding prefers CLI):'
    : 'Live preferred picks (availability unknown — spawn may still fail):'

  const lines = [header]
  for (const dim of PRIMARY_PICK_DIMS) {
    const candidates: DispatchCandidate[] = []
    for (const id of input.cliIds) {
      const caps = input.cliProfiles[id]?.capabilities
      if (!caps) continue
      candidates.push({
        kind: 'cli',
        id,
        level: caps[dim],
        label: `agent=${id}`,
      })
    }
    for (const b of input.backends) {
      candidates.push({
        kind: 'backend',
        id: b.name,
        level: b.capabilities[dim],
        label: `agent=agim backend="${b.name}"`,
      })
    }
    const preferKind: DispatchCandidateKind = dim === 'coding' ? 'cli' : 'backend'
    const ranked = rankDispatchCandidates(candidates, {
      preferKind,
      tieOrder: dim === 'coding' ? input.codingTieOrder : undefined,
    })
    const line = formatPreferredPickLine(ranked)
    if (line) {
      lines.push(`  - ${dim} → ${line}`)
    } else if (dim === 'coding') {
      lines.push(
        '  - coding → no coding CLI available — same-family isolate/backend, or do it yourself',
      )
    } else {
      lines.push(`  - ${dim} → no dispatchable worker — do it yourself`)
    }
  }
  return lines.join('\n')
}

/** Live injection for Agim system prompt. */
export function getLivePreferredPicksForPrompt(): string {
  try {
    const cfg = getLiveConfig()
    const snap = peekAgentAvailabilitySnapshot()
    const profiles = resolveAgentProfiles(cfg)
    const cliIds = resolveListedCliAgentIds({
      enabledAgents: cfg?.agents,
      availableAgents: snap.available,
      availabilityKnown: snap.known,
    })
    const overrides = readBackendProfileOverrides(cfg)
    const backends = listProviders().map((p) => {
      const prof = resolveBackendProfile(
        { name: p.name, model: p.model, provider: p.providerType },
        overrides,
      )
      return { name: p.name, capabilities: prof.capabilities }
    })
    const roles = describeRegistry().roles
    const routes = resolveDispatchRoutes({
      config: cfg,
      roles,
      enabledAgents: cfg?.agents,
      availableAgents: snap.known ? snap.available : undefined,
    })
    return buildLivePreferredPicks({
      cliIds,
      cliProfiles: profiles,
      backends,
      codingTieOrder: routes.codingAgents,
      availabilityKnown: snap.known,
    })
  } catch {
    return buildLivePreferredPicks({
      cliIds: [],
      cliProfiles: {},
      backends: [],
      availabilityKnown: false,
    })
  }
}

/** Exported for tests that want the full dim list. */
export const LIVE_PICK_DIMS: readonly CapabilityDim[] = PRIMARY_PICK_DIMS
