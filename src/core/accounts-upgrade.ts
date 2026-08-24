// Upgrade from pre-account installs: pick one old web session to keep.
// Old tokens are not a login method. After the first admin is created,
// they inherit one session or skip — skip discards those tokens and
// every session they owned (including loopback / anon / auth-off).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listUnownedTokens, revokeToken } from './access-token.js'
import { mutateAccounts, readAccounts } from './accounts-store.js'
import { AGIM_HOME } from './agim-paths.js'
import { claimMessengerSlots, listBindings, PLATFORM_CHANNEL } from './im-bind.js'
import { getLiveConfig } from './live-config.js'
import { logger as rootLogger } from './logger.js'
import { webThreadOwners } from './web-thread-owners.js'

const log = rootLogger.child({ component: 'accounts-upgrade' })

const LOCAL_OWNERS = new Set(['loopback', 'anon', 'auth-off'])

export interface LegacySessionRow {
  id: string
  title: string
  updatedAt: number
  turns: number
  agent?: string
}

export interface LegacyTokenGroup {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  sessions: LegacySessionRow[]
}

export interface LegacyUpgradePreview {
  pending: boolean
  tokens: LegacyTokenGroup[]
  local: { sessions: LegacySessionRow[] }
}

function currentHome(): string {
  return process.env.AGIM_HOME || AGIM_HOME
}

function sanitizeKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) => {
    return createHash('sha256').update(c).digest('hex').slice(0, 8)
  })
}

function sessionPaths(threadId: string): { json: string; log: string } {
  const key = sanitizeKey(`web:web:${threadId}`)
  const dir = join(currentHome(), 'sessions')
  return { json: join(dir, `${key}.json`), log: join(dir, `${key}.log`) }
}

function readSessionRow(threadId: string): LegacySessionRow {
  const { json } = sessionPaths(threadId)
  if (!existsSync(json)) {
    return { id: threadId, title: threadId, updatedAt: 0, turns: 0 }
  }
  try {
    const parsed = JSON.parse(readFileSync(json, 'utf-8')) as {
      title?: string
      lastActivity?: string | number
      agent?: string
      usage?: { turns?: number }
    }
    const raw = parsed.lastActivity
    const updatedAt = typeof raw === 'number'
      ? raw
      : (raw ? Date.parse(String(raw)) || 0 : 0)
    const title = typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : threadId
    return {
      id: threadId,
      title,
      updatedAt,
      turns: typeof parsed.usage?.turns === 'number' ? parsed.usage.turns : 0,
      agent: parsed.agent || undefined,
    }
  } catch {
    return { id: threadId, title: threadId, updatedAt: 0, turns: 0 }
  }
}

function deleteSessionFiles(threadId: string): void {
  const { json, log: logPath } = sessionPaths(threadId)
  try { unlinkSync(json) } catch { /* missing */ }
  try { unlinkSync(logPath) } catch { /* missing */ }
  webThreadOwners.delete(threadId)
}

function claimSessionOwner(threadId: string, userId: string): void {
  const { json } = sessionPaths(threadId)
  if (existsSync(json)) {
    try {
      const parsed = JSON.parse(readFileSync(json, 'utf-8')) as Record<string, unknown>
      parsed.ownerUserId = userId
      if (typeof parsed.platform !== 'string' || !parsed.platform) parsed.platform = 'web'
      if (typeof parsed.channelId !== 'string' || !parsed.channelId) parsed.channelId = 'web'
      if (typeof parsed.threadId !== 'string' || !parsed.threadId) parsed.threadId = threadId
      const tmp = `${json}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, json)
    } catch { /* keep going — thread owner still moves */ }
  }
  webThreadOwners.set(threadId, userId)
}

function sessionsForOwner(ownerId: string): LegacySessionRow[] {
  return webThreadOwners.entries()
    .filter((row) => row.ownerId === ownerId)
    .map((row) => readSessionRow(row.threadId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function markLegacyUpgradeDone(): void {
  mutateAccounts((data) => { data.legacyUpgradeDone = true })
}

export function listLegacyUpgrade(): LegacyUpgradePreview {
  if (readAccounts().legacyUpgradeDone) {
    return { pending: false, tokens: [], local: { sessions: [] } }
  }
  const tokens = listUnownedTokens().map((t) => ({
    id: t.id,
    label: t.label || t.id,
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
    sessions: sessionsForOwner(t.id),
  }))
  const localIds = new Set<string>()
  for (const row of webThreadOwners.entries()) {
    if (LOCAL_OWNERS.has(row.ownerId)) localIds.add(row.threadId)
  }
  const local = [...localIds].map((id) => readSessionRow(id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const pending = tokens.length > 0 || local.length > 0
  return { pending, tokens, local: { sessions: local } }
}

export function allLegacyThreadIds(preview = listLegacyUpgrade()): string[] {
  const ids = new Set<string>()
  for (const token of preview.tokens) {
    for (const session of token.sessions) ids.add(session.id)
  }
  for (const session of preview.local.sessions) ids.add(session.id)
  return [...ids]
}

function claimMessengers(userId: string): number {
  try {
    const cfg = getLiveConfig()
    const slots = Array.isArray(cfg?.messengers)
      ? cfg.messengers.filter((m): m is string => typeof m === 'string')
      : []
    if (slots.length > 0) claimMessengerSlots(slots, userId)
    return listBindings({ userId }).filter((b) => b.imUserId === PLATFORM_CHANNEL).length
  } catch {
    return 0
  }
}

function discardOrphanTokens(): number {
  let n = 0
  for (const token of listUnownedTokens()) {
    if (revokeToken(token.id, { actor: 'legacy-upgrade' })) n += 1
  }
  return n
}

function discardThreads(threadIds: string[]): number {
  let n = 0
  for (const id of threadIds) {
    deleteSessionFiles(id)
    n += 1
  }
  return n
}

export function inheritLegacySession(userId: string, threadId: string): {
  inherited: string
  discardedTokens: number
  discardedSessions: number
  messengers: number
} {
  const preview = listLegacyUpgrade()
  if (!allLegacyThreadIds(preview).includes(threadId)) {
    throw Object.assign(new Error('session not in legacy upgrade list'), { code: 'LEGACY_SESSION_UNKNOWN' })
  }
  const drop = allLegacyThreadIds(preview).filter((id) => id !== threadId)
  discardThreads(drop)
  claimSessionOwner(threadId, userId)
  const discardedTokens = discardOrphanTokens()
  const messengers = claimMessengers(userId)
  markLegacyUpgradeDone()
  log.info({
    event: 'accounts.legacy_inherited',
    userId,
    threadId,
    discardedTokens,
    discardedSessions: drop.length,
    messengers,
  }, 'legacy session inherited; other tokens and sessions discarded')
  return {
    inherited: threadId,
    discardedTokens,
    discardedSessions: drop.length,
    messengers,
  }
}

export function skipLegacyUpgrade(userId: string): {
  discardedTokens: number
  discardedSessions: number
  messengers: number
} {
  const drop = allLegacyThreadIds()
  discardThreads(drop)
  const discardedTokens = discardOrphanTokens()
  const messengers = claimMessengers(userId)
  markLegacyUpgradeDone()
  log.info({
    event: 'accounts.legacy_skipped',
    userId,
    discardedTokens,
    discardedSessions: drop.length,
    messengers,
  }, 'legacy tokens and sessions discarded')
  return { discardedTokens, discardedSessions: drop.length, messengers }
}

/** First-admin hook: claim messengers only. Tokens wait for the inherit step. */
export function adoptLegacyInstall(userId: string): { tokens: number; messengers: number } {
  return { tokens: 0, messengers: claimMessengers(userId) }
}
