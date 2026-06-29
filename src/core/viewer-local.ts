// Viewer-local — local SQLite store for long IM-message payloads that get
// rendered as web pages via /v/:id on the agim web console.
//
// Why local: privacy — content stays on the operator's machine, full stop.
// IM messages carry only a short link to the operator's own publicly-reachable
// agim web (cloudflared / caddy / tailscale at operator's discretion). The
// link resolves to a row in this SQLite, rendered by the web console.
//
// Permanence: rows have NO TTL. They are kept until the operator hits the
// per-instance cap (`AGIM_VIEWER_MAX_PASTES`, default 10_000), at which point
// the oldest rows are pruned LRU. Rationale: this is the operator's own data,
// equivalent to their memos / job history — they should keep it unless they
// explicitly delete.

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { AGIM_HOME } from './agim-paths.js'

const VIEWER_DB = join(AGIM_HOME, 'viewer.db')

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pastes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'markdown',
    title TEXT,
    source TEXT,
    job_id INTEGER,
    created_at INTEGER NOT NULL,
    view_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_pastes_created ON pastes(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pastes_job ON pastes(job_id);
`

const viewerLog = rootLogger.child({ component: 'viewer-local' })

/** Default 30-day TTL. 0 disables → permanent (back-compat for operators who
 *  treat pastes as long-term archive). LRU cap (AGIM_VIEWER_MAX_PASTES) still
 *  applies on top of this. */
function resolvePasteRetentionDays(): number {
  const raw = process.env.AGIM_PASTE_RETENTION_DAYS
  if (raw === undefined) return 30
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 30
  return n
}

const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6 hours
let sweepTimer: ReturnType<typeof setInterval> | null = null

const helper = createSqliteHelper({
  file: VIEWER_DB,
  schema: SCHEMA,
  logger: viewerLog,
  component: 'viewer-local',
  init: (d) => {
    try { pruneExpiredPastesInternal(d) } catch (err) {
      viewerLog.warn({ event: 'viewer.prune_init_failed', err: String(err) })
    }
    if (RETENTION_SWEEP_INTERVAL_MS > 0 && sweepTimer === null) {
      sweepTimer = setInterval(() => {
        const live = helper.get()
        if (!live) return
        try { pruneExpiredPastesInternal(live) } catch { /* logged inside */ }
      }, RETENTION_SWEEP_INTERVAL_MS)
      if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
        (sweepTimer as { unref: () => void }).unref()
      }
    }
  },
})

export type PasteContentType = 'markdown' | 'plain'

export interface PasteRow {
  id: string
  content: string
  content_type: PasteContentType
  title: string | null
  source: string | null
  job_id: number | null
  created_at: number
  view_count: number
}

export interface SavePasteOpts {
  content: string
  content_type?: PasteContentType
  title?: string
  source?: string
  job_id?: number
}

const DEFAULT_MAX_PASTES = 10_000

function maxPastes(): number {
  const raw = process.env.AGIM_VIEWER_MAX_PASTES
  if (!raw) return DEFAULT_MAX_PASTES
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PASTES
}

/**
 * Save a paste. Returns the new row's id (uuidv4). Returns null if the
 * underlying DB is broken (caller should fall back to truncation).
 */
export function savePaste(opts: SavePasteOpts): string | null {
  const db = helper.get()
  if (!db) return null

  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const ct: PasteContentType = opts.content_type === 'plain' ? 'plain' : 'markdown'

  try {
    db.prepare(`
      INSERT INTO pastes (id, content, content_type, title, source, job_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      opts.content,
      ct,
      opts.title ?? null,
      opts.source ?? null,
      opts.job_id ?? null,
      now,
    )
  } catch (err) {
    viewerLog.warn({ event: 'viewer.save.failed', err: String(err) })
    return null
  }

  // LRU prune (cheap — only fires when over cap)
  try {
    const cap = maxPastes()
    const total = db.prepare('SELECT COUNT(*) AS n FROM pastes').get() as { n: number }
    if (total.n > cap) {
      const over = total.n - cap
      const r = db.prepare(`
        DELETE FROM pastes WHERE id IN (
          SELECT id FROM pastes ORDER BY created_at ASC LIMIT ?
        )
      `).run(over)
      if (r.changes > 0) {
        viewerLog.info({ event: 'viewer.prune.lru', removed: r.changes, cap })
      }
    }
  } catch (err) {
    viewerLog.warn({ event: 'viewer.prune.failed', err: String(err) })
  }

  return id
}

export function getPaste(id: string): PasteRow | null {
  const db = helper.get()
  if (!db) return null
  const row = db.prepare(`
    SELECT id, content, content_type, title, source, job_id, created_at, view_count
    FROM pastes WHERE id = ?
  `).get(id) as PasteRow | undefined
  return row ?? null
}

export function bumpViewCount(id: string): void {
  const db = helper.get()
  if (!db) return
  try {
    db.prepare('UPDATE pastes SET view_count = view_count + 1 WHERE id = ?').run(id)
  } catch (err) {
    viewerLog.warn({ event: 'viewer.bump.failed', err: String(err) })
  }
}

export interface ListOpts {
  limit?: number
  offset?: number
}

export function listPastes(opts: ListOpts = {}): PasteRow[] {
  const db = helper.get()
  if (!db) return []
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  return db.prepare(`
    SELECT id, content, content_type, title, source, job_id, created_at, view_count
    FROM pastes ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as PasteRow[]
}

export function deletePaste(id: string): boolean {
  const db = helper.get()
  if (!db) return false
  const r = db.prepare('DELETE FROM pastes WHERE id = ?').run(id)
  return r.changes > 0
}

export function countPastes(): number {
  const db = helper.get()
  if (!db) return 0
  const row = db.prepare('SELECT COUNT(*) AS n FROM pastes').get() as { n: number }
  return row.n
}

// ─── Retention sweep (R12 ②) ────────────────────────────────────────
//
// Time-based TTL on `created_at`. This runs *in addition to* the LRU
// capacity cap inside savePaste — so an operator who hits 10K pastes in
// a week still gets the LRU evict, and an operator with 100 pastes that
// have aged past 30 days gets the TTL evict.

function pruneExpiredPastesInternal(db: import('better-sqlite3').Database): number {
  const days = resolvePasteRetentionDays()
  if (days <= 0) return 0
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400
  const r = db.prepare('DELETE FROM pastes WHERE created_at < ?').run(cutoff)
  if (r.changes > 0) {
    viewerLog.info({ event: 'viewer.pruned', deleted: r.changes, days }, `Pruned ${r.changes} paste(s) older than ${days}d`)
  }
  return r.changes
}

/** Public retention API — used by tests + manual /api/viewer/prune. */
export function pruneExpiredPastes(): number {
  const db = helper.get()
  if (!db) return 0
  try { return pruneExpiredPastesInternal(db) } catch (err) {
    viewerLog.warn({ event: 'viewer.prune_failed', err: String(err) })
    return 0
  }
}

/** Stop the periodic retention sweep (tests + graceful shutdown). */
export function stopViewerRetentionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

export function closeViewerDb(): void {
  stopViewerRetentionSweep()
  helper.close()
}
