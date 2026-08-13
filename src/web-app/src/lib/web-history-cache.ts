/**
 * Per-thread chat transcript cache in localStorage.
 *
 * Refresh / session switch still round-trip `get-history` over WS. The
 * previous paint waited on that frame (and then remounted markdown). This
 * module lets the SPA paint the last snapshot immediately; the server
 * remains authoritative and reconciles without replacing the same tail
 * (so the visible reply does not re-parse).
 *
 * Why not dump the full .log into one key: localStorage is typically ~5 MiB
 * per origin. A long report plus tool previews will not fit 50 sessions.
 * We keep an LRU of recent threads, cap message count, slim activity
 * previews, and shrink older bodies first so the latest assistant stays
 * as complete as quota allows.
 *
 * Keys:
 *   agim-web-hist-index          — LRU thread ids (newest first)
 *   agim-web-hist:<threadId>     — JSON snapshot
 */

import { isWebThreadId, loadIndex } from '@/lib/web-sessions'
import type { ChatActivity, ChatMessage, ChatState } from '@/hooks/chat/chat-types'
import { initialChatState } from '@/hooks/chat/chat-reducer'

export const HIST_INDEX_KEY = 'agim-web-hist-index'
export const HIST_KEY_PREFIX = 'agim-web-hist:'

export const MAX_CACHED_THREADS = 8
export const MAX_CACHED_MESSAGES = 60
export const MAX_CACHE_JSON_CHARS = 1_200_000
export const CACHE_PREVIEW_MAX_CHARS = 280
export const CACHE_OLD_CONTENT_MAX_CHARS = 8_000

export interface CachedHistory {
  v: 1
  threadId: string
  savedAt: number
  agent?: string
  preferredWorkerAgent?: string
  planMode?: boolean
  thinkVariant?: string
  sessionModel?: string
  compactRate?: string
  messages: ChatMessage[]
}

export interface HistoryPersistSnap {
  messages: ChatMessage[]
  agent?: string
  preferredWorkerAgent?: string
  planMode?: boolean
  thinkVariant?: string
  sessionModel?: string
  compactRate?: string
}

function histKey(threadId: string): string {
  return `${HIST_KEY_PREFIX}${threadId}`
}

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(HIST_INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const ids: string[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'string' || !isWebThreadId(item) || seen.has(item)) continue
      seen.add(item)
      ids.push(item)
    }
    return ids
  } catch {
    return []
  }
}

function writeIndex(ids: string[]): void {
  try {
    localStorage.setItem(HIST_INDEX_KEY, JSON.stringify(ids.slice(0, MAX_CACHED_THREADS)))
  } catch { /* quota / private mode */ }
}

function capPreview(preview: string | undefined): string | undefined {
  if (preview == null || preview.length <= CACHE_PREVIEW_MAX_CHARS) return preview
  return `${preview.slice(0, CACHE_PREVIEW_MAX_CHARS)}…`
}

function slimActivity(activity: ChatActivity | undefined): ChatActivity | undefined {
  if (!activity?.steps?.length) return activity
  return {
    ...activity,
    steps: activity.steps.map((st) => {
      const preview = capPreview(st.preview)
      return preview === st.preview ? st : { ...st, preview }
    }),
  }
}

function slimMessage(message: ChatMessage, contentMax: number): ChatMessage {
  const activity = slimActivity(message.activity)
  const content = message.content.length > contentMax
    ? `${message.content.slice(0, contentMax)}…`
    : message.content
  if (activity === message.activity && content === message.content) return message
  return { ...message, content, ...(activity ? { activity } : {}) }
}

/** Last N messages; older bodies capped; last assistant kept fullest. */
export function slimCachedMessages(messages: ChatMessage[]): ChatMessage[] {
  const tail = messages.length > MAX_CACHED_MESSAGES
    ? messages.slice(messages.length - MAX_CACHED_MESSAGES)
    : messages
  if (tail.length === 0) return tail
  const last = tail.length - 1
  return tail.map((m, i) => slimMessage(
    m,
    i === last ? Number.POSITIVE_INFINITY : CACHE_OLD_CONTENT_MAX_CHARS,
  ))
}

function dropThread(threadId: string): void {
  try { localStorage.removeItem(histKey(threadId)) } catch { /* ignore */ }
}

function evictOldest(ids: string[], keepId?: string): string[] {
  const next = [...ids]
  let victimAt = -1
  for (let i = next.length - 1; i >= 0; i--) {
    if (!keepId || next[i] !== keepId) {
      victimAt = i
      break
    }
  }
  if (victimAt < 0) return next
  const victim = next[victimAt]
  if (victim) dropThread(victim)
  next.splice(victimAt, 1)
  return next
}

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22
}

function trySet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (err) {
    if (!isQuotaError(err)) return false
    return false
  }
}

function shrinkPayload(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 2) {
    const last = messages.at(-1)
    if (!last || last.content.length <= 24_000) return messages
    return messages.map((m, i) => (
      i === messages.length - 1 ? slimMessage(m, 24_000) : m
    ))
  }
  return messages.slice(Math.max(0, messages.length - Math.max(2, Math.floor(messages.length / 2))))
}

export function readCachedHistory(threadId: string): CachedHistory | null {
  const id = threadId.trim()
  if (!isWebThreadId(id)) return null
  try {
    const raw = localStorage.getItem(histKey(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const rec = parsed as Record<string, unknown>
    if (rec.v !== 1 || rec.threadId !== id || !Array.isArray(rec.messages)) return null
    const messages: ChatMessage[] = []
    for (const item of rec.messages) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string') continue
      if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system') continue
      if (typeof row.content !== 'string') continue
      const msg: ChatMessage = {
        id: row.id,
        role: row.role,
        content: row.content,
        timestamp: typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? row.timestamp : 0,
      }
      if (typeof row.agent === 'string') msg.agent = row.agent
      if (row.feedback === 'up' || row.feedback === 'down') msg.feedback = row.feedback
      if (typeof row.serverIndex === 'number') msg.serverIndex = row.serverIndex
      if (row.activity && typeof row.activity === 'object') {
        msg.activity = row.activity as ChatMessage['activity']
      }
      messages.push(msg)
    }
    if (messages.length === 0) return null
    return {
      v: 1,
      threadId: id,
      savedAt: typeof rec.savedAt === 'number' ? rec.savedAt : 0,
      agent: typeof rec.agent === 'string' ? rec.agent : undefined,
      preferredWorkerAgent: typeof rec.preferredWorkerAgent === 'string' ? rec.preferredWorkerAgent : undefined,
      planMode: rec.planMode === true,
      thinkVariant: typeof rec.thinkVariant === 'string' ? rec.thinkVariant : undefined,
      sessionModel: typeof rec.sessionModel === 'string' ? rec.sessionModel : undefined,
      compactRate: typeof rec.compactRate === 'string' ? rec.compactRate : undefined,
      messages,
    }
  } catch {
    return null
  }
}

export function writeCachedHistory(threadId: string, snap: HistoryPersistSnap): void {
  const id = threadId.trim()
  if (!isWebThreadId(id)) return
  if (snap.messages.length === 0) return
  let messages = slimCachedMessages(snap.messages)
  const body = (): string => JSON.stringify({
    v: 1,
    threadId: id,
    savedAt: Date.now(),
    agent: snap.agent || '',
    preferredWorkerAgent: snap.preferredWorkerAgent || '',
    planMode: !!snap.planMode,
    thinkVariant: snap.thinkVariant || 'auto',
    sessionModel: snap.sessionModel || '',
    compactRate: snap.compactRate || 'auto',
    messages,
  } satisfies CachedHistory)

  let json = body()
  while (json.length > MAX_CACHE_JSON_CHARS && messages.length > 2) {
    messages = shrinkPayload(messages)
    json = body()
  }

  let ids = readIndex().filter((x) => x !== id)
  ids.unshift(id)
  while (ids.length > MAX_CACHED_THREADS) {
    ids = evictOldest(ids, id)
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    writeIndex(ids)
    if (trySet(histKey(id), json)) return
    if (ids.length > 1) {
      ids = evictOldest(ids, id)
      continue
    }
    if (messages.length > 2) {
      messages = shrinkPayload(messages)
      json = body()
      continue
    }
    return
  }
}

export function applyCachedHistory(init: ChatState, threadId: string): ChatState {
  const cached = readCachedHistory(threadId)
  if (!cached) return { ...init, clientId: threadId }
  return {
    ...init,
    clientId: threadId,
    messages: cached.messages,
    agent: cached.agent || init.agent,
    preferredWorkerAgent: cached.preferredWorkerAgent || init.preferredWorkerAgent,
    planMode: cached.planMode ?? init.planMode,
    thinkVariant: cached.thinkVariant || init.thinkVariant,
    sessionModel: cached.sessionModel || init.sessionModel,
    compactRate: cached.compactRate || init.compactRate,
  }
}

export function cachedHistoryToAction(cached: CachedHistory): {
  kind: 'HISTORY'
  messages: ChatMessage[]
  agent: string
  preferredWorkerAgent: string
  planMode: boolean
  thinkVariant: string
  sessionModel: string
  compactRate: string
  historyComplete: true
} {
  return {
    kind: 'HISTORY',
    messages: cached.messages,
    agent: cached.agent || '',
    preferredWorkerAgent: cached.preferredWorkerAgent || '',
    planMode: !!cached.planMode,
    thinkVariant: cached.thinkVariant || 'auto',
    sessionModel: cached.sessionModel || '',
    compactRate: cached.compactRate || 'auto',
    historyComplete: true,
  }
}

/** First-paint helper used by useChat's reducer lazy init. */
export function hydrateInitialChatState(): ChatState {
  try {
    return applyCachedHistory(initialChatState, loadIndex().activeId)
  } catch {
    return initialChatState
  }
}
