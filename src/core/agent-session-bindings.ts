// Table-driven agent session id bindings.
//
// Keeps router / cli / subtask resume free of per-agent if-chains while
// leaving the Session schema and per-field setters unchanged. Adding a
// callback-driven CLI agent = one row here (+ existing session.ts setter
// / Session field).

import { randomUUID } from 'node:crypto'

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
  | 'cursorSessionId'
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

export type TurnSessionStrategy =
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
  cursor: {
    field: 'cursorSessionId',
    persist: (p, c, t, id) => sessionManager.setCursorSessionId(p, c, t, id),
    logLabel: 'setCursorSessionId',
  },
}

/**
 * How cli `onAgentResolved` and `prepareSubtaskAgentCallOptions` wire
 * resume / preallocate for each agent. Same table for both paths.
 */
export const TURN_AGENT_SESSION: Record<string, TurnSessionStrategy> = {
  'claude-code': { kind: 'claude-preallocate' },
  opencode: { kind: 'resume-if-present', field: 'opencodeSessionId' },
  codex: { kind: 'resume-if-present', field: 'codexSessionId' },
  antigravity: { kind: 'resume-if-present', field: 'antigravitySessionId' },
  'kimi-code': { kind: 'resume-if-present', field: 'kimiSessionId' },
  qoder: { kind: 'resume-if-present', field: 'qoderSessionId' },
  pi: { kind: 'resume-if-present', field: 'piSessionId' },
  mimo: { kind: 'resume-if-present', field: 'mimoSessionId' },
  cursor: { kind: 'resume-if-present', field: 'cursorSessionId' },
  copilot: { kind: 'copilot-preallocate', field: 'copilotSessionId' },
}

export type SessionStickyFields = Pick<
  Session,
  | 'claudeSessionId'
  | 'claudeSessionPrimed'
  | 'opencodeSessionId'
  | 'codexSessionId'
  | 'antigravitySessionId'
  | 'kimiSessionId'
  | 'qoderSessionId'
  | 'piSessionId'
  | 'mimoSessionId'
  | 'copilotSessionId'
  | 'cursorSessionId'
>

export interface BoundTurnSession {
  agentSessionId?: string
  agentSessionResume?: boolean
}

/**
 * Bind resume / preallocate session ids for one agent turn.
 *
 * Shared by cli `onAgentResolved` and router subtask prep so both stay
 * table-driven. When `ensureSession` is true (IM inbound path), creates
 * the agim Session row before writing any agent-native id.
 */
export async function bindTurnAgentSession(
  agentName: string,
  sticky: SessionStickyFields | undefined | null,
  ids: { platform: string; channelId: string; threadId: string },
  opts: { ensureSession?: boolean } = {},
): Promise<BoundTurnSession> {
  const strategy = TURN_AGENT_SESSION[agentName]
  if (!strategy) return {}

  if (opts.ensureSession) {
    await sessionManager.getOrCreateSession(
      ids.platform, ids.channelId, ids.threadId, agentName,
    )
  }

  if (strategy.kind === 'claude-preallocate') {
    let claudeId = sticky?.claudeSessionId
    if (!claudeId) {
      claudeId = randomUUID()
      await sessionManager.setClaudeSessionId(
        ids.platform, ids.channelId, ids.threadId, claudeId,
      )
    }
    const willResume = !!sticky?.claudeSessionPrimed
    if (!willResume) {
      try {
        await sessionManager.markClaudeSessionPrimed(
          ids.platform, ids.channelId, ids.threadId,
        )
      } catch {
        // Best-effort: adapter still gets agentSessionId; next turn may
        // retry --session-id once if primed never stuck.
      }
    }
    return { agentSessionId: claudeId, agentSessionResume: willResume }
  }

  if (strategy.kind === 'copilot-preallocate') {
    let copilotId = sticky?.copilotSessionId
    if (!copilotId) {
      copilotId = randomUUID()
      await sessionManager.setCopilotSessionId(
        ids.platform, ids.channelId, ids.threadId, copilotId,
      )
    }
    return {
      agentSessionId: copilotId,
      agentSessionResume: !!sticky?.copilotSessionId,
    }
  }

  const sid = sticky?.[strategy.field]
  if (!sid) return {}
  return { agentSessionId: sid, agentSessionResume: true }
}
