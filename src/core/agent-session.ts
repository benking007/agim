// Catalog-driven adapter-native session state with legacy metadata migration.

import { BUILT_IN_AGENT_CATALOG, getAgentNativeSessionPolicy } from './agent-catalog.js'
import type { AgentSessionState, Session } from './types.js'

export interface LegacyAgentSessionMetadata {
  claudeSessionId?: string
  claudeSessionPrimed?: boolean
  opencodeSessionId?: string
  codexSessionId?: string
  antigravitySessionId?: string
  kimiSessionId?: string
  qoderSessionId?: string
  piSessionId?: string
  mimoSessionId?: string
  copilotSessionId?: string
}

/**
 * Return an adapter's native-session state, lazily importing metadata written
 * by releases that stored one top-level field per adapter. The migrated value
 * is cached on `session.agentSessions`; callers can persist it on the next
 * normal metadata write.
 */
export function getAgentSessionState(
  session: Session,
  agentName: string,
  legacySource: LegacyAgentSessionMetadata = session as Session & LegacyAgentSessionMetadata,
): AgentSessionState | undefined {
  const existing = session.agentSessions?.[agentName]
  if (existing) return existing

  const policy = getAgentNativeSessionPolicy(agentName)
  if (!policy) return undefined

  const id = policy.legacyIdField
    ? legacySource[policy.legacyIdField]
    : undefined
  const primed = policy.legacyPrimedField
    ? legacySource[policy.legacyPrimedField]
    : undefined
  if (!id && !primed) return undefined

  const migrated: AgentSessionState = {
    ...(id ? { id } : {}),
    ...(primed ? { primed: true } : {}),
  }
  session.agentSessions = {
    ...session.agentSessions,
    [agentName]: migrated,
  }
  return migrated
}

export function setAgentSessionState(
  session: Session,
  agentName: string,
  patch: Partial<AgentSessionState>,
): AgentSessionState {
  const current = getAgentSessionState(session, agentName) ?? {}
  const next: AgentSessionState = { ...current, ...patch }
  session.agentSessions = {
    ...session.agentSessions,
    [agentName]: next,
  }
  return next
}

export function clearAllAgentSessionStates(session: Session): void {
  delete session.agentSessions
}

/** Import every known legacy field in one pass while loading session JSON. */
export function migrateLegacyAgentSessionStates(
  session: Session,
  legacySource: LegacyAgentSessionMetadata = session as Session & LegacyAgentSessionMetadata,
): void {
  for (const entry of BUILT_IN_AGENT_CATALOG) {
    if (entry.nativeSession) getAgentSessionState(session, entry.id, legacySource)
  }
}
