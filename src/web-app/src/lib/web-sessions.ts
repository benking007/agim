/**
 * Browser-side index of Web chat sessions (`web-*` thread ids).
 *
 * Server persistence is unchanged: each id maps to `web:web:<threadId>`
 * under `~/.agim/sessions/`. This module only remembers which threads
 * *this browser* has opened so the Portal rail can switch via
 * `get-history { threadId }` instead of wiping the current log.
 *
 * `localStorage['agim-web-thread-id']` is the last-focused id (new tabs
 * and older upload paths still read it). Each tab also keeps its own
 * current thread in `sessionStorage['agim-web-tab-thread']` so another
 * window switching sessions cannot hydrate this tab into the wrong
 * transcript. `agim-web-sessions` holds the shared list + titles.
 * First load migrates a lone thread id into the index.
 */

import { CLOUD_WORKSPACE_ID, loadActiveWorkspaceId } from './web-workspaces'

export const WEB_THREAD_RE = /^web-[A-Za-z0-9_-]{4,64}$/
export const THREAD_ID_KEY = 'agim-web-thread-id'
export const TAB_THREAD_KEY = 'agim-web-tab-thread'
export const SESSIONS_KEY = 'agim-web-sessions'
export const MAX_SESSIONS = 50

export interface WebSessionEntry {
  id: string
  title?: string
  updatedAt: number
  agent?: string
  /** Portal workspace this thread belongs to. Missing → cloud. */
  workspaceId?: string
  /** Hidden from the Portal rail when set. Transcript stays on disk. */
  archivedAt?: number
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

export function persistTabThreadId(id: string): void {
  if (!isWebThreadId(id)) return
  try { sessionStorage.setItem(TAB_THREAD_KEY, id) } catch { /* private mode */ }
}

export function readTabThreadId(): string | null {
  try {
    const id = sessionStorage.getItem(TAB_THREAD_KEY)
    if (id && isWebThreadId(id)) return id
  } catch { /* private mode */ }
  return null
}

/**
 * This tab's current thread. Seeded once from the shared last-focused
 * id; later switches in *other* tabs do not steal it.
 */
export function loadTabThreadId(): string {
  const tab = readTabThreadId()
  if (tab) return tab
  const shared = loadIndex().activeId
  persistTabThreadId(shared)
  return shared
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
  const workspaceId = typeof rec.workspaceId === 'string' && rec.workspaceId.trim()
    ? rec.workspaceId.trim()
    : CLOUD_WORKSPACE_ID
  const archivedAt = typeof rec.archivedAt === 'number' && Number.isFinite(rec.archivedAt) && rec.archivedAt > 0
    ? rec.archivedAt
    : undefined
  return {
    id: rec.id,
    updatedAt,
    workspaceId,
    ...(title ? { title } : {}),
    ...(agent ? { agent } : {}),
    ...(archivedAt ? { archivedAt } : {}),
  }
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
      sessions.unshift({
        id: rec.activeId,
        updatedAt: Date.now(),
        workspaceId: CLOUD_WORKSPACE_ID,
      })
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
        sessions: [{ id: existing, updatedAt: Date.now(), workspaceId: CLOUD_WORKSPACE_ID }],
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
    sessions: [{ id: fresh, updatedAt: Date.now(), workspaceId: CLOUD_WORKSPACE_ID }],
  })
}

export function sessionWorkspaceId(entry: WebSessionEntry): string {
  return entry.workspaceId?.trim() || CLOUD_WORKSPACE_ID
}

export function isSessionArchived(entry: WebSessionEntry): boolean {
  return typeof entry.archivedAt === 'number' && entry.archivedAt > 0
}

export function listSessions(workspaceId?: string): WebSessionEntry[] {
  const listed = [...loadIndex().sessions]
    .filter((s) => !isSessionArchived(s))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (!workspaceId) return listed
  return listed.filter((s) => sessionWorkspaceId(s) === workspaceId)
}

export function findSession(id: string): WebSessionEntry | undefined {
  return loadIndex().sessions.find((s) => s.id === id)
}

export function upsertSession(patch: {
  id: string
  title?: string
  updatedAt?: number
  agent?: string
  workspaceId?: string
}): WebSessionIndex {
  const id = patch.id.trim()
  if (!isWebThreadId(id)) return loadIndex()
  const index = loadIndex()
  const existing = index.sessions.find((s) => s.id === id)
  const updatedAt = typeof patch.updatedAt === 'number' && Number.isFinite(patch.updatedAt)
    ? patch.updatedAt
    : (existing?.updatedAt ?? Date.now())
  const workspaceId = patch.workspaceId?.trim()
    || existing?.workspaceId
    || loadActiveWorkspaceId()
  const nextEntry: WebSessionEntry = {
    id,
    updatedAt,
    workspaceId,
    title: patch.title?.trim() || existing?.title,
    agent: patch.agent?.trim() || existing?.agent,
    ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}),
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

/** Replace the local rail with the server-authoritative list. */
export function replaceIndexFromServer(rows: WebSessionEntry[], activeId?: string): WebSessionIndex {
  const sessions = rows.filter((s) => isWebThreadId(s.id))
  if (sessions.length === 0) return loadIndex()
  const nextActive = (activeId && sessions.some((s) => s.id === activeId))
    ? activeId
    : (sessions.find((s) => !s.archivedAt)?.id || sessions[0]!.id)
  persistTabThreadId(nextActive)
  return writeIndex({ activeId: nextActive, sessions })
}

export function setActiveId(id: string): WebSessionIndex {
  const next = id.trim()
  if (!isWebThreadId(next)) return loadIndex()
  persistTabThreadId(next)
  const index = loadIndex()
  let sessions = index.sessions
  if (!sessions.some((s) => s.id === next)) {
    sessions = [{
      id: next,
      updatedAt: Date.now(),
      workspaceId: loadActiveWorkspaceId(),
    }, ...sessions]
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
  persistTabThreadId(id)
  const index = loadIndex()
  const prev = previousId?.trim()
  let sessions = index.sessions
  if (prev && prev !== id) sessions = sessions.filter((s) => s.id !== prev)
  const existing = sessions.find((s) => s.id === id)
  const entry: WebSessionEntry = existing
    ? { ...existing, updatedAt: Date.now() }
    : { id, updatedAt: Date.now(), workspaceId: loadActiveWorkspaceId() }
  sessions = existing
    ? sessions.map((s) => (s.id === id ? entry : s))
    : [entry, ...sessions]
  return writeIndex({
    activeId: id,
    sessions: capSessions(sessions, id),
  })
}

function pickVisibleSuccessor(
  sessions: WebSessionEntry[],
  archived: WebSessionEntry,
): WebSessionEntry | undefined {
  const visible = sessions.filter((s) => !isSessionArchived(s))
  return visible.find((s) => sessionWorkspaceId(s) === sessionWorkspaceId(archived))
    ?? visible[0]
}

function ensureActiveVisible(index: WebSessionIndex, fallbackWorkspaceId: string): WebSessionIndex {
  const tabId = readTabThreadId() || index.activeId
  const tab = index.sessions.find((s) => s.id === tabId)
  const active = index.sessions.find((s) => s.id === index.activeId)
  if (tab && !isSessionArchived(tab) && active && !isSessionArchived(active)) return index

  let sessions = index.sessions
  const successor = pickVisibleSuccessor(sessions, tab ?? active ?? {
    id: index.activeId,
    updatedAt: Date.now(),
    workspaceId: fallbackWorkspaceId,
  })
  let activeId = successor?.id
  if (!activeId) {
    const fresh = mintThreadId()
    sessions = [{
      id: fresh,
      updatedAt: Date.now(),
      workspaceId: fallbackWorkspaceId,
    }, ...sessions]
    activeId = fresh
  }
  persistTabThreadId(activeId)
  return writeIndex({
    activeId,
    sessions: capSessions(sessions, activeId),
  })
}

/** Hide a thread from the Portal rail. Server transcript is unchanged. */
export function archiveSession(id: string): WebSessionIndex {
  const next = id.trim()
  if (!isWebThreadId(next)) return loadIndex()
  const index = loadIndex()
  const target = index.sessions.find((s) => s.id === next)
  if (!target || isSessionArchived(target)) return index
  const sessions = index.sessions.map((s) => (
    s.id === next ? { ...s, archivedAt: Date.now() } : s
  ))
  const written = writeIndex({
    activeId: index.activeId,
    sessions: capSessions(sessions, index.activeId),
  })
  return ensureActiveVisible(written, sessionWorkspaceId(target))
}

/** Hide every visible thread that belongs to a Portal workspace. */
export function archiveSessionsForWorkspace(workspaceId: string): WebSessionIndex {
  const id = workspaceId.trim() || CLOUD_WORKSPACE_ID
  const index = loadIndex()
  const now = Date.now()
  let changed = false
  const sessions = index.sessions.map((s) => {
    if (sessionWorkspaceId(s) !== id || isSessionArchived(s)) return s
    changed = true
    return { ...s, archivedAt: now }
  })
  if (!changed) return index
  const written = writeIndex({
    activeId: index.activeId,
    sessions: capSessions(sessions, index.activeId),
  })
  return ensureActiveVisible(written, CLOUD_WORKSPACE_ID)
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.storageArea && e.storageArea !== localStorage) return
    if (e.key !== SESSIONS_KEY && e.key !== THREAD_ID_KEY && e.key !== null) return
    notify()
  })
}
