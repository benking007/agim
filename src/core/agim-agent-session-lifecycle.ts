/**
 * Agim Agent (pi JSONL) session quarantine / retention.
 *
 * Agim's sticky routing lives in `~/.agim/sessions/*.json`, while the Agim
 * Agent conversation truth lives under `~/.agim/agim-sessions/` (JsonlSessionRepo).
 * `/new`, `switchAgent`, and META TTL mint a new `session.id` without touching
 * the old JSONL — orphans accumulate with prompts/tool I/O.
 *
 * Strategy (milestone C subset):
 *   1. Rename retired JSONL into `~/.agim/agim-session-quarantine/` (OUTSIDE
 *      sessionsRoot so JsonlSessionRepo.list() never resurrects them).
 *   2. Wait for adapter sessionLocks to drain before moving (busy → deferred).
 *   3. Invalidate sessionMeta cache so a stale path cannot be reopened.
 *   4. Periodically sweep quarantine files older than the grace window.
 *   5. Boot inventory: quarantine JSONL ids with no matching Agim session meta.
 *
 * Env:
 *   AGIM_AGENT_SESSION_QUARANTINE=off|on|inventory  (default on)
 *   AGIM_AGENT_SESSION_QUARANTINE_DAYS              (default 7)
 *   AGIM_AGENT_SESSION_RETENTION_SWEEP_MS           (default 6h; 0 disables)
 *   AGIM_AGENT_SESSION_RETIRE_WAIT_MS               (default 30s busy wait)
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { migratePiSessionsDir } from './naming-migrate.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'agim-agent-session-lifecycle' })

export type RetireReason = 'new' | 'switch' | 'meta_ttl' | 'orphan' | 'manual'
export type RetireResult = 'quarantined' | 'deferred' | 'skipped' | 'missing' | 'disabled'

export interface AgimAgentSessionHooks {
  isBusy?: (sessionId: string) => boolean
  invalidateCache?: (sessionId: string) => void
}

export interface LifecycleConfig {
  sessionsRoot: string
  quarantineRoot: string
  mode: 'off' | 'on' | 'inventory'
  quarantineDays: number
  sweepIntervalMs: number
  retireWaitMs: number
  retirePollMs: number
}

let hooks: AgimAgentSessionHooks = {}
let configOverride: Partial<LifecycleConfig> | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null
const deferred = new Map<string, RetireReason>()
const inFlight = new Set<string>()

function envMode(): 'off' | 'on' | 'inventory' {
  const raw = (process.env.AGIM_AGENT_SESSION_QUARANTINE ?? 'on').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off'
  if (raw === 'inventory' || raw === 'dry-run' || raw === 'dryrun') return 'inventory'
  return 'on'
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw?.trim()) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function resolveAgimAgentSessionsRoot(home: string = AGIM_HOME): string {
  return configOverride?.sessionsRoot ?? migratePiSessionsDir(home)
}

export function resolveAgimAgentQuarantineRoot(home: string = AGIM_HOME): string {
  return configOverride?.quarantineRoot ?? join(home, 'agim-session-quarantine')
}

export function getAgimAgentSessionLifecycleConfig(): LifecycleConfig {
  return {
    sessionsRoot: resolveAgimAgentSessionsRoot(),
    quarantineRoot: resolveAgimAgentQuarantineRoot(),
    mode: configOverride?.mode ?? envMode(),
    quarantineDays: configOverride?.quarantineDays
      ?? envInt('AGIM_AGENT_SESSION_QUARANTINE_DAYS', 7),
    sweepIntervalMs: configOverride?.sweepIntervalMs
      ?? envInt('AGIM_AGENT_SESSION_RETENTION_SWEEP_MS', 6 * 60 * 60 * 1000),
    retireWaitMs: configOverride?.retireWaitMs
      ?? envInt('AGIM_AGENT_SESSION_RETIRE_WAIT_MS', 30_000),
    retirePollMs: configOverride?.retirePollMs ?? 200,
  }
}

/** Test / factory wiring. Pass `null` fields via override object only. */
export function configureAgimAgentSessionLifecycle(opts: {
  sessionsRoot?: string
  quarantineRoot?: string
  mode?: LifecycleConfig['mode']
  quarantineDays?: number
  sweepIntervalMs?: number
  retireWaitMs?: number
  retirePollMs?: number
  hooks?: AgimAgentSessionHooks
}): void {
  configOverride = {
    ...(opts.sessionsRoot != null ? { sessionsRoot: opts.sessionsRoot } : {}),
    ...(opts.quarantineRoot != null ? { quarantineRoot: opts.quarantineRoot } : {}),
    ...(opts.mode != null ? { mode: opts.mode } : {}),
    ...(opts.quarantineDays != null ? { quarantineDays: opts.quarantineDays } : {}),
    ...(opts.sweepIntervalMs != null ? { sweepIntervalMs: opts.sweepIntervalMs } : {}),
    ...(opts.retireWaitMs != null ? { retireWaitMs: opts.retireWaitMs } : {}),
    ...(opts.retirePollMs != null ? { retirePollMs: opts.retirePollMs } : {}),
  }
  if (opts.hooks) hooks = { ...hooks, ...opts.hooks }
}

/** Reset module state (unit tests). */
export function resetAgimAgentSessionLifecycleForTests(): void {
  stopAgimAgentSessionRetention()
  hooks = {}
  configOverride = null
  deferred.clear()
  inFlight.clear()
}

function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode })
  if (process.platform !== 'win32') {
    try { chmodSync(path, mode) } catch { /* non-POSIX / already tight */ }
  }
}

function pathHash(p: string): string {
  return createHash('sha256').update(p).digest('hex').slice(0, 12)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Find active JSONL paths whose filename encodes `_${sessionId}.jsonl`. */
export function findActiveAgimAgentSessionFiles(
  sessionsRoot: string,
  sessionId: string,
): string[] {
  if (!sessionId || !existsSync(sessionsRoot)) return []
  const suffix = `_${sessionId}.jsonl`
  const found: string[] = []
  let entries: string[] = []
  try { entries = readdirSync(sessionsRoot) } catch { return [] }
  for (const name of entries) {
    // Quarantine lives outside this root; still skip underscore dirs defensively.
    if (name.startsWith('_') || name.startsWith('.')) continue
    const dir = join(sessionsRoot, name)
    let st: Stats
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    let files: string[] = []
    try { files = readdirSync(dir) } catch { continue }
    for (const file of files) {
      if (file.endsWith(suffix)) found.push(join(dir, file))
    }
  }
  return found
}

/** Collect session ids still referenced by Agim meta files on disk. */
export function listKnownAgimSessionIdsFromDisk(home: string = AGIM_HOME): Set<string> {
  const ids = new Set<string>()
  const dir = join(home, 'sessions')
  if (!existsSync(dir)) return ids
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return ids }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = readFileSync(join(dir, name), 'utf-8')
      const parsed = JSON.parse(raw) as { id?: unknown }
      if (typeof parsed.id === 'string' && parsed.id) ids.add(parsed.id)
    } catch { /* corrupt / race — skip */ }
  }
  return ids
}

/** List every active JSONL session id under sessionsRoot (one-level walk). */
export function listActiveAgimAgentSessionIds(sessionsRoot: string): Map<string, string[]> {
  const byId = new Map<string, string[]>()
  if (!existsSync(sessionsRoot)) return byId
  let entries: string[] = []
  try { entries = readdirSync(sessionsRoot) } catch { return byId }
  for (const name of entries) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const dir = join(sessionsRoot, name)
    let st: Stats
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    let files: string[] = []
    try { files = readdirSync(dir) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      // filename: <iso>_<sessionId>.jsonl — sessionId may contain underscores.
      const under = file.slice(0, -'.jsonl'.length)
      const idx = under.indexOf('_')
      if (idx < 0) continue
      const id = under.slice(idx + 1)
      if (!id) continue
      const path = join(dir, file)
      const list = byId.get(id) ?? []
      list.push(path)
      byId.set(id, list)
    }
  }
  return byId
}

async function waitUntilIdle(sessionId: string, waitMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs
  while (hooks.isBusy?.(sessionId)) {
    if (Date.now() >= deadline) return false
    await sleep(pollMs)
  }
  return true
}

function quarantineOneFile(src: string, quarantineRoot: string, sessionId: string): string {
  ensureDir(quarantineRoot, 0o700)
  const base = basename(src)
  // Keep original basename when possible; collide → append short path hash.
  let dest = join(quarantineRoot, base)
  if (existsSync(dest)) {
    dest = join(quarantineRoot, `${base.replace(/\.jsonl$/i, '')}.${pathHash(src)}.jsonl`)
  }
  renameSync(src, dest)
  if (process.platform !== 'win32') {
    try { chmodSync(dest, 0o400) } catch {
      try { chmodSync(dest, 0o600) } catch { /* ignore */ }
    }
  }
  // Best-effort: remove empty parent cwd-encoded dir.
  try {
    const parent = dirname(src)
    if (readdirSync(parent).length === 0) rmdirSync(parent)
  } catch { /* ignore */ }
  void sessionId
  return dest
}

/**
 * Retire one Agim Agent JSONL session into quarantine.
 * Safe to call fire-and-forget from `/new` / switch / META TTL.
 */
export async function retireAgimAgentSession(
  sessionId: string,
  reason: RetireReason,
  opts?: { waitForIdle?: boolean },
): Promise<RetireResult> {
  if (!sessionId) return 'skipped'
  const cfg = getAgimAgentSessionLifecycleConfig()
  if (cfg.mode === 'off') return 'disabled'

  if (inFlight.has(sessionId)) {
    deferred.set(sessionId, reason)
    return 'deferred'
  }
  inFlight.add(sessionId)
  try {
    const wait = opts?.waitForIdle !== false
    if (wait) {
      const idle = await waitUntilIdle(sessionId, cfg.retireWaitMs, cfg.retirePollMs)
      if (!idle) {
        deferred.set(sessionId, reason)
        log.info({
          event: 'agim_agent_session.retire_deferred',
          sessionId,
          reason,
        }, 'session still busy; deferred quarantine')
        return 'deferred'
      }
    } else if (hooks.isBusy?.(sessionId)) {
      deferred.set(sessionId, reason)
      return 'deferred'
    }

    const files = findActiveAgimAgentSessionFiles(cfg.sessionsRoot, sessionId)
    hooks.invalidateCache?.(sessionId)

    if (files.length === 0) {
      deferred.delete(sessionId)
      return 'missing'
    }

    if (cfg.mode === 'inventory') {
      log.info({
        event: 'agim_agent_session.inventory_hit',
        sessionId,
        reason,
        files: files.length,
        pathHashes: files.map(pathHash),
      }, 'dry-run: would quarantine Agim Agent JSONL')
      deferred.delete(sessionId)
      return 'skipped'
    }

    const moved: string[] = []
    for (const src of files) {
      try {
        moved.push(quarantineOneFile(src, cfg.quarantineRoot, sessionId))
      } catch (err) {
        log.warn({
          event: 'agim_agent_session.quarantine_failed',
          sessionId,
          reason,
          pathHash: pathHash(src),
          err: String(err),
        }, 'failed to quarantine Agim Agent JSONL')
      }
    }
    hooks.invalidateCache?.(sessionId)
    deferred.delete(sessionId)
    if (moved.length === 0) return 'missing'
    log.info({
      event: 'agim_agent_session.quarantined',
      sessionId,
      reason,
      files: moved.length,
      pathHashes: moved.map(pathHash),
    }, 'quarantined Agim Agent JSONL')
    return 'quarantined'
  } finally {
    inFlight.delete(sessionId)
  }
}

/** Fire-and-forget retire used by session manager /new and switch. */
export function scheduleRetireAgimAgentSession(
  sessionId: string | undefined,
  reason: RetireReason,
): void {
  if (!sessionId) return
  void retireAgimAgentSession(sessionId, reason).catch((err) => {
    log.warn({
      event: 'agim_agent_session.retire_error',
      sessionId,
      reason,
      err: String(err),
    }, 'retireAgimAgentSession failed')
  })
}

export async function sweepQuarantinedSessions(now: number = Date.now()): Promise<{ deleted: number }> {
  const cfg = getAgimAgentSessionLifecycleConfig()
  if (cfg.mode === 'off' || cfg.mode === 'inventory') return { deleted: 0 }
  if (cfg.quarantineDays <= 0) return { deleted: 0 }
  const root = cfg.quarantineRoot
  if (!existsSync(root)) return { deleted: 0 }
  const maxAgeMs = cfg.quarantineDays * 24 * 60 * 60 * 1000
  let deleted = 0
  let names: string[] = []
  try { names = readdirSync(root) } catch { return { deleted: 0 } }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(root, name)
    try {
      const st = statSync(path)
      if (now - st.mtimeMs < maxAgeMs) continue
      unlinkSync(path)
      deleted += 1
      log.info({
        event: 'agim_agent_session.quarantine_purged',
        pathHash: pathHash(path),
        ageMs: now - st.mtimeMs,
      }, 'purged expired quarantined Agim Agent JSONL')
    } catch (err) {
      log.warn({
        event: 'agim_agent_session.purge_failed',
        pathHash: pathHash(path),
        err: String(err),
      }, 'failed to purge quarantined JSONL')
    }
  }
  return { deleted }
}

export async function inventoryAndQuarantineOrphans(opts?: {
  dryRun?: boolean
  knownSessionIds?: Iterable<string>
  home?: string
}): Promise<{ active: number; orphan: number; quarantined: number }> {
  const cfg = getAgimAgentSessionLifecycleConfig()
  if (cfg.mode === 'off') return { active: 0, orphan: 0, quarantined: 0 }

  const known = new Set<string>(opts?.knownSessionIds ?? [])
  for (const id of listKnownAgimSessionIdsFromDisk(opts?.home ?? AGIM_HOME)) known.add(id)

  const active = listActiveAgimAgentSessionIds(cfg.sessionsRoot)
  let orphan = 0
  let quarantined = 0
  const dryRun = opts?.dryRun === true || cfg.mode === 'inventory'

  for (const [id] of active) {
    if (known.has(id)) continue
    if (hooks.isBusy?.(id)) continue
    orphan += 1
    if (dryRun) {
      log.info({
        event: 'agim_agent_session.orphan_inventory',
        sessionId: id,
        files: active.get(id)?.length ?? 0,
      }, 'orphan Agim Agent JSONL (dry-run)')
      continue
    }
    const result = await retireAgimAgentSession(id, 'orphan', { waitForIdle: false })
    if (result === 'quarantined') quarantined += 1
  }

  log.info({
    event: 'agim_agent_session.inventory_done',
    active: active.size,
    orphan,
    quarantined,
    dryRun,
  }, 'Agim Agent session inventory complete')

  return { active: active.size, orphan, quarantined }
}

async function flushDeferred(): Promise<void> {
  const pending = [...deferred.entries()]
  for (const [id, reason] of pending) {
    if (hooks.isBusy?.(id)) continue
    deferred.delete(id)
    await retireAgimAgentSession(id, reason)
  }
}

export function startAgimAgentSessionRetention(opts?: {
  runBootInventory?: boolean
  knownSessionIds?: Iterable<string>
}): void {
  const cfg = getAgimAgentSessionLifecycleConfig()
  if (cfg.mode === 'off') return

  ensureDir(cfg.sessionsRoot, 0o700)
  ensureDir(cfg.quarantineRoot, 0o700)

  if (opts?.runBootInventory !== false) {
    void inventoryAndQuarantineOrphans({
      knownSessionIds: opts?.knownSessionIds,
    }).catch((err) => {
      log.warn({
        event: 'agim_agent_session.boot_inventory_failed',
        err: String(err),
      }, 'boot orphan inventory failed')
    })
  }

  if (sweepTimer) return
  if (cfg.sweepIntervalMs <= 0) return

  sweepTimer = setInterval(() => {
    void (async () => {
      try {
        await flushDeferred()
        await sweepQuarantinedSessions()
      } catch (err) {
        log.warn({
          event: 'agim_agent_session.sweep_failed',
          err: String(err),
        }, 'retention sweep failed')
      }
    })()
  }, cfg.sweepIntervalMs)
  if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
    (sweepTimer as { unref: () => void }).unref()
  }
}

export function stopAgimAgentSessionRetention(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
