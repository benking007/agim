// Table-driven agent session id bindings.
//
// Keeps router / subtask resume free of per-agent if-chains while leaving the
// Session schema and per-field setters unchanged. Adding a callback-driven CLI
// agent = one row here (+ existing session.ts setter / Session field).

import type { Session } from './types.js'
import { sessionManager } from './session.js'

export type AgentSessionField = keyof Pick<
  Session,
  | 'opencodeSessionId'
  | 'codexSessionId'
  | 'antigravitySessionId'
  | 'kimiSessionId'
  | 'qoderSessionId'
  | 'piSessionId'
  | 'mimoSessionId'
  | 'copilotSessionId'
>

export interface AgentSessionPersistBinding {
  field: AgentSessionField
  persist: (
    platform: string,
    channelId: string,
    threadId: string,
    id: string,
  ) => Promise<unknown>
  logLabel: string
}

export type SubtaskSessionStrategy =
  | { kind: 'claude-preallocate' }
  | { kind: 'copilot-preallocate'; field: 'copilotSessionId' }
  | { kind: 'resume-if-present'; field: AgentSessionField }

/** Agents that report a minted session id via opts.onAgentSessionId. */
export const AGENT_SESSION_PERSIST: Record<string, AgentSessionPersistBinding> = {
  opencode: {
    field: 'opencodeSessionId',
    persist: (p, c, t, id) => sessionManager.setOpencodeSessionId(p, c, t, id),
    logLabel: 'setOpencodeSessionId',
  },
  codex: {
    field: 'codexSessionId',
    persist: (p, c, t, id) => sessionManager.setCodexSessionId(p, c, t, id),
    logLabel: 'setCodexSessionId',
  },
  antigravity: {
    field: 'antigravitySessionId',
    persist: (p, c, t, id) => sessionManager.setAntigravitySessionId(p, c, t, id),
    logLabel: 'setAntigravitySessionId',
  },
  'kimi-code': {
    field: 'kimiSessionId',
    persist: (p, c, t, id) => sessionManager.setKimiSessionId(p, c, t, id),
    logLabel: 'setKimiSessionId',
  },
  qoder: {
    field: 'qoderSessionId',
    persist: (p, c, t, id) => sessionManager.setQoderSessionId(p, c, t, id),
    logLabel: 'setQoderSessionId',
  },
  pi: {
    field: 'piSessionId',
    persist: (p, c, t, id) => sessionManager.setPiSessionId(p, c, t, id),
    logLabel: 'setPiSessionId',
  },
  mimo: {
    field: 'mimoSessionId',
    persist: (p, c, t, id) => sessionManager.setMimoSessionId(p, c, t, id),
    logLabel: 'setMimoSessionId',
  },
  copilot: {
    field: 'copilotSessionId',
    persist: (p, c, t, id) => sessionManager.setCopilotSessionId(p, c, t, id),
    logLabel: 'setCopilotSessionId',
  },
}

/** How prepareSubtaskAgentCallOptions builds resume opts for each agent. */
export const SUBTASK_AGENT_SESSION: Record<string, SubtaskSessionStrategy> = {
  'claude-code': { kind: 'claude-preallocate' },
  opencode: { kind: 'resume-if-present', field: 'opencodeSessionId' },
  codex: { kind: 'resume-if-present', field: 'codexSessionId' },
  antigravity: { kind: 'resume-if-present', field: 'antigravitySessionId' },
  'kimi-code': { kind: 'resume-if-present', field: 'kimiSessionId' },
  qoder: { kind: 'resume-if-present', field: 'qoderSessionId' },
  pi: { kind: 'resume-if-present', field: 'piSessionId' },
  mimo: { kind: 'resume-if-present', field: 'mimoSessionId' },
  copilot: { kind: 'copilot-preallocate', field: 'copilotSessionId' },
}
