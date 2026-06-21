// IM admin registry — single source of truth for:
//   1) Who can run admin-only IM commands (/restart, /stop, ...)
//   2) Which IM identities have talked to agim (for Web settings selection)
//
// v2 model:
//   - No IM admin bootstrap token
//   - No IMHUB_ADMIN_USERS runtime dependency
//   - Web admin token operators manage IM admins in Settings → Admins
//
// Back-compat:
//   - If legacy IMHUB_ADMIN_USERS is present, we import it once into the
//     file store on first load, then continue using the file as source of truth.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'admin-allowlist' })

function storeFilePath(): string {
  return join(process.env.AGIM_HOME || process.env.IMHUB_HOME || AGIM_HOME, 'im-admins.json')
}

interface Entry {
  platform: string
  userId: string
}

export interface KnownImUser {
  platform: string
  userId: string
  firstSeenAt: string
  lastSeenAt: string
  lastChannelId?: string
  lastThreadId?: string
}

interface Store {
  version: 1
  admins: Entry[]
  knownUsers: KnownImUser[]
}

function emptyStore(): Store {
  return { version: 1, admins: [], knownUsers: [] }
}

let cachedStore: Store | null = null
let loggedOnce = false

function normalizeEntry(platform: string, userId: string | undefined): Entry | null {
  const p = platform.trim().toLowerCase()
  const u = (userId ?? '').trim()
  if (!p || !u) return null
  return { platform: p, userId: u }
}

function keyOf(entry: Entry): string {
  return `${entry.platform}:${entry.userId}`
}

function dedupeEntries(entries: Entry[]): Entry[] {
  const m = new Map<string, Entry>()
  for (const e of entries) m.set(keyOf(e), e)
  return [...m.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
}

function dedupeKnownUsers(rows: KnownImUser[]): KnownImUser[] {
  const m = new Map<string, KnownImUser>()
  for (const row of rows) {
    const norm = normalizeEntry(row.platform, row.userId)
    if (!norm) continue
    const existing = m.get(keyOf(norm))
    if (!existing || existing.lastSeenAt < row.lastSeenAt) {
      m.set(keyOf(norm), {
        platform: norm.platform,
        userId: norm.userId,
        firstSeenAt: row.firstSeenAt || row.lastSeenAt,
        lastSeenAt: row.lastSeenAt || row.firstSeenAt,
        lastChannelId: row.lastChannelId,
        lastThreadId: row.lastThreadId,
      })
    }
  }
  return [...m.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

function parseLegacyAdminEnv(raw: string): Entry[] {
  const out: Entry[] = []
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0 || idx === trimmed.length - 1) continue
    const norm = normalizeEntry(trimmed.slice(0, idx), trimmed.slice(idx + 1))
    if (norm) out.push(norm)
  }
  return dedupeEntries(out)
}

function normalizeStore(store: Partial<Store> | null | undefined): Store {
  return {
    version: 1,
    admins: dedupeEntries((store?.admins ?? [])
      .map((e) => normalizeEntry(e.platform, e.userId))
      .filter((e): e is Entry => e !== null)),
    knownUsers: dedupeKnownUsers(store?.knownUsers ?? []),
  }
}

function readStoreFromDisk(): Store {
  const storeFile = storeFilePath()
  if (!existsSync(storeFile)) return emptyStore()
  try {
    const raw = JSON.parse(readFileSync(storeFile, 'utf-8')) as Partial<Store>
    return normalizeStore(raw)
  } catch (err) {
    log.warn({
      event: 'admin.allowlist.read_failed',
      err: err instanceof Error ? err.message : String(err),
    }, 'failed to read admin store; using empty state')
    return emptyStore()
  }
}

function writeStoreToDisk(store: Store): void {
  const storeFile = storeFilePath()
  mkdirSync(dirname(storeFile), { recursive: true })
  writeFileSync(storeFile, JSON.stringify(store, null, 2), 'utf-8')
  try { chmodSync(storeFile, 0o600) } catch { /* ignore */ }
}

function ensureStoreLoaded(): Store {
  if (cachedStore) return cachedStore
  const loaded = readStoreFromDisk()
  const legacy = parseLegacyAdminEnv(process.env.IMHUB_ADMIN_USERS ?? '')
  if (legacy.length > 0) {
    const before = loaded.admins.length
    loaded.admins = dedupeEntries([...loaded.admins, ...legacy])
    if (loaded.admins.length !== before) {
      writeStoreToDisk(loaded)
      log.warn({
        event: 'admin.allowlist.legacy_env_migrated',
        fromEnvCount: legacy.length,
        mergedCount: loaded.admins.length,
      }, 'migrated IMHUB_ADMIN_USERS into im-admins.json; env value is now legacy-only')
    }
  }
  cachedStore = loaded
  return cachedStore
}

function commitStore(next: Store): void {
  const normalized = normalizeStore(next)
  cachedStore = normalized
  writeStoreToDisk(normalized)
}

/** Returns true iff at least one IM admin is configured. */
export function isAllowlistConfigured(): boolean {
  return ensureStoreLoaded().admins.length > 0
}

/** Returns true iff the caller is in IM admin list. */
export function isAdmin(platform: string, userId: string | undefined): boolean {
  const norm = normalizeEntry(platform, userId)
  if (!norm) return false
  return ensureStoreLoaded().admins.some((e) => e.platform === norm.platform && e.userId === norm.userId)
}

/** List configured IM admins. */
export function listAdmins(): Array<{ platform: string; userId: string }> {
  return ensureStoreLoaded().admins.map((e) => ({ platform: e.platform, userId: e.userId }))
}

/** List known IM users discovered from real inbound messages. */
export function listKnownImUsers(): KnownImUser[] {
  return ensureStoreLoaded().knownUsers.map((u) => ({ ...u }))
}

/** Record that an IM user has interacted with agim. */
export function recordSeenImUser(
  platform: string,
  userId: string | undefined,
  meta?: { channelId?: string; threadId?: string },
): boolean {
  const norm = normalizeEntry(platform, userId)
  if (!norm) return false
  const store = ensureStoreLoaded()
  const now = new Date().toISOString()
  const idx = store.knownUsers.findIndex((u) => u.platform === norm.platform && u.userId === norm.userId)
  if (idx >= 0) {
    const row = store.knownUsers[idx]!
    const changed = row.lastSeenAt !== now
      || row.lastChannelId !== meta?.channelId
      || row.lastThreadId !== meta?.threadId
    row.lastSeenAt = now
    if (meta?.channelId) row.lastChannelId = meta.channelId
    if (meta?.threadId) row.lastThreadId = meta.threadId
    if (changed) commitStore(store)
    return changed
  }
  store.knownUsers.push({
    platform: norm.platform,
    userId: norm.userId,
    firstSeenAt: now,
    lastSeenAt: now,
    ...(meta?.channelId ? { lastChannelId: meta.channelId } : {}),
    ...(meta?.threadId ? { lastThreadId: meta.threadId } : {}),
  })
  commitStore(store)
  return true
}

/** Promote an IM identity to admin (idempotent). */
export async function promoteAdmin(
  platform: string,
  userId: string,
  opts?: { actor?: string; traceId?: string },
): Promise<boolean> {
  const norm = normalizeEntry(platform, userId)
  if (!norm) throw new Error('platform and userId required')
  const store = ensureStoreLoaded()
  if (store.admins.some((e) => e.platform === norm.platform && e.userId === norm.userId)) return false
  store.admins.push(norm)
  // Ensure admin target always appears in known list.
  recordSeenImUser(norm.platform, norm.userId)
  commitStore(store)
  try {
    const { logAuditEvent } = await import('./audit-log.js')
    logAuditEvent({
      traceId: opts?.traceId,
      eventType: 'admin.elevate',
      actor: opts?.actor ?? 'system',
      target: `${norm.platform}:${norm.userId}`,
      outcome: 'ok',
      details: { total: store.admins.length },
    })
  } catch { /* best-effort */ }
  return true
}

/** Revoke admin permission from an IM identity (idempotent false on missing). */
export async function revokeAdmin(
  platform: string,
  userId: string,
  opts?: { actor?: string; traceId?: string },
): Promise<boolean> {
  const norm = normalizeEntry(platform, userId)
  if (!norm) throw new Error('platform and userId required')
  const store = ensureStoreLoaded()
  const before = store.admins.length
  store.admins = store.admins.filter((e) => !(e.platform === norm.platform && e.userId === norm.userId))
  if (store.admins.length === before) return false
  commitStore(store)
  try {
    const { logAuditEvent } = await import('./audit-log.js')
    logAuditEvent({
      traceId: opts?.traceId,
      eventType: 'admin.revoke',
      actor: opts?.actor ?? 'system',
      target: `${norm.platform}:${norm.userId}`,
      outcome: 'ok',
      details: { total: store.admins.length },
    })
  } catch { /* best-effort */ }
  return true
}

export function denialMessage(platform: string, userId: string | undefined): string {
  const me = `${platform.toLowerCase()}:${userId ?? '<unknown>'}`
  if (!isAllowlistConfigured()) {
    return (
      '🛑 这个 bot 还没有配置任何 IM 管理员。\n' +
      '   请让 Web 后台管理员在“设置 → 管理员”把你加入管理员名单。\n' +
      `   你的账号：${me}`
    )
  }
  return (
    '🛑 你没有权限执行此操作。\n' +
    '   如果你认为应当有权限，请联系 Web 后台管理员把你的 IM 账号加入管理员名单。'
  )
}

/** Startup diagnostics. */
export function logStartupResolution(): void {
  if (loggedOnce) return
  loggedOnce = true
  const store = ensureStoreLoaded()
  log.info({
    event: 'admin.allowlist.loaded',
    admins: store.admins.length,
    knownUsers: store.knownUsers.length,
    store: storeFilePath(),
  }, `admin registry loaded: ${store.admins.length} admin(s), ${store.knownUsers.length} known IM user(s)`)
}

/** Test-only reset. */
export function _resetCache(): void {
  cachedStore = null
  loggedOnce = false
}
