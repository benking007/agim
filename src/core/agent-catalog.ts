// Built-in agent catalog — one place for adapter loading and native-session policy.
//
// Adapter implementations still expose their runtime name / aliases / kind. The
// catalog owns the list of built-ins and the persistence strategy needed to
// resume each adapter's native conversation. Registry startup validates that a
// loaded adapter's name matches its catalog id, so metadata drift fails loudly.

import type { AgentAdapter } from './types.js'

export type AgentSessionIdMode = 'preallocated' | 'discovered'

export type LegacyAgentSessionIdField =
  | 'claudeSessionId'
  | 'opencodeSessionId'
  | 'codexSessionId'
  | 'antigravitySessionId'
  | 'kimiSessionId'
  | 'qoderSessionId'
  | 'piSessionId'
  | 'mimoSessionId'
  | 'copilotSessionId'

export type LegacyAgentSessionPrimedField = 'claudeSessionPrimed'

export interface AgentNativeSessionPolicy {
  /** Whether Agim creates the id before the first turn or captures it from output. */
  idMode: AgentSessionIdMode
  /** Temporary compatibility bridge for session JSON written by older releases. */
  legacyIdField: LegacyAgentSessionIdField
  /** Optional legacy boolean used by adapters that distinguish create vs resume. */
  legacyPrimedField?: LegacyAgentSessionPrimedField
}

export interface BuiltInAgentCatalogEntry {
  /** Canonical registry id. Must equal the loaded adapter's `name`. */
  id: string
  load: () => Promise<AgentAdapter>
  /** Present only when the backend has its own resumable conversation id. */
  nativeSession?: AgentNativeSessionPolicy
}

export const BUILT_IN_AGENT_CATALOG: readonly BuiltInAgentCatalogEntry[] = [
  {
    id: 'claude-code',
    load: async () => (await import('../plugins/agents/claude-code/index.js')).claudeCodeAdapter,
    nativeSession: {
      idMode: 'preallocated',
      legacyIdField: 'claudeSessionId',
      legacyPrimedField: 'claudeSessionPrimed',
    },
  },
  {
    id: 'codex',
    load: async () => (await import('../plugins/agents/codex/index.js')).codexAdapter,
    nativeSession: { idMode: 'discovered', legacyIdField: 'codexSessionId' },
  },
  {
    id: 'copilot',
    load: async () => (await import('../plugins/agents/copilot/index.js')).copilotAdapter,
    nativeSession: { idMode: 'preallocated', legacyIdField: 'copilotSessionId' },
  },
  {
    id: 'opencode',
    load: async () => (await import('../plugins/agents/opencode/index.js')).opencodeAdapter,
    nativeSession: { idMode: 'discovered', legacyIdField: 'opencodeSessionId' },
  },
  {
    id: 'antigravity',
    load: async () => (await import('../plugins/agents/antigravity/index.js')).antigravityAdapter,
    nativeSession: { idMode: 'discovered', legacyIdField: 'antigravitySessionId' },
  },
  {
    id: 'kimi-code',
    load: async () => (await import('../plugins/agents/kimi-code/index.js')).kimiCodeAdapter,
    nativeSession: { idMode: 'discovered', legacyIdField: 'kimiSessionId' },
  },
  {
    id: 'qoder',
    load: async () => (await import('../plugins/agents/qoder/index.js')).qoderAdapter,
    nativeSession: { idMode: 'discovered', legacyIdField: 'qoderSessionId' },
  },
  {
    id: 'pi',
    load: async () => (await import('../plugins/agents/pi/index.js')).piAdapter,
    nativeSession: { idMode: 'discovered', legacyIdField: 'piSessionId' },
  },
  {
    id: 'mimo',
    load: async () => (await import('../plugins/agents/mimo/index.js')).mimoAdapter,
    nativeSession: { idMode: 'discovered', legacyIdField: 'mimoSessionId' },
  },
  {
    id: 'cursor',
    load: async () => (await import('../plugins/agents/cursor/index.js')).cursorAdapter,
  },
  {
    id: 'native',
    load: async () => (await import('../plugins/agents/pi-native/factory.js')).nativeAgentAdapter,
  },
] as const

const BUILT_IN_AGENT_BY_ID = new Map(BUILT_IN_AGENT_CATALOG.map((entry) => [entry.id, entry]))

export function getBuiltInAgentCatalogEntry(agentName: string): BuiltInAgentCatalogEntry | undefined {
  return BUILT_IN_AGENT_BY_ID.get(agentName)
}

export function getAgentNativeSessionPolicy(agentName: string): AgentNativeSessionPolicy | undefined {
  return getBuiltInAgentCatalogEntry(agentName)?.nativeSession
}
