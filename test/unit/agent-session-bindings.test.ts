import { describe, it, expect, beforeEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AGENT_SESSION_PERSIST,
  TURN_AGENT_SESSION,
  bindTurnAgentSession,
} from '../../src/core/agent-session-bindings'
import { AGIM_HOME } from '../../src/core/agim-paths'
import { sessionManager } from '../../src/core/session'

const SESSIONS_DIR = join(AGIM_HOME, 'sessions')

function uniqueKey(prefix: string): { platform: string; channelId: string; threadId: string } {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { platform: 'test', channelId: `ch-${id}`, threadId: `t-${id}` }
}

function sanitize(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) =>
    createHash('sha256').update(c).digest('hex').slice(0, 8))
}

async function cleanupKey(k: { platform: string; channelId: string; threadId: string }): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) return
  const stem = sanitize(`${k.platform}:${k.channelId}:${k.threadId}`)
  for (const name of readdirSync(SESSIONS_DIR)) {
    if (name.startsWith(stem)) {
      try { await unlink(join(SESSIONS_DIR, name)) } catch { /* ignore */ }
    }
  }
}

describe('agent-session-bindings', () => {
  beforeEach(async () => {
    await sessionManager.start()
  })

  it('tables cover cursor alongside other resume-driven CLI agents', () => {
    expect(TURN_AGENT_SESSION.cursor).toEqual({
      kind: 'resume-if-present',
      field: 'cursorSessionId',
    })
    expect(AGENT_SESSION_PERSIST.cursor?.field).toBe('cursorSessionId')
  })

  it('bindTurnAgentSession resumes cursor when sticky id is present', async () => {
    const k = uniqueKey('cursor-resume')
    try {
      const bound = await bindTurnAgentSession(
        'cursor',
        { cursorSessionId: 'chat-abc' },
        k,
        { ensureSession: true },
      )
      expect(bound).toEqual({
        agentSessionId: 'chat-abc',
        agentSessionResume: true,
      })
    } finally {
      await cleanupKey(k)
    }
  })

  it('bindTurnAgentSession returns empty for cursor on first turn', async () => {
    const k = uniqueKey('cursor-first')
    try {
      const bound = await bindTurnAgentSession(
        'cursor',
        undefined,
        k,
        { ensureSession: true },
      )
      expect(bound).toEqual({})
    } finally {
      await cleanupKey(k)
    }
  })

  it('bindTurnAgentSession preallocates claude and marks primed', async () => {
    const k = uniqueKey('claude-bind')
    try {
      const first = await bindTurnAgentSession(
        'claude-code',
        undefined,
        k,
        { ensureSession: true },
      )
      expect(first.agentSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      expect(first.agentSessionResume).toBe(false)

      const sticky = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(sticky?.claudeSessionId).toBe(first.agentSessionId)
      expect(sticky?.claudeSessionPrimed).toBe(true)

      const second = await bindTurnAgentSession('claude-code', sticky, k)
      expect(second.agentSessionId).toBe(first.agentSessionId)
      expect(second.agentSessionResume).toBe(true)
    } finally {
      await cleanupKey(k)
    }
  })

  it('setCursorSessionId persists and /new clears it', async () => {
    const k = uniqueKey('cursor-persist')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'cursor')
      await sessionManager.setCursorSessionId(k.platform, k.channelId, k.threadId, 'sess-1')
      const sticky = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(sticky?.cursorSessionId).toBe('sess-1')

      await sessionManager.resetConversation(k.platform, k.channelId, k.threadId)
      const after = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(after?.cursorSessionId).toBeUndefined()
    } finally {
      await cleanupKey(k)
    }
  })
})
