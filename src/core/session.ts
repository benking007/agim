// Session manager — per-conversation state
//
// On-disk layout (one directory tree per home):
//   ~/.agim/sessions/<safe-key>.json   — metadata (no messages)
//   ~/.agim/sessions/<safe-key>.log    — append-only JSONL of messages
//
// Splitting the message log out of the JSON metadata avoids rewriting the
// entire history on every chat turn (the old behavior was an O(N) write
// per message). All metadata writes are atomic via writeFile→rename.

import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, rename, unlink, appendFile, readdir, chmod } from 'node:fs/promises'
import type { Session, ChatMessage, SubtaskMeta } from './types.js'
import { approvalBus } from './approval-bus.js'
import { clearPlanModeForThread } from './plan-mode-state.js'
import { clearThreadFeedback, mintChatMessageId } from './message-feedback.js'
import { clearPendingDownvoteHint, feedbackThreadKey } from './message-feedback-hints.js'
import { logger as rootLogger } from './logger.js'
import { AGIM_HOME } from './agim-paths.js'
import { scheduleRetireAgimAgentSession } from './agim-agent-session-lifecycle.js'
import { isLoopWorkerAgent, nextPreferredWorkerAgent } from './loop-parent-agent.js'

const log = rootLogger.child({ component: 'session' })

const SESSIONS_DIR = join(AGIM_HOME, 'sessions')

function sanitizeKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) => {
    return createHash('sha256').update(c).digest('hex').slice(0, 8)
  })
}

function sessionFilePath(key: string): string {
  const safe = sanitizeKey(key)
  return join(SESSIONS_DIR, `${safe}.json`)
}

function sessionLogPath(key: string): string {
  const safe = sanitizeKey(key)
  return join(SESSIONS_DIR, `${safe}.log`)
}
// Two-tier TTL (split out to fix the "agent drift after long pause" issue):
//
//   MESSAGES_TTL  — how long chat history sticks around before we drop it
//                   from RAM and delete the .log file. Short by default
//                   (30 min) for IM because a long pause usually means the
//                   user has switched topics; replaying stale messages back
//                   to the agent just bloats the prompt.
//
//   META_TTL      — how long the *session metadata* (agent, model, variant,
//                   claudeSessionId, claudeSessionPrimed, usage stats) lives
//                   on disk. Long by default (7 days) so the thread's "sticky
//                   agent" and resumable claude-code session id survive
//                   overnight / weekend gaps. Without this, a 30-minute
//                   silence followed by a coding-keyword message would
//                   re-classify and switch agents (e.g. claude-code → opencode).
//
//   Web console (`platform === 'web'`, including `/` and `/m/chat`) defaults
//   message retention to META_TTL instead: operators restart the service
//   often, and blanking the SPA after a restart felt like total data loss.
//   Override with AGIM_WEB_SESSION_MESSAGES_TTL_MS.
//
// Both are env-overridable for ops tuning. Values are read per call so tests
// (and live env edits) can change TTL without reloading the module.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function messagesTtlDefault(): number {
  return envInt('AGIM_SESSION_MESSAGES_TTL_MS', 30 * 60 * 1000)
}
function metaTtl(): number {
  return envInt('AGIM_SESSION_META_TTL_MS', 7 * 24 * 60 * 60 * 1000)
}
/** Per-platform message retention. Web keeps bubbles across restarts. */
function messagesTtlFor(platform: string): number {
  if (platform === 'web') {
    return envInt('AGIM_WEB_SESSION_MESSAGES_TTL_MS', metaTtl())
  }
  return messagesTtlDefault()
}
// Back-compat: external callers (tests, schedule.ts) used to import DEFAULT_TTL
// to mean "the one ttl". Keep the symbol pointing at META_TTL so anywhere it
// still appears in logs/metrics gets the long-lived value.
const DEFAULT_TTL = metaTtl()
const CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes

function metaStale(s: { lastActivity: Date }, now: number = Date.now()): boolean {
  return now - s.lastActivity.getTime() > metaTtl()
}
function messagesStale(
  s: { lastActivity: Date; platform: string },
  now: number = Date.now(),
): boolean {
  return now - s.lastActivity.getTime() > messagesTtlFor(s.platform)
}

type PersistedSession = Omit<Partial<Session>, 'createdAt' | 'lastActivity'> & {
  createdAt?: unknown
  lastActivity?: unknown
  messageCount?: number
}

function parsePersistedDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function normalizePersistedCompactRate(
  raw: unknown,
): Session['compactRate'] | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim().toLowerCase()
  if (s === 'full' || s === 'balanced' || s === 'frequent') return s
  return undefined
}

function deserializeSession(value: unknown): Session | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parsed = value as PersistedSession
  const { id, channelId, threadId, platform, agent, ttl } = parsed
  if (
    typeof id !== 'string'
    || typeof channelId !== 'string'
    || typeof threadId !== 'string'
    || typeof platform !== 'string'
    || typeof agent !== 'string'
    || typeof ttl !== 'number'
    || !Number.isFinite(ttl)
    || ttl <= 0
  ) return null

  const createdAt = parsePersistedDate(parsed.createdAt)
  const lastActivity = parsePersistedDate(parsed.lastActivity)
  if (!createdAt || !lastActivity) return null

  return {
    id,
    channelId,
    threadId,
    platform,
    agent,
    model: parsed.model,
    variant: parsed.variant,
    compactRate: normalizePersistedCompactRate(parsed.compactRate),
    usage: parsed.usage,
    createdAt,
    lastActivity,
    ttl,
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    activeSubtaskId: parsed.activeSubtaskId,
    subtasks: parsed.subtasks,
    subtaskCounter: parsed.subtaskCounter,
    claudeSessionId: parsed.claudeSessionId,
    claudeSessionPrimed: parsed.claudeSessionPrimed,
    opencodeSessionId: parsed.opencodeSessionId,
    codexSessionId: parsed.codexSessionId,
    antigravitySessionId: parsed.antigravitySessionId,
    kimiSessionId: parsed.kimiSessionId,
    qoderSessionId: parsed.qoderSessionId,
    piSessionId: parsed.piSessionId,
    mimoSessionId: parsed.mimoSessionId,
    copilotSessionId: parsed.copilotSessionId,
    cursorSessionId: parsed.cursorSessionId,
    planMode: parsed.planMode,
    stepReflect: typeof parsed.stepReflect === 'boolean' ? parsed.stepReflect : undefined,
    preferredWorkerAgent: typeof parsed.preferredWorkerAgent === 'string'
      ? parsed.preferredWorkerAgent
      : undefined,
    workspacePath: typeof parsed.workspacePath === 'string' && parsed.workspacePath.trim()
      ? parsed.workspacePath.trim()
      : undefined,
  }
}

class SessionManager {
  private sessions = new Map<string, Session>()
  private cleanupTimer?: ReturnType<typeof setInterval>
  /**
   * Per-key promise chain used to serialize writes that perform a
   * read-modify-write on the in-memory session + persistent JSONL log.
   *
   * Without this, two concurrent {@link addMessage} calls on the same key
   * could interleave: A reads cached session, B reads cached session, both
   * push a different message into the same array, then both write — the
   * later write wins and the earlier message is lost from disk (the
   * in-memory copy is fine because both pushes happened on the same object
   * reference, but the JSONL log only reflects the most recent appendFile +
   * meta save).
   *
   * The lock is keyed by `${platform}:${channelId}:${threadId}`; different
   * threads still proceed in parallel.
   */
  private writeQueues = new Map<string, Promise<unknown>>()

  async start(): Promise<void> {
    // Ensure sessions directory exists
    await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 })
    // mkdir's mode only applies on creation; tighten pre-existing directories
    // as well so metadata/log files are not traversable by other host users.
    if (process.platform !== 'win32') {
      await chmod(SESSIONS_DIR, 0o700).catch((err) => {
        log.warn({ event: 'session.dir_chmod_failed', dir: SESSIONS_DIR, err: String(err) })
      })
    }

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL)

    log.info({ dir: SESSIONS_DIR }, 'Session manager started')
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
    }
  }

  /**
   * Run `fn` while holding a per-key serial lock. Subsequent calls with the
   * same key wait until prior ones settle (success OR failure). Returns the
   * value of `fn`. Internal use only — keeps {@link addMessage} race-free
   * without introducing an external dep like p-queue.
   */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(key) ?? Promise.resolve()
    // Chain even on failure so a thrown error in one segment doesn't poison
    // subsequent waiters with that same rejection.
    const next = prev.then(fn, fn)
    this.writeQueues.set(key, next)
    try {
      return await next
    } finally {
      // Only clear if we're still the tail; another caller may have queued
      // behind us in the meantime and we shouldn't drop their reference.
      if (this.writeQueues.get(key) === next) {
        this.writeQueues.delete(key)
      }
    }
  }

  /**
   * Get or create a session for a conversation
   * Session key: `${platform}:${channelId}:${threadId}`
   */
  async getOrCreateSession(
    platform: string,
    channelId: string,
    threadId: string,
    agent: string
  ): Promise<Session> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const now = new Date()

      // Check memory cache
      let session = this.sessions.get(key)

      if (session) {
        if (metaStale(session, now.getTime())) {
          session = undefined  // fully expired → create new below
        } else {
          if (messagesStale(session, now.getTime()) && session.messages.length > 0) {
            session.messages = []
            try { await unlink(sessionLogPath(key)) } catch { /* no log to drop */ }
          }
          session.lastActivity = now
          await this.saveSessionMeta(key, session)
          return session
        }
      }

      // Try loading from disk
      session = await this.loadSession(key)

      if (session && !metaStale(session, now.getTime())) {
        if (messagesStale(session, now.getTime()) && session.messages.length > 0) {
          session.messages = []
          try { await unlink(sessionLogPath(key)) } catch { /* no log to drop */ }
        }
        session.lastActivity = now
        this.sessions.set(key, session)
        await this.saveSessionMeta(key, session)
        return session
      }

      // Create new session
      session = {
        id: `${platform}-${channelId}-${threadId}-${Date.now()}-${randomBytes(4).toString('hex')}`,
        channelId,
        threadId,
        platform,
        agent,
        createdAt: now,
        lastActivity: now,
        ttl: DEFAULT_TTL,
        messages: [],
        ...(isLoopWorkerAgent(agent) ? { preferredWorkerAgent: agent } : {}),
      }

      this.sessions.set(key, session)
      await this.saveSession(key, session)

      return session
    })
  }

  /**
   * Get existing session without creating a new one
   * Returns undefined if no session exists or it's expired
   */
  async getExistingSession(platform: string, channelId: string, threadId: string): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    const now = new Date()

    // Check memory cache
    let session = this.sessions.get(key)

    if (session) {
      if (metaStale(session, now.getTime())) {
        return undefined
      }
      if (messagesStale(session, now.getTime()) && session.messages.length > 0) {
        // Drop stale chat history but preserve metadata (sticky agent,
        // claudeSessionId etc.) — that's the whole point of META_TTL.
        session.messages = []
        try { await unlink(sessionLogPath(key)) } catch { /* ignore */ }
      }
      return session
    }

    // Try loading from disk
    session = await this.loadSession(key)

    if (session && !metaStale(session, now.getTime())) {
      if (messagesStale(session, now.getTime()) && session.messages.length > 0) {
        session.messages = []
        try { await unlink(sessionLogPath(key)) } catch { /* ignore */ }
      }
      this.sessions.set(key, session)
      return session
    }

    return undefined
  }

  /**
   * Switch the agent for a session.
   *
   * Generates a new session id but preserves thread identity AND every
   * thread-level field that isn't agent-specific:
   *   - usage             (per-thread /stats roll-up)
   *   - subtasks/active   (subtask state lives at thread level)
   *   - claudeSessionId   (Claude UUID survives /oc → /cc round-trips so the
   *                        underlying ~/.claude/projects jsonl keeps continuing
   *                        when the user comes back to claude)
   *
   * `model` and `variant` are reset because they live in different namespaces
   * across CLIs (`opencode` model ≠ `claude` model); carrying them across
   * would just feed the new agent an unrecognized argument.
   */
  async switchAgent(
    platform: string,
    channelId: string,
    threadId: string,
    newAgent: string
  ): Promise<Session> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {

      // Get existing session or create new
      const existing = this.sessions.get(key) || await this.loadSession(key)
      const retiredId = existing?.id

      const now = new Date()
      const preferredWorkerAgent = nextPreferredWorkerAgent(
        existing?.agent,
        newAgent,
        existing?.preferredWorkerAgent,
      )
      const session: Session = {
        id: `${platform}-${channelId}-${threadId}-${Date.now()}-${randomBytes(4).toString('hex')}`,
        channelId,
        threadId,
        platform,
        agent: newAgent,
        createdAt: existing?.createdAt || now,
        lastActivity: now,
        ttl: DEFAULT_TTL,
        messages: existing?.messages || [],
        usage: existing?.usage,
        activeSubtaskId: existing?.activeSubtaskId,
        subtasks: existing?.subtasks,
        subtaskCounter: existing?.subtaskCounter,
        claudeSessionId: existing?.claudeSessionId,
        claudeSessionPrimed: existing?.claudeSessionPrimed,
        opencodeSessionId: existing?.opencodeSessionId,
        codexSessionId: existing?.codexSessionId,
        antigravitySessionId: existing?.antigravitySessionId,
        kimiSessionId: existing?.kimiSessionId,
        qoderSessionId: existing?.qoderSessionId,
        piSessionId: existing?.piSessionId,
        mimoSessionId: existing?.mimoSessionId,
        copilotSessionId: existing?.copilotSessionId,
        cursorSessionId: existing?.cursorSessionId,
        planMode: existing?.planMode,
        stepReflect: existing?.stepReflect,
        compactRate: existing?.compactRate,
        ...(preferredWorkerAgent ? { preferredWorkerAgent } : {}),
      }

      this.sessions.set(key, session)
      await this.saveSession(key, session)

      // Minting a new session.id orphans the previous Agim Agent JSONL.
      if (retiredId && retiredId !== session.id) {
        scheduleRetireAgimAgentSession(retiredId, 'switch')
      }

      return session
    })
  }

  /**
   * Append a message to the session history.
   *
   * Performance: instead of re-serializing the entire session JSON every
   * turn, the message body is appended to a JSONL log file alongside the
   * metadata (which gets a tiny atomic update for `lastActivity`).
   *
   * Concurrency: the entire read-modify-write is serialized per session key
   * via {@link withLock} so two concurrent calls on the same thread (e.g.
   * the IM message landing event AND a tool-result event arriving within
   * the same ms) cannot lose either message to a lost-update race.
   */
  async addMessage(
    platform: string,
    channelId: string,
    threadId: string,
    message: ChatMessage
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return

      // Mint durable ids for feedback / SPA restore. Legacy rows without
      // ids stay addressable by messageIndex in the feedback sidecar.
      const stored: ChatMessage = message.id
        ? message
        : { ...message, id: mintChatMessageId() }
      session.messages.push(stored)
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      // Append-only log avoids rewriting the entire history per turn.
      // Security: explicit mode 0o600 so session history isn't readable
      // by other users on the same host even when umask is lax (e.g.
      // 0022). NB: appendFile honors `mode` only on the first call when
      // the file is created — subsequent appends preserve the existing
      // perms, so the first message of every new thread locks it down.
      try {
        await appendFile(sessionLogPath(key), `${JSON.stringify(stored)}\n`, { mode: 0o600 })
      } catch (appendErr) {
        log.warn({ event: 'session.append_failed', key, err: String(appendErr) },
          'JSONL append failed, falling back to full save')
        try {
          await this.saveSession(key, session)
        } catch (saveErr) {
          log.warn({ event: 'session.fullsave_failed', key, err: String(saveErr) },
            'Full session save also failed — message persisted only in memory')
        }
      }
      // Persist metadata only (now small & cheap).
      await this.saveSessionMeta(key, session)
    })
  }

  /** Remove the current turn's just-appended user message when cancellation
   * wins during the async history write. Match-last semantics prevent deleting
   * an unrelated message if another path advanced the session. */
  async removeLastMessageIfMatches(
    platform: string,
    channelId: string,
    threadId: string,
    expected: Pick<ChatMessage, 'role' | 'content'>,
  ): Promise<boolean> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      const last = session?.messages.at(-1)
      if (!session || !last || last.role !== expected.role || last.content !== expected.content) return false
      session.messages.pop()
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSession(key, session)
      return true
    })
  }

  /**
   * Attach a web-chat activity accordion to the latest assistant message
   * (optionally matched by content). Rewrites the JSONL so refresh can
   * restore every turn's tools — not only the in-memory ActiveRun.
   */
  async patchLastAssistantActivity(
    platform: string,
    channelId: string,
    threadId: string,
    activity: NonNullable<ChatMessage['activity']>,
    matchContent?: string,
  ): Promise<boolean> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session || session.messages.length === 0) return false
      let idx = -1
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i]
        if (!m || m.role !== 'assistant') continue
        if (matchContent !== undefined && m.content !== matchContent) continue
        idx = i
        break
      }
      if (idx < 0) return false
      const target = session.messages[idx]
      if (!target) return false
      session.messages[idx] = { ...target, activity }
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSession(key, session)
      return true
    })
  }

  /**
   * Persist `model` / `variant` / arbitrary patchable fields. Used by
   * `/model`, `/think` etc so the change survives a restart between turns.
   * Mutates the in-memory session in place AND writes metadata atomically.
   */
  async patchSession(
    platform: string, channelId: string, threadId: string,
    patch: Partial<Pick<Session, 'model' | 'variant' | 'agent' | 'planMode' | 'stepReflect' | 'compactRate' | 'workspacePath'>>,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (patch.model !== undefined) session.model = patch.model || undefined
      if (patch.variant !== undefined) session.variant = patch.variant || undefined
      if (patch.agent !== undefined) session.agent = patch.agent
      if (patch.planMode !== undefined) {
        // Normalize to canonical shape: true keeps the flag, false drops it.
        // Storing only the truthy state keeps the on-disk JSON small and lets
        // a missing field unambiguously mean "off".
        if (patch.planMode) session.planMode = true
        else delete session.planMode
      }
      if (patch.stepReflect !== undefined) {
        // Persist both true and false: env=on + user off must stick as false.
        session.stepReflect = patch.stepReflect
      }
      if (patch.compactRate !== undefined) {
        // auto / empty → drop field (global default); otherwise persist.
        if (patch.compactRate && patch.compactRate !== 'auto') {
          session.compactRate = patch.compactRate
        } else {
          delete session.compactRate
        }
      }
      if (patch.workspacePath !== undefined) {
        if (patch.workspacePath.trim()) session.workspacePath = patch.workspacePath.trim()
        else delete session.workspacePath
      }
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist claude-code resumable session bookkeeping (UUID + primed flag).
   * Returns the updated session, or undefined if no session exists yet for
   * this thread. Caller is expected to ensure the session exists first.
   */
  async setClaudeSessionId(
    platform: string, channelId: string, threadId: string,
    claudeSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      session.claudeSessionId = claudeSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  async markClaudeSessionPrimed(
    platform: string, channelId: string, threadId: string,
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session || session.claudeSessionPrimed) return
      session.claudeSessionPrimed = true
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
    })
  }

  /**
   * Persist opencode's native session id (`ses_…`) once we've seen it in the
   * adapter's stream. Idempotent — calling with the same id is a no-op so
   * the per-event callback can fire as many times as opencode sends events.
   */
  async setOpencodeSessionId(
    platform: string, channelId: string, threadId: string,
    opencodeSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.opencodeSessionId === opencodeSessionId) return session
      session.opencodeSessionId = opencodeSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist codex's native thread id (UUID) once we've seen it in the
   * adapter's `thread.started` event. Idempotent — same id may fire multiple
   * times per spawn. Mirrors setOpencodeSessionId.
   */
  async setCodexSessionId(
    platform: string, channelId: string, threadId: string,
    codexSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.codexSessionId === codexSessionId) return session
      session.codexSessionId = codexSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist Antigravity's (`agy`) conversation UUID after the first run
   * creates `~/.gemini/antigravity-cli/conversations/<uuid>.pb`. The
   * adapter detects the file via a before/after readdir snapshot and
   * calls back via `opts.onAgentSessionId(id)`; this setter persists
   * it so the next turn passes `--conversation <id>`. Mirrors
   * setOpencodeSessionId / setCodexSessionId. Cleared by /new.
   */
  async setAntigravitySessionId(
    platform: string, channelId: string, threadId: string,
    antigravitySessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.antigravitySessionId === antigravitySessionId) return session
      session.antigravitySessionId = antigravitySessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist Kimi Code's session id after the first run creates or reports it.
   * Subsequent turns pass it back via `kimi -p --session <id>`.
   */
  async setKimiSessionId(
    platform: string, channelId: string, threadId: string,
    kimiSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.kimiSessionId === kimiSessionId) return session
      session.kimiSessionId = kimiSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist Qoder's stream-json session id after the first run reports it.
   * Subsequent turns pass it back via `qodercli --resume <id>`.
   */
  async setQoderSessionId(
    platform: string, channelId: string, threadId: string,
    qoderSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.qoderSessionId === qoderSessionId) return session
      session.qoderSessionId = qoderSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist PI's JSON-mode session id after the first run reports it.
   * Subsequent turns pass it back via `pi --session <id>`.
   */
  async setPiSessionId(
    platform: string, channelId: string, threadId: string,
    piSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.piSessionId === piSessionId) return session
      session.piSessionId = piSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist MiMo Code's JSON-mode session id after the first run reports it.
   * Subsequent turns pass it back via `mimo run --session <id>`.
   */
  async setMimoSessionId(
    platform: string, channelId: string, threadId: string,
    mimoSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.mimoSessionId === mimoSessionId) return session
      session.mimoSessionId = mimoSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist GitHub Copilot CLI's Agim-allocated session UUID.
   * Subsequent turns pass it back via `copilot --session-id <uuid>`.
   */
  async setCopilotSessionId(
    platform: string, channelId: string, threadId: string,
    copilotSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.copilotSessionId === copilotSessionId) return session
      session.copilotSessionId = copilotSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Persist Cursor's stream-json session_id after system.init reports it.
   * Subsequent turns pass it back via `cursor-agent --resume <id>`.
   */
  async setCursorSessionId(
    platform: string, channelId: string, threadId: string,
    cursorSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (session.cursorSessionId === cursorSessionId) return session
      session.cursorSessionId = cursorSessionId
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /**
   * Increment the per-session usage roll-up after a successful agent
   * invocation. Used by router.callAgentWithHistory to power /stats.
   */
  async recordUsage(
    platform: string, channelId: string, threadId: string,
    delta: {
      costUsd: number
      costKnown?: boolean
      tokensInput?: number
      tokensOutput?: number
      promptChars: number
      responseChars: number
      durationMs: number
    },
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return
      if (!session.usage) {
        session.usage = {
          turns: 0,
          costUsd: 0,
          tokensInput: 0,
          tokensOutput: 0,
          unknownCostTurns: 0,
          promptChars: 0,
          responseChars: 0,
          durationMsTotal: 0,
          startedAt: new Date().toISOString(),
        }
      }
      session.usage.turns += 1
      session.usage.costUsd += Number.isFinite(delta.costUsd) ? delta.costUsd : 0
      session.usage.tokensInput = (session.usage.tokensInput ?? 0)
        + (Number.isFinite(delta.tokensInput) ? (delta.tokensInput ?? 0) : 0)
      session.usage.tokensOutput = (session.usage.tokensOutput ?? 0)
        + (Number.isFinite(delta.tokensOutput) ? (delta.tokensOutput ?? 0) : 0)
      if (delta.costKnown === false) {
        session.usage.unknownCostTurns = (session.usage.unknownCostTurns ?? 0) + 1
      }
      session.usage.promptChars += Number.isFinite(delta.promptChars) ? delta.promptChars : 0
      session.usage.responseChars += Number.isFinite(delta.responseChars) ? delta.responseChars : 0
      session.usage.durationMsTotal += Number.isFinite(delta.durationMs) ? delta.durationMs : 0
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
    })
  }

  /**
   * Reset conversation history (keep session but clear messages)
   */
  async resetConversation(
    platform: string,
    channelId: string,
    threadId: string
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)

      if (session) {
        const retiredId = session.id
        session.messages = []
        session.lastActivity = new Date()
        session.id = `${platform}-${channelId}-${threadId}-${Date.now()}-${randomBytes(4).toString('hex')}` // New session ID
        // Forget the old per-agent CLI sessions — /new should give a clean slate
        // for both Claude (`--resume`) and opencode (`--session`).
        delete session.claudeSessionId
        delete session.claudeSessionPrimed
        delete session.opencodeSessionId
        delete session.codexSessionId
        delete session.antigravitySessionId
        delete session.kimiSessionId
        delete session.qoderSessionId
        delete session.piSessionId
        delete session.mimoSessionId
        delete session.copilotSessionId
        delete session.cursorSessionId
        // Plan mode is per-conversation intent ("先规划再动手") — a fresh
        // conversation always starts at "off" so users don't get a surprising
        // read-only run after /new.
        delete session.planMode
        delete session.stepReflect
        // Compression rate is also per-conversation; /new returns to auto.
        delete session.compactRate
        // Preferred Loop worker is conversation-scoped.
        delete session.preferredWorkerAgent
        clearPlanModeForThread(key)
        // Drop any per-thread auto-allow approval rules so the new conversation
        // starts back at "ask every time".
        try { approvalBus.clearAutoAllowForThread(key) } catch { /* ignore */ }
        // Thumbs votes + pending downvote steer are conversation-scoped.
        try {
          await clearThreadFeedback(platform, channelId, threadId)
          clearPendingDownvoteHint(feedbackThreadKey(platform, channelId, threadId))
        } catch { /* ignore */ }
        this.sessions.set(key, session)
        await this.saveSession(key, session)
        // Quarantine the previous Agim Agent JSONL (does not block /new).
        scheduleRetireAgimAgentSession(retiredId, 'new')
        return session
      }

      return undefined
    })
  }

  /**
   * Get session with messages (convenience method)
   */
  async getSessionWithHistory(
    platform: string,
    channelId: string,
    threadId: string
  ): Promise<{ session: Session; messages: ChatMessage[] } | undefined> {
    const session = await this.getExistingSession(platform, channelId, threadId)
    if (session) {
      return { session, messages: session.messages }
    }
    return undefined
  }

  /**
   * Create or get a subtask session (independent from parent).
   */
  async getOrCreateSubSession(
    platform: string, channelId: string, threadId: string,
    subtaskId: number, agent: string
  ): Promise<Session> {
    const key = `${platform}:${channelId}:${threadId}:sub:${subtaskId}`
    const now = new Date()
    return this.withLock(key, async () => {
      let session = this.sessions.get(key) || await this.loadSession(key)
      if (session) {
        session.lastActivity = now
        await this.saveSessionMeta(key, session)
        return session
      }
      session = {
        id: `sub-${platform}-${channelId}-${threadId}-${subtaskId}`,
        channelId, threadId, platform, agent,
        createdAt: now, lastActivity: now, ttl: DEFAULT_TTL, messages: [],
      }
      this.sessions.set(key, session)
      await this.saveSession(key, session)
      return session
    })
  }

  /**
   * Set active subtask id on parent session — subsequent messages route to the subtask.
   */
  async setActiveSubtask(
    platform: string, channelId: string, threadId: string, taskId: number | null
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return
      session.activeSubtaskId = taskId
      this.sessions.set(key, session)
      await this.saveSession(key, session)
    })
  }

  /**
   * Get subtask metadata list from parent session.
   */
  async getSubtasks(platform: string, channelId: string, threadId: string): Promise<SubtaskMeta[]> {
    const key = `${platform}:${channelId}:${threadId}`
    const session = this.sessions.get(key) || await this.loadSession(key)
    return session?.subtasks || []
  }

  /**
   * Scan all session files on disk and return every subtask, flattened, with
   * its parent platform/channelId/threadId/agent attached so the dashboard
   * can render subtasks across all conversations.
   *
   * Session files live as `<sanitized-key>.json` under SESSIONS_DIR. The
   * sanitized key is one-way (sha256-prefix per non-alnum char), so we
   * cannot reverse it — but each session file preserves the original
   * platform/channelId/threadId fields, which is what we need.
   */
  async listAllSubtasks(opts: { agent?: string } = {}): Promise<Array<SubtaskMeta & {
    platform: string
    channelId: string
    threadId: string
    parentAgent: string
    parentSessionId: string
  }>> {
    let names: string[]
    try {
      names = await readdir(SESSIONS_DIR)
    } catch {
      return []
    }
    const out: Array<SubtaskMeta & {
      platform: string
      channelId: string
      threadId: string
      parentAgent: string
      parentSessionId: string
    }> = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await readFile(join(SESSIONS_DIR, name), 'utf-8')
        const parsed = JSON.parse(raw) as Partial<Session>
        if (!parsed.subtasks?.length) continue
        // Filter by parent-agent up-front so we don't allocate items we'll
        // discard. Subtasks inherit the parent session's agent — there is
        // no per-subtask agent override today.
        if (opts.agent && (parsed.agent || '') !== opts.agent) continue
        for (const st of parsed.subtasks) {
          out.push({
            ...st,
            createdAt: st.createdAt ? new Date(st.createdAt) : new Date(0),
            completedAt: st.completedAt ? new Date(st.completedAt) : undefined,
            platform: parsed.platform || '',
            channelId: parsed.channelId || '',
            threadId: parsed.threadId || '',
            parentAgent: parsed.agent || '',
            parentSessionId: parsed.id || '',
          })
        }
      } catch {
        // skip corrupt session file
      }
    }
    // newest first
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return out
  }

  /**
   * Update subtask metadata in parent session.
   */
  async updateSubtask(
    platform: string, channelId: string, threadId: string,
    taskId: number, patch: Partial<SubtaskMeta>
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return
      if (!session.subtasks) { session.subtasks = [] }
      const idx = session.subtasks.findIndex(s => s.id === taskId)
      if (idx >= 0) {
        session.subtasks[idx] = { ...session.subtasks[idx], ...patch }
      } else {
        session.subtasks.push({ id: taskId, ...patch } as SubtaskMeta)
      }
      this.sessions.set(key, session)
      await this.saveSession(key, session)
    })
  }

  /**
   * Get next subtask id and persist the increment.
   *
   * Previously returned 1 when the parent session didn't exist yet, but
   * never created one — second call returned 1 again, leading to subtask
   * id collisions. Now we lazy-create the parent session so the counter
   * increments durably from the first call.
   */
  async nextSubtaskId(
    platform: string, channelId: string, threadId: string, agent = ''
  ): Promise<number> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      let session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) {
        const now = new Date()
        session = {
          id: `${platform}-${channelId}-${threadId}-${Date.now()}-${randomBytes(4).toString('hex')}`,
          channelId, threadId, platform, agent,
          createdAt: now, lastActivity: now, ttl: DEFAULT_TTL, messages: [],
          subtaskCounter: 0,
        }
      }
      session.subtaskCounter = (session.subtaskCounter || 0) + 1
      this.sessions.set(key, session)
      await this.saveSession(key, session)
      return session.subtaskCounter
    })
  }

  /**
   * Persist the full session (metadata + messages). Used for the legacy
   * one-file format on resetConversation() and switchAgent() — anywhere
   * the messages array itself was rewritten. Atomic via tmp+rename.
   */
  private async saveSession(key: string, session: Session): Promise<void> {
    await this.saveSessionMeta(key, session)
    // Rewrite the JSONL log to match the in-memory messages array. This is
    // only called from paths that actually mutate `messages` wholesale
    // (resetConversation, switchAgent). addMessage uses appendFile which
    // is far cheaper for the hot path.
    const logPath = sessionLogPath(key)
    try {
      const lines = session.messages.map((m) => JSON.stringify(m)).join('\n')
      await this.atomicWrite(logPath, lines + (lines ? '\n' : ''))
    } catch {
      // disk failure — in-memory state is still authoritative
    }
  }

  /** Persist metadata only (no messages payload), atomically. */
  private async saveSessionMeta(key: string, session: Session): Promise<void> {
    const filePath = sessionFilePath(key)
    try {
      const meta: Omit<Session, 'messages'> & { messageCount: number } = {
        id: session.id,
        channelId: session.channelId,
        threadId: session.threadId,
        platform: session.platform,
        agent: session.agent,
        preferredWorkerAgent: session.preferredWorkerAgent,
        model: session.model,
        variant: session.variant,
        compactRate: session.compactRate,
        usage: session.usage,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        ttl: session.ttl,
        activeSubtaskId: session.activeSubtaskId,
        subtasks: session.subtasks,
        subtaskCounter: session.subtaskCounter,
        claudeSessionId: session.claudeSessionId,
        claudeSessionPrimed: session.claudeSessionPrimed,
        opencodeSessionId: session.opencodeSessionId,
        codexSessionId: session.codexSessionId,
        antigravitySessionId: session.antigravitySessionId,
        kimiSessionId: session.kimiSessionId,
        qoderSessionId: session.qoderSessionId,
        piSessionId: session.piSessionId,
        mimoSessionId: session.mimoSessionId,
        copilotSessionId: session.copilotSessionId,
        cursorSessionId: session.cursorSessionId,
        planMode: session.planMode,
        workspacePath: session.workspacePath,
        ...(typeof session.stepReflect === 'boolean' ? { stepReflect: session.stepReflect } : {}),
        messageCount: session.messages.length,
      }
      await this.atomicWrite(filePath, JSON.stringify(meta, null, 2))
    } catch {
      // ignore
    }
  }

  /** Crash-safe write: tmp file + atomic rename.
   *
   *  Recovers from ENOENT (parent dir missing) by mkdir-recursive + retry
   *  exactly once. This keeps the manager robust to environments where
   *  start() wasn't called yet — tests in particular tend to import
   *  sessionManager without going through the start() lifecycle, and
   *  saveSessionMeta's outer try/catch would otherwise swallow the ENOENT
   *  and silently produce a no-op write (the bug that caused
   *  session-subtasks.test.ts to fail on a fresh CI runner). */
  private async atomicWrite(filePath: string, contents: string): Promise<void> {
    const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
    try {
      // mode 0o600 so the temp file (and the renamed-into final file)
      // is unreadable by other users even when umask is lax.
      await writeFile(tmp, contents, { mode: 0o600 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 })
        await writeFile(tmp, contents, { mode: 0o600 })
      } else {
        throw err
      }
    }
    try {
      await rename(tmp, filePath)
    } catch (err) {
      try { await unlink(tmp) } catch { /* ignore */ }
      throw err
    }
  }

  private async loadSession(key: string): Promise<Session | undefined> {
    const filePath = sessionFilePath(key)
    try {
      const data = await readFile(filePath, 'utf-8')
      const session = deserializeSession(JSON.parse(data))
      if (!session) return undefined
      // Convert message timestamps from legacy format if present
      session.messages = session.messages.map((msg) => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
      }))
      // Then merge in JSONL log entries (new format).
      try {
        const log = await readFile(sessionLogPath(key), 'utf-8')
        const logged: ChatMessage[] = []
        for (const line of log.split('\n')) {
          if (!line.trim()) continue
          try {
            const m = JSON.parse(line) as ChatMessage
            logged.push({ ...m, timestamp: new Date(m.timestamp) })
          } catch { /* skip corrupt line */ }
        }
        // The log is authoritative for new-format sessions. If both exist
        // (rare, after a save followed by addMessage), the log wins.
        if (logged.length > 0) {
          session.messages = logged
        }
      } catch {
        // No log file — legacy format only
      }
      return session
    } catch {
      return undefined
    }
  }

  private async cleanup(): Promise<void> {
    const now = Date.now()

    for (const [key, session] of this.sessions.entries()) {
      const idle = now - session.lastActivity.getTime()
      if (idle > metaTtl()) {
        // Full eviction: thread truly cold. Drop both files + cache entry.
        const retiredId = session.id
        this.sessions.delete(key)
        const filePath = sessionFilePath(key)
        const logPath = sessionLogPath(key)
        try { await unlink(filePath) } catch { /* ignore */ }
        try { await unlink(logPath) } catch { /* ignore */ }
        // Messages TTL keeps sticky routing; META TTL drops the id entirely,
        // so the corresponding Agim Agent JSONL becomes an orphan.
        scheduleRetireAgimAgentSession(retiredId, 'meta_ttl')
      } else if (idle > messagesTtlFor(session.platform) && session.messages.length > 0) {
        // Messages-only eviction: keep sticky agent / claudeSessionId on disk
        // (meta file untouched), drop chat log + in-memory messages so the
        // next turn starts with a fresh history but the same routing.
        // Do NOT retire Agim Agent JSONL — session.id is still live.
        session.messages = []
        const logPath = sessionLogPath(key)
        try { await unlink(logPath) } catch { /* ignore */ }
      }
    }
  }
}

export const sessionManager = new SessionManager()
