/**
 * Browser-side index of Web chat sessions (`web-*` thread ids).
 *
 * Server persistence is unchanged: each id maps to `web:web:<threadId>`
 * under `~/.agim/sessions/`. This module only remembers which threads
 * *this browser* has opened so the Portal rail can switch via
 * `get-history { threadId }` instead of wiping the current log.
 *
 * `localStorage['agim-web-thread-id']` remains the active id (upload
 * paths and older builds still read it). `agim-web-sessions` holds the
 * list + titles. First load migrates a lone thread id into the index.
 */

export const WEB_THREAD_RE = /^web-[A-Za-z0-9_-]{4,64}$/
export const THREAD_ID_KEY = 'agim-web-thread-id'
export const SESSIONS_KEY = 'agim-web-sessions'
export const MAX_SESSIONS = 50

export interface WebSessionEntry {
  id: string
  title?: string
  updatedAt: number
  agent?: string
}

export interface WebSessionIndex {
  activeId: string
  sessions: WebSessionEntry[]
}

const listeners = new Set<() => void>()

export function isWebThreadId(id: string): boolean {
  return WEB_THREAD_RE.test(id)
}

export function mintThreadId(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Collapse whitespace and cap length for the rail label. */
export function sessionTitleFromText(text: string, max = 36): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (!one) return ''
  if (one.length <= max) return one
  return `${one.slice(0, max).trimEnd()}…`
}

export function subscribeSessions(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify(): void {
  for (const fn of listeners) fn()
}

function persistActiveId(id: string): void {
  try { localStorage.setItem(THREAD_ID_KEY, id) } catch { /* private mode */ }
}

function writeIndex(index: WebSessionIndex): WebSessionIndex {
  persistActiveId(index.activeId)
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(index)) } catch { /* private mode */ }
  notify()
  return index
}

function capSessions(sessions: WebSessionEntry[], activeId: string): WebSessionEntry[] {
  if (sessions.length <= MAX_SESSIONS) return sessions
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  let next = sorted.slice(0, MAX_SESSIONS)
  if (!next.some((s) => s.id === activeId)) {
    const active = sessions.find((s) => s.id === activeId)
    if (active) next = [...next.slice(0, MAX_SESSIONS - 1), active]
  }
  return next
}

function normalizeEntry(raw: unknown): WebSessionEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string' || !isWebThreadId(rec.id)) return null
  const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt)
    ? rec.updatedAt
    : Date.now()
  const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : undefined
  const agent = typeof rec.agent === 'string' && rec.agent.trim() ? rec.agent.trim() : undefined
  return { id: rec.id, updatedAt, ...(title ? { title } : {}), ...(agent ? { agent } : {}) }
}

function parseIndex(raw: string): WebSessionIndex | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return null
    const rec = v as Record<string, unknown>
    if (typeof rec.activeId !== 'string' || !isWebThreadId(rec.activeId)) return null
    if (!Array.isArray(rec.sessions)) return null
    const sessions: WebSessionEntry[] = []
    const seen = new Set<string>()
    for (const item of rec.sessions) {
      const entry = normalizeEntry(item)
      if (!entry || seen.has(entry.id)) continue
      seen.add(entry.id)
      sessions.push(entry)
    }
    if (sessions.length === 0) return null
    if (!sessions.some((s) => s.id === rec.activeId)) {
      sessions.unshift({ id: rec.activeId, updatedAt: Date.now() })
    }
    return { activeId: rec.activeId, sessions: capSessions(sessions, rec.activeId) }
  } catch {
    return null
  }
}

function migrateFromLegacyThreadId(): WebSessionIndex | null {
  try {
    const existing = localStorage.getItem(THREAD_ID_KEY)
    if (existing && isWebThreadId(existing)) {
      return {
        activeId: existing,
        sessions: [{ id: existing, updatedAt: Date.now() }],
      }
    }
  } catch { /* private mode */ }
  return null
}

/** Load (or create) the session index. Always returns at least one id. */
export function loadIndex(): WebSessionIndex {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (raw) {
      const parsed = parseIndex(raw)
      if (parsed) {
        persistActiveId(parsed.activeId)
        return parsed
      }
    }
  } catch { /* private mode */ }
  const migrated = migrateFromLegacyThreadId()
  if (migrated) return writeIndex(migrated)
  const fresh = mintThreadId()
  return writeIndex({
    activeId: fresh,
    sessions: [{ id: fresh, updatedAt: Date.now() }],
  })
}

export function listSessions(): WebSessionEntry[] {
  return [...loadIndex().sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function findSession(id: string): WebSessionEntry | undefined {
  return loadIndex().sessions.find((s) => s.id === id)
}

export function upsertSession(patch: { id: string; title?: string; updatedAt?: number; agent?: string }): WebSessionIndex {
  const id = patch.id.trim()
  if (!isWebThreadId(id)) return loadIndex()
  const index = loadIndex()
  const now = patch.updatedAt ?? Date.now()
  const existing = index.sessions.find((s) => s.id === id)
  const nextEntry: WebSessionEntry = {
    id,
    updatedAt: now,
    title: patch.title?.trim() || existing?.title,
    agent: patch.agent?.trim() || existing?.agent,
  }
  if (!nextEntry.title) delete nextEntry.title
  if (!nextEntry.agent) delete nextEntry.agent
  const sessions = existing
    ? index.sessions.map((s) => (s.id === id ? nextEntry : s))
    : [nextEntry, ...index.sessions]
  return writeIndex({
    activeId: index.activeId,
    sessions: capSessions(sessions, index.activeId),
  })
}

export function setActiveId(id: string): WebSessionIndex {
  const next = id.trim()
  if (!isWebThreadId(next)) return loadIndex()
  const index = loadIndex()
  let sessions = index.sessions
  if (!sessions.some((s) => s.id === next)) {
    sessions = [{ id: next, updatedAt: Date.now() }, ...sessions]
  }
  return writeIndex({
    activeId: next,
    sessions: capSessions(sessions, next),
  })
}

/**
 * Adopt a server-minted thread (ownership mismatch). Replaces `previousId`
 * in the index so the stale foreign id is not listed as clickable.
 */
export function adoptThreadId(next: string, previousId?: string): WebSessionIndex {
  const id = next.trim()
  if (!isWebThreadId(id)) return loadIndex()
  const index = loadIndex()
  const prev = previousId?.trim()
  let sessions = index.sessions
  if (prev && prev !== id) sessions = sessions.filter((s) => s.id !== prev)
  const existing = sessions.find((s) => s.id === id)
  const entry: WebSessionEntry = existing
    ? { ...existing, updatedAt: Date.now() }
    : { id, updatedAt: Date.now() }
  sessions = existing
    ? sessions.map((s) => (s.id === id ? entry : s))
    : [entry, ...sessions]
  return writeIndex({
    activeId: id,
    sessions: capSessions(sessions, id),
  })
}
