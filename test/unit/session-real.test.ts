// Integration tests for the real SessionManager (singleton from session.ts).
//
// Verifies:
//   - addMessage appends to the JSONL log (no full rewrite per turn)
//   - addMessage on the same key does not lose messages under concurrency (H12)
//   - metadata file is atomic (no .tmp leftover after a write)
//   - nextSubtaskId increments durably across calls (P1-C fix)
//   - resetConversation truncates messages but preserves session id
//   - legacy single-file format still loads (back-compat)

import { describe, it, expect, beforeEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { sessionManager } from '../../src/core/session'
import { AGIM_HOME } from '../../src/core/agim-paths'

const SESSIONS_DIR = join(AGIM_HOME, 'sessions')

function uniqueKey(prefix: string): { platform: string; channelId: string; threadId: string } {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { platform: 'test', channelId: `ch-${id}`, threadId: `t-${id}` }
}

/** Mirror sanitizeKey() from session.ts so tests can find the on-disk file. */
function sanitize(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) =>
    createHash('sha256').update(c).digest('hex').slice(0, 8))
}

function fileStem(k: { platform: string; channelId: string; threadId: string }): string {
  return sanitize(`${k.platform}:${k.channelId}:${k.threadId}`)
}

async function cleanupKey(k: { platform: string; channelId: string; threadId: string }): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) return
  const stem = fileStem(k)
  for (const name of readdirSync(SESSIONS_DIR)) {
    if (name.startsWith(stem)) {
      try { await unlink(join(SESSIONS_DIR, name)) } catch { /* ignore */ }
    }
  }
}

describe('SessionManager (real, on-disk)', () => {
  beforeEach(async () => {
    await mkdir(SESSIONS_DIR, { recursive: true })
  })

  it('addMessage appends to JSONL log', async () => {
    const k = uniqueKey('append')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'hi', timestamp: new Date() })
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'assistant', content: 'hello', timestamp: new Date() })

      const logFile = join(SESSIONS_DIR, `${fileStem(k)}.log`)
      const log = await readFile(logFile, 'utf-8')
      const lines = log.split('\n').filter(Boolean)
      expect(lines.length).toBe(2)
      expect(JSON.parse(lines[0]).role).toBe('user')
      expect(JSON.parse(lines[1]).role).toBe('assistant')
    } finally {
      await cleanupKey(k)
    }
  })

  // H12: read-modify-write race. Two concurrent addMessage calls on the same
  // session key would previously both load the in-memory session, both push,
  // both append to the JSONL log; the metadata save races would interleave
  // but on disk the JSONL log was an append-file, so it was actually safe.
  // The bug manifested when the in-memory cache was empty and BOTH calls had
  // to hit loadSession concurrently — they each rebuilt the messages array
  // from disk, pushed independently, and the second saveSessionMeta clobbered
  // the first's messageCount. The withLock fix serializes the entire R-M-W.
  it('addMessage on the same key does not lose messages under concurrency (H12)', async () => {
    const k = uniqueKey('addmsg-race')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      // 50 concurrent addMessage calls on the same key — well above what a
      // realistic IM thread emits, but enough to expose any interleave.
      const N = 50
      await Promise.all(Array.from({ length: N }, (_, i) =>
        sessionManager.addMessage(k.platform, k.channelId, k.threadId, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `msg-${i}`,
          timestamp: new Date(),
        })
      ))

      // In-memory state must reflect every push.
      const data = await sessionManager.getSessionWithHistory(k.platform, k.channelId, k.threadId)
      expect(data?.messages.length).toBe(N)

      // JSONL log on disk must contain every message exactly once. Order
      // within a serialized batch is preserved relative to acquisition order;
      // we only check completeness (no duplicates, no losses).
      const log = await readFile(join(SESSIONS_DIR, `${fileStem(k)}.log`), 'utf-8')
      const lines = log.split('\n').filter(Boolean)
      expect(lines.length).toBe(N)
      const contents = new Set(lines.map((l) => JSON.parse(l).content as string))
      expect(contents.size).toBe(N)
      for (let i = 0; i < N; i++) {
        expect(contents.has(`msg-${i}`)).toBe(true)
      }
    } finally {
      await cleanupKey(k)
    }
  })

  it('does not leave .tmp files after atomic write', async () => {
    const k = uniqueKey('atomic')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'a', timestamp: new Date() })
      const leftover = readdirSync(SESSIONS_DIR).filter((n) =>
        n.startsWith(fileStem(k)) && n.endsWith('.tmp'))
      expect(leftover).toEqual([])
    } finally {
      await cleanupKey(k)
    }
  })

  it('nextSubtaskId increments durably (P1-C)', async () => {
    const k = uniqueKey('subtask')
    try {
      const a = await sessionManager.nextSubtaskId(k.platform, k.channelId, k.threadId)
      const b = await sessionManager.nextSubtaskId(k.platform, k.channelId, k.threadId)
      const c = await sessionManager.nextSubtaskId(k.platform, k.channelId, k.threadId)
      expect(a).toBe(1)
      expect(b).toBe(2)
      expect(c).toBe(3)
    } finally {
      await cleanupKey(k)
    }
  })

  it('nextSubtaskId remains unique under concurrent calls', async () => {
    const k = uniqueKey('subtask-concurrent')
    try {
      const ids = await Promise.all(
        Array.from({ length: 20 }, () => sessionManager.nextSubtaskId(k.platform, k.channelId, k.threadId)),
      )
      expect([...ids].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      )
    } finally {
      await cleanupKey(k)
    }
  })

  it('reads legacy one-file format that contains messages inline', async () => {
    // Manually write a legacy-shaped session file (no .log companion).
    const k = uniqueKey('legacy')
    try {
      const legacy = {
        id: 'legacy-1',
        channelId: k.channelId,
        threadId: k.threadId,
        platform: k.platform,
        agent: 'opencode',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        ttl: 60_000,
        messages: [
          { role: 'user', content: 'legacy-hi', timestamp: new Date().toISOString() },
        ],
      }
      await writeFile(join(SESSIONS_DIR, `${fileStem(k)}.json`), JSON.stringify(legacy))

      const reloaded = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(reloaded?.messages.length).toBe(1)
      expect(reloaded?.messages[0].content).toBe('legacy-hi')
    } finally {
      await cleanupKey(k)
    }
  })

  it('resetConversation clears messages and assigns new id', async () => {
    const k = uniqueKey('reset')
    try {
      const s1 = await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      const oldId = s1.id  // capture before reset mutates the shared ref
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'hi', timestamp: new Date() })
      const s2 = await sessionManager.resetConversation(k.platform, k.channelId, k.threadId)
      expect(s2).toBeDefined()
      expect(s2?.id).not.toBe(oldId)
      expect(s2?.messages.length).toBe(0)
    } finally {
      await cleanupKey(k)
    }
  })

  it('agentSessions persist to disk and reload', async () => {
    const k = uniqueKey('agent-session-persist')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'claude-code')
      await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'claude-code', 'uuid-abc-123',
      )
      await sessionManager.markAgentSessionPrimed(
        k.platform, k.channelId, k.threadId, 'claude-code',
      )

      const metaPath = join(SESSIONS_DIR, `${fileStem(k)}.json`)
      const onDisk = JSON.parse(await readFile(metaPath, 'utf-8'))
      expect(onDisk.agentSessions['claude-code']).toEqual({
        id: 'uuid-abc-123', primed: true,
      })
      expect(onDisk.claudeSessionId).toBeUndefined()

      // @ts-expect-error — reach into the singleton's private map for the test
      sessionManager.sessions.delete(`${k.platform}:${k.channelId}:${k.threadId}`)
      const reloaded = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(reloaded?.agentSessions?.['claude-code']).toEqual({
        id: 'uuid-abc-123', primed: true,
      })
    } finally {
      await cleanupKey(k)
    }
  })

  it('switchAgent preserves generic native sessions and thread-level fields', async () => {
    const k = uniqueKey('switch-carry')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'claude-code')
      await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'claude-code', 'uuid-keepme',
      )
      await sessionManager.markAgentSessionPrimed(
        k.platform, k.channelId, k.threadId, 'claude-code',
      )
      await sessionManager.recordUsage(k.platform, k.channelId, k.threadId, {
        costUsd: 0.5, promptChars: 100, responseChars: 200, durationMs: 1000,
      })
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'pre-switch', timestamp: new Date() })

      const switched = await sessionManager.switchAgent(k.platform, k.channelId, k.threadId, 'opencode')
      expect(switched.agent).toBe('opencode')
      expect(switched.agentSessions?.['claude-code']).toEqual({
        id: 'uuid-keepme', primed: true,
      })
      expect(switched.usage?.costUsd).toBe(0.5)
      expect(switched.messages[0].content).toBe('pre-switch')

      const onDisk = JSON.parse(await readFile(join(SESSIONS_DIR, `${fileStem(k)}.json`), 'utf-8'))
      expect(onDisk.agentSessions['claude-code']).toEqual({
        id: 'uuid-keepme', primed: true,
      })
    } finally {
      await cleanupKey(k)
    }
  })

  it('discovered session ids persist, are idempotent, and reset cleanly', async () => {
    const k = uniqueKey('opencode-persist')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      const first = await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'opencode', 'ses_x',
      )
      const same = await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'opencode', 'ses_x',
      )
      expect(first?.agentSessions?.opencode?.id).toBe('ses_x')
      expect(same?.agentSessions?.opencode?.id).toBe('ses_x')

      const changed = await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'opencode', 'ses_y',
      )
      expect(changed?.agentSessions?.opencode?.id).toBe('ses_y')

      const switched = await sessionManager.switchAgent(k.platform, k.channelId, k.threadId, 'claude-code')
      expect(switched.agentSessions?.opencode?.id).toBe('ses_y')
      const reset = await sessionManager.resetConversation(k.platform, k.channelId, k.threadId)
      expect(reset?.agentSessions).toBeUndefined()
    } finally {
      await cleanupKey(k)
    }
  })

  it('migrates legacy per-agent metadata into agentSessions', async () => {
    const k = uniqueKey('legacy-agent-session')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'claude-code')
      const metaPath = join(SESSIONS_DIR, `${fileStem(k)}.json`)
      const legacy = JSON.parse(await readFile(metaPath, 'utf-8'))
      delete legacy.agentSessions
      legacy.claudeSessionId = 'legacy-uuid'
      legacy.claudeSessionPrimed = true
      legacy.opencodeSessionId = 'legacy-ses'
      await writeFile(metaPath, JSON.stringify(legacy, null, 2))

      // @ts-expect-error — reach into the singleton's private map for the test
      sessionManager.sessions.delete(`${k.platform}:${k.channelId}:${k.threadId}`)
      const reloaded = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(reloaded?.agentSessions?.['claude-code']).toEqual({
        id: 'legacy-uuid', primed: true,
      })
      expect(reloaded?.agentSessions?.opencode).toEqual({ id: 'legacy-ses' })

      await sessionManager.recordUsage(k.platform, k.channelId, k.threadId, {
        costUsd: 0, promptChars: 1, responseChars: 1, durationMs: 1,
      })
      const migrated = JSON.parse(await readFile(metaPath, 'utf-8'))
      expect(migrated.agentSessions.opencode.id).toBe('legacy-ses')
      expect(migrated.claudeSessionId).toBeUndefined()
      expect(migrated.opencodeSessionId).toBeUndefined()
    } finally {
      await cleanupKey(k)
    }
  })

})
