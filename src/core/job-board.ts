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
import { join } from 'node:path'
import type { Logger } from 'pino'
import { logger as rootLogger } from './logger.js'
import { eventBus } from './event-bus.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { AGIM_HOME } from './agim-paths.js'

const BOARD_DB = join(AGIM_HOME, 'jobs.db')

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
 * Reset jobs that were 'running' when the previous agim process died.
 * Without this, those rows stay marked 'running' forever and every
 * /job list shows ghosts.
 */
function reapStaleRunning(d: Database.Database): void {
  try {
    const stmt = d.prepare(
      "UPDATE jobs SET status='failed', error='agim restarted while running', completed_at=datetime('now') WHERE status='running'"
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

export type JobKind = 'job' | 'inline'

/** Lifecycle states.
 *  - pending     : created, not yet picked up
 *  - running     : agent currently executing
 *  - completed   : agent finished, result captured; for inline kind the
 *                  reply still has to go through the outbox before terminal
 *                  'delivered' (or 'failed' if the outbox gives up).
 *  - delivered   : (inline only) reply confirmed sent via outbox.
 *  - failed      : agent threw OR outbox gave up
 *  - cancelled   : user-initiated cancel
 *  - interrupted : (Phase 3) running row was killed by agim shutdown — the
 *                  startup scan offers the user a retry.
 *  - replaced    : (Phase 3) interrupted row whose user picked "retry"; the
 *                  new row's id lands in `replaced_by`.
 *  - abandoned   : (Phase 3) interrupted row past the 10-minute window — no
 *                  notification fired, archived for audit.
 */
export type JobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'replaced'
  | 'abandoned'

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
  /** `${platform}:${channelId}:${threadId}` — empty for legacy / system rows. */
  thread_key: string
  /** 'job' = explicit /job (30d retention), 'inline' = auto-tracked inbound
   *  message (24h retention + Phase 3 lifecycle hooks). */
  kind: JobKind
  /** ISO when status first transitioned to 'running'. Null for never-run rows. */
  started_at: string | null
  /** ISO when the outbox confirmed delivery to IM. Inline kind only. */
  delivered_at: string | null
  /** Id of the new job that replaced this one (Phase 3 retry flow). */
  replaced_by: number | null
  /** Last outbox row id that tried to deliver this job's result. Reverse
   *  link to `outbox.job_id`. */
  last_outbox_id: number | null
}

type JobRunner = (job: Job, logger: Logger, signal: AbortSignal) => AsyncGenerator<string>

/**
 * Idempotent column-adds. Run on every helper init — SQLite's ALTER TABLE
 * ADD COLUMN throws "duplicate column name" if the column already exists,
 * which we silently swallow. Cheaper than the full pragma table_info()
 * inspection round-trip.
 *
 * Columns added over time:
 *   - creator_id / workspace_id  : ownership (v1.0.x)
 *   - thread_key                 : `${platform}:${channelId}:${threadId}` — needed
 *                                   so Phase 3 can recover an interrupted inline
 *                                   job back to the right IM thread.
 *   - kind                       : 'job' (explicit /job, retention 30d) vs
 *                                   'inline' (auto-tracked inbound, retention 24h).
 *   - started_at / delivered_at  : finer-grained lifecycle stamps.
 *   - replaced_by                : when user retries an interrupted job, the
 *                                   old row points at the new one.
 *   - last_outbox_id             : link to the outbox row that delivered (or is
 *                                   trying to deliver) this job's result.
 */
function migrateColumns(d: Database.Database): void {
  // [column, type] — type must include any NOT NULL / DEFAULT clauses.
  const adds: Array<[string, string]> = [
    ['creator_id',     `TEXT    NOT NULL DEFAULT ''`],
    ['workspace_id',   `TEXT    NOT NULL DEFAULT ''`],
    ['thread_key',     `TEXT    NOT NULL DEFAULT ''`],
    ['kind',           `TEXT    NOT NULL DEFAULT 'job'`],
    ['started_at',     `TEXT`],
    ['delivered_at',   `TEXT`],
    ['replaced_by',    `INTEGER`],
    ['last_outbox_id', `INTEGER`],
  ]
  for (const [col, type] of adds) {
    try {
      d.prepare(`ALTER TABLE jobs ADD COLUMN ${col} ${type}`).run()
      rootLogger.info({ component: 'job-board', column: col, event: 'job-board.migration' },
        `Added ${col} column to jobs table`)
    } catch {
      // duplicate column — already migrated
    }
  }
  // Phase 2 indexes — needed for retention split (kind) and Phase 3 recovery
  // sweep (kind + status + thread_key). IF NOT EXISTS is idempotent.
  try {
    d.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON jobs(kind, status)`).run()
    d.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_thread_key  ON jobs(thread_key)`).run()
    d.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_last_outbox ON jobs(last_outbox_id) WHERE last_outbox_id IS NOT NULL`).run()
  } catch {
    // shouldn't fail but never let an index error block startup
  }
}

/** Default retention (days) for terminal explicit /job rows. */
function resolveRetentionDays(): number {
  const raw = process.env.IM_HUB_JOB_RETENTION_DAYS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 30
}

/** Retention (hours) for terminal inline jobs. Inline rows are auto-tracked
 *  from every inbound IM message — they accrue 100s of rows/day even on a
 *  quiet thread, so the default is much shorter than the explicit /job 30-day
 *  retention. Phase 3's recovery sweep needs at least the user's "回 1 重发"
 *  window, so don't drop below ~6h in production. */
function resolveInlineRetentionHours(): number {
  const raw = process.env.IMHUB_INLINE_JOB_RETENTION_HOURS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 24
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
    migrateColumns(d)
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

/** Phase 3 — shutdown step. Mark every running inline job as 'interrupted'
 *  so the next startup can offer the user a retry. Returns the row count for
 *  logging. Safe to call on a degraded DB (returns 0). */
export function markRunningInlineJobsInterrupted(reason: string = 'agim shutdown'): number {
  const d = getDb()
  if (!d) return 0
  try {
    const info = d.prepare(
      `UPDATE jobs
          SET status = 'interrupted',
              completed_at = datetime('now'),
              error = ?
        WHERE kind = 'inline'
          AND status IN ('pending', 'running')`,
    ).run(reason.slice(0, 1024))
    if (info.changes > 0) {
      rootLogger.info(
        { component: 'job-board', event: 'job-board.interrupted', count: info.changes, reason },
        `Marked ${info.changes} inline job(s) as interrupted (${reason})`,
      )
    }
    return info.changes
  } catch (err) {
    rootLogger.warn(
      { component: 'job-board', event: 'job-board.interrupt_failed', err: err instanceof Error ? err.message : String(err) },
      'markRunningInlineJobsInterrupted failed',
    )
    return 0
  }
}

/** Phase 3 — startup scan. Return interrupted inline jobs that finished
 *  within the recovery window (default 10 min via IMHUB_RECOVERY_WINDOW_MS).
 *  Caller iterates the result, sends a per-thread "retry / cancel" prompt,
 *  and tracks the user's reply via the in-memory pending-retry map.
 *
 *  Older interrupted rows are NOT returned — they get swept to 'abandoned'
 *  by sweepAbandonedInterrupted() so they don't pile up in the table. */
export function findRecoverableInterrupted(windowMs?: number): Job[] {
  const d = getDb()
  if (!d) return []
  const ms = windowMs ?? resolveRecoveryWindowMs()
  const seconds = Math.max(1, Math.floor(ms / 1000))
  try {
    return d.prepare(
      `SELECT * FROM jobs
        WHERE kind = 'inline'
          AND status = 'interrupted'
          AND completed_at >= datetime('now', '-' || ? || ' seconds')
          AND thread_key <> ''
        ORDER BY completed_at ASC`,
    ).all(seconds) as Job[]
  } catch (err) {
    rootLogger.warn(
      { component: 'job-board', event: 'job-board.recover_query_failed', err: err instanceof Error ? err.message : String(err) },
      'findRecoverableInterrupted failed',
    )
    return []
  }
}

/** Phase 3 — startup sweep. Any 'interrupted' inline row past the recovery
 *  window transitions to 'abandoned' (preserved for audit but never
 *  notified). Returns the row count. */
export function sweepAbandonedInterrupted(windowMs?: number): number {
  const d = getDb()
  if (!d) return 0
  const ms = windowMs ?? resolveRecoveryWindowMs()
  const seconds = Math.max(1, Math.floor(ms / 1000))
  try {
    const info = d.prepare(
      `UPDATE jobs
          SET status = 'abandoned'
        WHERE kind = 'inline'
          AND status = 'interrupted'
          AND completed_at < datetime('now', '-' || ? || ' seconds')`,
    ).run(seconds)
    if (info.changes > 0) {
      rootLogger.info(
        { component: 'job-board', event: 'job-board.abandoned', count: info.changes },
        `Swept ${info.changes} stale interrupted inline job(s) to 'abandoned'`,
      )
    }
    return info.changes
  } catch (err) {
    rootLogger.warn(
      { component: 'job-board', event: 'job-board.abandon_failed', err: err instanceof Error ? err.message : String(err) },
      'sweepAbandonedInterrupted failed',
    )
    return 0
  }
}

/** Phase 3 — link an old interrupted row to its replacement once the user
 *  picks "1 重发". The new row's id lands in `replaced_by`; the old row
 *  transitions interrupted → replaced so it stops showing up in any future
 *  recovery scan. */
export function markJobReplacedBy(oldId: number, newId: number): void {
  if (oldId <= 0 || newId <= 0) return
  const d = getDb()
  if (!d) return
  try {
    d.prepare(
      `UPDATE jobs
          SET status = 'replaced',
              replaced_by = ?
        WHERE id = ? AND status = 'interrupted'`,
    ).run(newId, oldId)
  } catch (err) {
    rootLogger.debug({ component: 'job-board', event: 'markJobReplacedBy_failed', oldId, newId, err: String(err) })
  }
}

/** Phase 3 — user picked "2 取消" on the retry prompt. Interrupted → cancelled. */
export function markInterruptedCancelled(id: number): void {
  if (id <= 0) return
  const d = getDb()
  if (!d) return
  try {
    d.prepare(
      `UPDATE jobs
          SET status = 'cancelled'
        WHERE id = ? AND status = 'interrupted'`,
    ).run(id)
  } catch (err) {
    rootLogger.debug({ component: 'job-board', event: 'markInterruptedCancelled_failed', id, err: String(err) })
  }
}

/** Recovery window in milliseconds. Default 10 minutes. Env override
 *  IMHUB_RECOVERY_WINDOW_MS. */
function resolveRecoveryWindowMs(): number {
  const raw = process.env.IMHUB_RECOVERY_WINDOW_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 10 * 60 * 1000
}

/** Exported for the recovery module so it can use the same window for the
 *  user-facing "10 min 内有效" copy. */
export function getRecoveryWindowMs(): number {
  return resolveRecoveryWindowMs()
}

/** Test hook: artificially age a row's completed_at (or created_at) by a
 *  SQLite modifier like '-2 hours' or '-40 days'. Production code must NOT
 *  call this; it's the only practical way to exercise retention without
 *  sleeping in tests. */
export function _backdateForTests(id: number, modifier: string): void {
  const d = getDb()
  if (!d) return
  try {
    d.prepare(
      `UPDATE jobs
          SET completed_at = datetime(COALESCE(completed_at, datetime('now')), ?),
              created_at   = datetime(created_at, ?)
        WHERE id = ?`,
    ).run(modifier, modifier, id)
  } catch { /* tests fail loudly via the next assertion */ }
}

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
  /** 'job' (default) for explicit /job, 'inline' for cli auto-tracking. */
  kind?: JobKind
  /** `${platform}:${channelId}:${threadId}` — required for inline kind so
   *  Phase 3 can route recovery notifications back to the originating IM
   *  thread. Optional for kind='job' (legacy CLI / scheduler callers). */
  threadKey?: string
}

export function createJob(agent: string, prompt: string, opts: CreateJobOpts = {}): number {
  const d = getDb()
  if (!d) throw new Error('Job board unavailable (SQLite not initialized)')
  const row = d.prepare(
    `INSERT INTO jobs
       (agent, prompt, status, creator_id, workspace_id, thread_key, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent, prompt, 'pending',
    opts.creatorId || '', opts.workspaceId || '',
    opts.threadKey || '', opts.kind || 'job',
  )
  const id = Number(row.lastInsertRowid)
  eventBus.publish({ type: 'job', phase: 'created', jobId: id, agent })
  return id
}

/** Inline-job convenience: same as createJob but never throws — returns -1
 *  when the board is disabled / locked. Caller is expected to log + carry
 *  on with the in-memory fast path. The whole tracking machinery short-
 *  circuits when env IMHUB_INLINE_JOB_TRACKING=0. */
export function createInlineJob(opts: {
  agent: string
  prompt: string
  threadKey: string
  creatorId?: string
  workspaceId?: string
}): number {
  if (process.env.IMHUB_INLINE_JOB_TRACKING === '0') return -1
  try {
    return createJob(opts.agent, opts.prompt, {
      kind: 'inline',
      threadKey: opts.threadKey,
      creatorId: opts.creatorId,
      workspaceId: opts.workspaceId,
    })
  } catch (err) {
    rootLogger.warn(
      { component: 'job-board', event: 'job-board.inline_create_failed', err: err instanceof Error ? err.message : String(err) },
      'createInlineJob fell back to in-memory path',
    )
    return -1
  }
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

// ─── Inline-job state-machine helpers ────────────────────────────────
//
// All of these are no-op when id<=0 (board disabled / inline tracking off)
// or when the DB is unavailable. The caller never has to guard.

/** Replace the agent column. Used by inline jobs: cli.ts creates the row with
 *  the default agent name before routing resolves the actual agent, then this
 *  fires inside onAgentResolved to correct the record. No-op when status is
 *  past 'running' so we don't rewrite history. */
export function updateJobAgent(id: number, agent: string): void {
  if (id <= 0 || !agent) return
  const d = getDb()
  if (!d) return
  try {
    d.prepare(`UPDATE jobs SET agent = ? WHERE id = ? AND status IN ('pending', 'running')`).run(agent, id)
  } catch (err) {
    rootLogger.debug({ component: 'job-board', event: 'updateJobAgent_failed', id, agent, err: String(err) })
  }
}

/** pending → running. Stamps started_at. Idempotent: an already-running row
 *  keeps its original started_at. */
export function markJobRunning(id: number): void {
  if (id <= 0) return
  const d = getDb()
  if (!d) return
  try {
    d.prepare(
      `UPDATE jobs
          SET status = 'running',
              started_at = COALESCE(started_at, datetime('now'))
        WHERE id = ? AND status IN ('pending', 'running')`,
    ).run(id)
  } catch (err) {
    rootLogger.debug({ component: 'job-board', event: 'markJobRunning_failed', id, err: String(err) })
  }
}

/** running → completed (result captured). For inline kind 'delivered' is the
 *  next hop, triggered by the outbox worker once the IM platform confirms.
 *  For 'job' kind this is the terminal success state (no delivery channel). */
export function markJobCompleted(id: number, result: string): void {
  if (id <= 0) return
  const d = getDb()
  if (!d) return
  try {
    d.prepare(
      `UPDATE jobs
          SET status = 'completed',
              completed_at = datetime('now'),
              result = ?
        WHERE id = ? AND status IN ('pending', 'running')`,
    ).run(result, id)
  } catch (err) {
    rootLogger.debug({ component: 'job-board', event: 'markJobCompleted_failed', id, err: String(err) })
  }
}

/** Link a job row to the outbox row that will (try to) deliver its result.
 *  Worker uses outbox.job_id to find this row; this column is the reverse
 *  link for /job inspection ("which outbox row carried this reply"). */
export function linkJobOutbox(id: number, outboxId: number): void {
  if (id <= 0 || outboxId <= 0) return
  const d = getDb()
  if (!d) return
  try {
    d.prepare(`UPDATE jobs SET last_outbox_id = ? WHERE id = ?`).run(outboxId, id)
  } catch (err) {
    rootLogger.debug({ component: 'job-board', event: 'linkJobOutbox_failed', id, outboxId, err: String(err) })
  }
}

/** completed → delivered. Called by the outbox worker after the IM platform
 *  ack. No-op if the row isn't in 'completed' (e.g. user cancelled meanwhile). */
export function markJobDelivered(id: number): void {
  if (id <= 0) return
  const d = getDb()
  if (!d) return
  try {
    d.prepare(
      `UPDATE jobs
          SET status = 'delivered',
              delivered_at = datetime('now')
        WHERE id = ? AND status = 'completed'`,
    ).run(id)
  } catch (err) {
    rootLogger.debug({ component: 'job-board', event: 'markJobDelivered_failed', id, err: String(err) })
  }
}

/** Terminal failure (agent threw, outbox gave up, etc.). Captures the error
 *  on the row. completed_at gets stamped so retention sweeps treat the row
 *  the same as a normal terminal state. */
export function markJobFailed(id: number, error: string): void {
  if (id <= 0) return
  const d = getDb()
  if (!d) return
  try {
    d.prepare(
      `UPDATE jobs
          SET status = 'failed',
              completed_at = datetime('now'),
              error = ?
        WHERE id = ? AND status NOT IN ('cancelled', 'replaced', 'abandoned')`,
    ).run(error.slice(0, 4096), id)
  } catch (err) {
    rootLogger.debug({ component: 'job-board', event: 'markJobFailed_failed', id, err: String(err) })
  }
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
      const note = `\n\n[agim: result truncated — ${droppedBytes} bytes dropped after ${cap}-byte cap; raise IMHUB_JOB_RESULT_MAX_BYTES if needed]`
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
  const inlineHours = resolveInlineRetentionHours()
  // Terminal statuses across both kinds. 'delivered' is inline-only.
  // 'interrupted' / 'replaced' / 'abandoned' are Phase 3 statuses — pre-
  // declared here so retention works consistently when Phase 3 lands.
  const TERMINAL = "'completed','delivered','failed','cancelled','replaced','abandoned'"
  try {
    // Two passes — different retention by kind. SQLite can't do this in one
    // statement without a CASE-on-window-or-something gnarly; two prepares
    // keeps it readable and the row counts attributable.
    const jobInfo = d.prepare(`
      DELETE FROM jobs
      WHERE kind = 'job'
        AND status IN (${TERMINAL})
        AND completed_at IS NOT NULL
        AND completed_at < datetime('now', ?)
    `).run(`-${daysRetention} days`)
    const inlineInfo = d.prepare(`
      DELETE FROM jobs
      WHERE kind = 'inline'
        AND status IN (${TERMINAL})
        AND COALESCE(completed_at, created_at) < datetime('now', ?)
    `).run(`-${inlineHours} hours`)
    const total = jobInfo.changes + inlineInfo.changes
    if (total > 0) {
      rootLogger.info({
        component: 'job-board', event: 'job-board.pruned',
        deletedJob: jobInfo.changes, deletedInline: inlineInfo.changes,
        days: daysRetention, inlineHours,
      }, `Pruned ${jobInfo.changes} job + ${inlineInfo.changes} inline row(s)`)
    }
    return total
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
