// Job Board — persistent async job queue backed by SQLite
//
// Jobs survive restarts. Each job executes an agent invocation and stores the result.
// Supports: create, list, get, cancel.
//
// Ownership (H5/M6/H7, code-review-2026-05-06):
//   - Each row carries `creator_id` (the IM userId that originated the job)
//     and `workspace_id`. Commands that the user runs through IM
//     (`/job list|check|cancel|run`) MUST pass the caller's userId via
//     opts.creatorId so users can't peek at or stomp on each others' jobs.
//     Internal callers (REST `/api/jobs`, ACP server, scheduler) pass no
//     filter and see every row — that's intentional, those entry-points
//     are guarded by the web / API token.
//   - Legacy rows (created before the migration) have creator_id = ''.
//     They're treated as "ownerless / system" and visible to every owner-
//     scoped query (so an upgrade doesn't appear to vanish the user's
//     prior history).
//   - pruneOldJobs() walks completed/failed/cancelled rows older than
//     `IM_HUB_JOB_RETENTION_DAYS` (default 30) and deletes them; runs every
//     6h via setInterval, mirroring audit-log.

import type Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { logger as rootLogger } from './logger.js'
import { eventBus } from './event-bus.js'
import { createSqliteHelper } from './sqlite-helper.js'

const BOARD_DB = join(homedir(), '.im-hub', 'jobs.db')

/** Hard cap on a single job's accumulated result. A misbehaving agent (or a
 * runaway tool that dumps a giant file) could otherwise keep filling the
 * Buffer in {@link runJob} until the host OOMs and rage-stuff the SQLite TEXT
 * column with the same payload. We cap at 1 MiB by default; chunks that would
 * push past the cap are dropped and a truncation footer is appended. Override
 * via env IMHUB_JOB_RESULT_MAX_BYTES. */
function resolveMaxResultBytes(): number {
  const raw = process.env.IMHUB_JOB_RESULT_MAX_BYTES
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 1 * 1024 * 1024
}

/** Hard cap on concurrent runJob() invocations. Spawning more than this
 * would let a few /job run X requests OOM the host (each agent process
 * carries hundreds of MB). Override via env IM_HUB_MAX_CONCURRENT_JOBS. */
function resolveMaxConcurrent(): number {
  const raw = process.env.IM_HUB_MAX_CONCURRENT_JOBS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 3
}

// Running job controllers (for cancellation)
const runningControllers = new Map<number, AbortController>()

// Wait queue for jobs that arrived while at capacity. Each entry is the
// resolver of a Promise the caller is awaiting on.
const waitQueue: Array<() => void> = []
let activeJobs = 0

/**
 * Reset jobs that were 'running' when the previous im-hub process died.
 * Without this, those rows stay marked 'running' forever and every
 * /job list shows ghosts.
 */
function reapStaleRunning(d: Database.Database): void {
  try {
    const stmt = d.prepare(
      "UPDATE jobs SET status='failed', error='im-hub restarted while running', completed_at=datetime('now') WHERE status='running'"
    )
    const info = stmt.run()
    if (info.changes > 0) {
      rootLogger.warn({ event: 'job-board.reap', stale: info.changes },
        `Marked ${info.changes} stale running job(s) as failed`)
    }
  } catch {
    // best-effort; missing table is fine on first start
  }
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: number
  status: JobStatus
  agent: string
  prompt: string
  result: string | null
  error: string | null
  created_at: string
  completed_at: string | null
  /** IM userId of the originating caller, or '' for legacy / system rows. */
  creator_id: string
  /** Workspace this job was created under, or '' if unknown. */
  workspace_id: string
}

type JobRunner = (job: Job, logger: Logger, signal: AbortSignal) => AsyncGenerator<string>

/**
 * Idempotent column-add for ownership tracking. Run on every helper init —
 * SQLite's ALTER TABLE ADD COLUMN throws "duplicate column name" if the
 * column already exists, which we silently swallow. Cheaper than the full
 * pragma table_info() inspection round-trip.
 */
function migrateOwnership(d: Database.Database): void {
  for (const col of ['creator_id', 'workspace_id'] as const) {
    try {
      d.prepare(`ALTER TABLE jobs ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`).run()
      rootLogger.info({ component: 'job-board', column: col, event: 'job-board.migration' },
        `Added ${col} column to jobs table`)
    } catch {
      // duplicate column — already migrated
    }
  }
}

/** Default number of days a completed/failed/cancelled job is retained. */
function resolveRetentionDays(): number {
  const raw = process.env.IM_HUB_JOB_RETENTION_DAYS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 30
}

/** How often pruneOldJobs() is fired by the auto-sweep timer. 0 disables. */
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

let retentionSweepTimer: ReturnType<typeof setInterval> | null = null

const helper = createSqliteHelper({
  file: BOARD_DB,
  component: 'job-board',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent         TEXT    NOT NULL,
      prompt        TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      result        TEXT,
      error         TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      creator_id    TEXT    NOT NULL DEFAULT '',
      workspace_id  TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_creator ON jobs(creator_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
  `,
  init: (d) => {
    migrateOwnership(d)
    // First-time / cold-start cleanup: any 'running' rows are leftover from a
    // prior process that didn't get to finalize.
    reapStaleRunning(d)
    // Initial retention sweep + periodic timer. Mirrors audit-log shape so
    // both tables stay bounded without operator intervention.
    pruneOldJobs(d)
    if (RETENTION_SWEEP_INTERVAL_MS > 0 && retentionSweepTimer === null) {
      retentionSweepTimer = setInterval(() => {
        const live = helper.get()
        if (live) pruneOldJobs(live)
      }, RETENTION_SWEEP_INTERVAL_MS)
      if (typeof retentionSweepTimer === 'object' && retentionSweepTimer && 'unref' in retentionSweepTimer) {
        (retentionSweepTimer as { unref: () => void }).unref()
      }
    }
  },
})

/** Stop the retention sweep (used by tests + graceful shutdown). */
export function stopJobRetentionSweep(): void {
  if (retentionSweepTimer) {
    clearInterval(retentionSweepTimer)
    retentionSweepTimer = null
  }
}

/** Close the underlying SQLite handle. Called by cli.ts on graceful
 *  shutdown so the WAL is checkpointed before exit (L2). */
export function closeJobBoardDb(): void {
  helper.close()
}

function getDb(): Database.Database | null {
  return helper.get()
}

/**
 * Filter / scoping options accepted by every owner-sensitive job-board API.
 *
 * - When `creatorId` is set, the query is scoped to rows whose `creator_id`
 *   matches the caller OR whose `creator_id` is '' (legacy / ownerless).
 *   This preserves visibility of pre-migration jobs while preventing one
 *   user from poking at another's freshly-created ones.
 * - When `creatorId` is unset (undefined), no ownership filter is applied
 *   — used by REST / ACP / scheduler entry-points that are guarded by the
 *   web token, not by per-user identity.
 */
export interface OwnerOpts {
  creatorId?: string
  /** Optional agent-name filter. When set, only rows whose `agent` column
   *  matches are returned. Used by the dashboard to give per-agent views
   *  (claude-code / opencode / codex tabs); IM commands generally don't
   *  pass it (they want the user's full job history). */
  agent?: string
}

export interface CreateJobOpts {
  creatorId?: string
  workspaceId?: string
}

export function createJob(agent: string, prompt: string, opts: CreateJobOpts = {}): number {
  const d = getDb()
  if (!d) throw new Error('Job board unavailable (SQLite not initialized)')
  const row = d.prepare(
    'INSERT INTO jobs (agent, prompt, status, creator_id, workspace_id) VALUES (?, ?, ?, ?, ?)'
  ).run(agent, prompt, 'pending', opts.creatorId || '', opts.workspaceId || '')
  const id = Number(row.lastInsertRowid)
  eventBus.publish({ type: 'job', phase: 'created', jobId: id, agent })
  return id
}

export function getJob(id: number, opts: OwnerOpts = {}): Job | null {
  const d = getDb()
  if (!d) return null
  const row = (opts.creatorId !== undefined
    ? d.prepare("SELECT * FROM jobs WHERE id = ? AND (creator_id = ? OR creator_id = '')")
        .get(id, opts.creatorId)
    : d.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) as Job | undefined
  return row || null
}

export function listJobs(limit = 20, status?: JobStatus, opts: OwnerOpts = {}): Job[] {
  const d = getDb()
  if (!d) return []
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 1000) : 20
  const conditions: string[] = []
  const params: unknown[] = []
  if (status) { conditions.push('status = ?'); params.push(status) }
  if (opts.creatorId !== undefined) {
    conditions.push("(creator_id = ? OR creator_id = '')")
    params.push(opts.creatorId)
  }
  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return d.prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, safeLimit) as Job[]
}

function updateJob(id: number, fields: Partial<Job>): void {
  const d = getDb()
  if (!d) return
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v) }
  }
  if (!sets.length) return
  d.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

/**
 * Acquire a job slot. Returns immediately when capacity available, otherwise
 * queues the caller and returns a promise that resolves when a slot frees.
 */
async function acquireSlot(): Promise<void> {
  const max = resolveMaxConcurrent()
  if (activeJobs < max) {
    activeJobs++
    return
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve))
  activeJobs++
}

function releaseSlot(): void {
  activeJobs = Math.max(0, activeJobs - 1)
  const next = waitQueue.shift()
  if (next) next()
}

export async function runJob(
  id: number,
  runner: JobRunner,
  logger: Logger
): Promise<void> {
  const job = getJob(id)
  if (!job) return

  // Block here if the job board is at capacity. The job stays 'pending' in
  // SQLite while waiting — visible to /job list as queued.
  await acquireSlot()

  const controller = new AbortController()
  runningControllers.set(id, controller)

  updateJob(id, { status: 'running' })
  eventBus.publish({ type: 'job', phase: 'started', jobId: id, agent: job.agent })
  logger.info({ event: 'job.start', jobId: id, agent: job.agent, active: activeJobs })

  let fullText = ''
  let bytes = 0
  let droppedBytes = 0
  let truncated = false
  const cap = resolveMaxResultBytes()
  try {
    for await (const chunk of runner(job, logger, controller.signal)) {
      if (controller.signal.aborted) break
      const chunkBytes = Buffer.byteLength(chunk, 'utf-8')
      if (truncated) { droppedBytes += chunkBytes; continue }
      if (bytes + chunkBytes > cap) {
        // Drop the entire over-cap chunk to keep the boundary on a UTF-8 /
        // line boundary the producer chose; partial slicing risks splitting
        // a multibyte char or a JSON object mid-event.
        truncated = true
        droppedBytes += chunkBytes
        continue
      }
      fullText += chunk
      bytes += chunkBytes
    }
    if (truncated) {
      const note = `\n\n[im-hub: result truncated — ${droppedBytes} bytes dropped after ${cap}-byte cap; raise IMHUB_JOB_RESULT_MAX_BYTES if needed]`
      fullText += note
      logger.warn({ event: 'job.result.truncated', jobId: id, droppedBytes, cap })
    }
    // Only update if not cancelled
    if (!controller.signal.aborted) {
      updateJob(id, { status: 'completed', result: fullText, completed_at: new Date().toISOString() })
      eventBus.publish({ type: 'job', phase: 'completed', jobId: id, agent: job.agent })
      logger.info({ event: 'job.complete', jobId: id, resultLen: fullText.length, truncated })
    } else {
      updateJob(id, { status: 'cancelled', result: fullText || null, completed_at: new Date().toISOString() })
      eventBus.publish({ type: 'job', phase: 'cancelled', jobId: id, agent: job.agent })
      logger.info({ event: 'job.cancelled', jobId: id })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    updateJob(id, { status: 'failed', error: msg, completed_at: new Date().toISOString() })
    eventBus.publish({ type: 'job', phase: 'failed', jobId: id, agent: job.agent })
    logger.error({ event: 'job.failed', jobId: id, error: msg, stack })
  } finally {
    runningControllers.delete(id)
    releaseSlot()
  }
}

/** Test/diagnostic accessor: how many runJob invocations are currently in flight. */
export function _activeJobCount(): number { return activeJobs }
/** Test/diagnostic accessor: the wait queue depth. */
export function _waitQueueDepth(): number { return waitQueue.length }
/** Test-only: directly exercise the concurrency gate without SQLite. */
export const _testSlot = { acquire: acquireSlot, release: releaseSlot }

export function cancelJob(id: number, opts: OwnerOpts = {}): boolean {
  const job = getJob(id, opts)
  if (!job || (job.status !== 'pending' && job.status !== 'running')) return false
  const ctrl = runningControllers.get(id)
  if (ctrl) {
    ctrl.abort()
    runningControllers.delete(id)
  }
  updateJob(id, { status: 'cancelled', completed_at: new Date().toISOString() })
  eventBus.publish({ type: 'job', phase: 'cancelled', jobId: id, agent: job.agent })
  return true
}

/**
 * Delete jobs that finished (completed / failed / cancelled) more than
 * `daysRetention` days ago. 'pending' / 'running' rows are never pruned —
 * a stalled-but-resumable job is the operator's call. Returns the row
 * count so callers / tests can assert.
 */
export function pruneOldJobs(d: Database.Database = getDb()!, daysRetention: number = resolveRetentionDays()): number {
  if (!d) return 0
  try {
    const info = d.prepare(`
      DELETE FROM jobs
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at IS NOT NULL
        AND completed_at < datetime('now', ?)
    `).run(`-${daysRetention} days`)
    if (info.changes > 0) {
      rootLogger.info({
        component: 'job-board', event: 'job-board.pruned',
        deleted: info.changes, days: daysRetention,
      }, `Pruned ${info.changes} job row(s) older than ${daysRetention}d`)
    }
    return info.changes
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    rootLogger.warn({ component: 'job-board', event: 'job-board.prune.failed', error: msg },
      'job-board retention sweep failed')
    return 0
  }
}

export function getJobStats(): { total: number; pending: number; running: number; completed: number; failed: number } {
  const empty = { total: 0, pending: 0, running: 0, completed: 0, failed: 0 }
  const d = getDb()
  if (!d) return empty
  try {
    const row = d.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
      FROM jobs
    `).get() as Record<string, number>
    return {
      total: row.total || 0, pending: row.pending || 0, running: row.running || 0,
      completed: row.completed || 0, failed: row.failed || 0,
    }
  } catch {
    return empty
  }
}
