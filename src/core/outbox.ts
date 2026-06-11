// Outbox — persistent IM-delivery queue backed by SQLite.
//
// Decouples "agent produced a reply" from "messenger actually sent it":
//   - sendMessage call sites enqueue() a row (status='pending').
//   - The outbox worker (see message-sink.ts) drains pending rows,
//     calls the messenger, and marks delivered/failed/giving_up.
//   - Failed rows are retried with exponential backoff; after the last
//     attempt the row transitions to 'giving_up' and stays there until
//     manual retryGivingUp() or pruneOldOutbox() collects it.
//
// Why a separate .db file instead of riding job-board's:
//   - Outbox is high-frequency (every IM-bound message hits it at least
//     twice: insert + status update); jobs is comparatively quiet.
//     Splitting WAL files avoids write contention between the two.
//   - The two concerns can fail / be migrated / be wiped independently.
//   - Linkage back to jobs is via outbox.job_id (nullable) — many outbox
//     rows (reminders, approval-router, restart-completion) have no job.
//
// Retention: delivered / giving_up rows older than IMHUB_OUTBOX_RETENTION_HOURS
// (default 24h) are pruned. Sweep runs every hour to keep the table bounded
// even under heavy traffic.

import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { AGIM_HOME } from './agim-paths.js'
import { scrubOutboundText } from './sensitive-paths.js'

const OUTBOX_DB = join(AGIM_HOME, 'outbox.db')

// 'sending' is a transient lease: the worker atomically claims a 'pending'
// row into 'sending' before calling the messenger, so a re-entrant tick (or
// a markDelivered DB-write failure) can never re-pick and re-send the same
// row. Rows orphaned in 'sending' by a crash are requeued at startup via
// requeueStuckSending().
export type OutboxStatus = 'pending' | 'sending' | 'delivered' | 'giving_up'
export type OutboxKind = 'text' | 'card' | 'typing'
export type OutboxPriority = 'high' | 'normal'

export interface OutboxRow {
  id: number
  job_id: number | null
  thread_key: string
  platform: string
  channel_id: string
  thread_id: string
  payload: string
  kind: OutboxKind
  priority: OutboxPriority
  status: OutboxStatus
  attempts: number
  last_attempt_at: string | null
  last_error: string | null
  delivered_at: string | null
  next_attempt_at: string | null
  created_at: string
  dedup_key: string | null
}

export interface EnqueueOpts {
  threadKey: string
  platform: string
  channelId: string
  threadId: string
  /** For text/card: serialized payload (text body or JSON of card). For typing: unused, pass ''. */
  payload: string
  kind: OutboxKind
  priority?: OutboxPriority
  jobId?: number | null
  /** Optional idempotency key. When set, a second enqueue with the same key
   *  is a no-op and returns the existing row id, so a retried/replayed caller
   *  (e.g. a reminder resurrected from the 'firing' state after a crash) can't
   *  enqueue a duplicate message. */
  dedupKey?: string | null
}

/** Backoff schedule in seconds. attempts=N failed → wait BACKOFF[N-1] seconds
 *  before retrying. After all entries exhausted, the row transitions to
 *  'giving_up' and no longer participates in pickPending(). */
const BACKOFF_SECONDS = [1, 5, 30, 300, 1800, 7200] as const
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length

/** Retention: how long a delivered / giving_up row stays before prune. */
function resolveRetentionHours(): number {
  const raw = process.env.IMHUB_OUTBOX_RETENTION_HOURS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 24
}

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000  // 1 h
let retentionSweepTimer: ReturnType<typeof setInterval> | null = null

const helper = createSqliteHelper({
  file: OUTBOX_DB,
  component: 'outbox',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          INTEGER,
      thread_key      TEXT    NOT NULL,
      platform        TEXT    NOT NULL,
      channel_id      TEXT    NOT NULL,
      thread_id       TEXT    NOT NULL,
      payload         TEXT    NOT NULL,
      kind            TEXT    NOT NULL,
      priority        TEXT    NOT NULL DEFAULT 'normal',
      status          TEXT    NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error      TEXT,
      delivered_at    TEXT,
      next_attempt_at TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      dedup_key       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending
      ON outbox(status, priority, next_attempt_at, created_at)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_outbox_retention
      ON outbox(status, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_thread
      ON outbox(thread_key, status);
    -- Idempotency: at most one live row per dedup_key. Partial so the common
    -- case (no key) is unconstrained. Lets callers (e.g. reminder firing)
    -- enqueue with a stable per-occurrence key so a crash-induced re-fire
    -- can't double-send the same message.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedup
      ON outbox(dedup_key) WHERE dedup_key IS NOT NULL;
  `,
  init: (d) => {
    // Migration: add dedup_key to pre-existing DBs (CREATE TABLE IF NOT EXISTS
    // won't add columns). Guarded so a duplicate-column race is a no-op.
    const cols = d.pragma('table_info(outbox)') as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'dedup_key')) {
      try { d.exec('ALTER TABLE outbox ADD COLUMN dedup_key TEXT') } catch { /* already added by a concurrent boot */ }
    }
    try {
      d.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedup ON outbox(dedup_key) WHERE dedup_key IS NOT NULL",
      )
    } catch { /* index already present */ }
    // Cold-start cleanup: prune retained rows and seed periodic sweep.
    pruneOldOutbox(d)
    if (RETENTION_SWEEP_INTERVAL_MS > 0 && retentionSweepTimer === null) {
      retentionSweepTimer = setInterval(() => {
        const live = helper.get()
        if (live) pruneOldOutbox(live)
      }, RETENTION_SWEEP_INTERVAL_MS)
      if (typeof retentionSweepTimer === 'object' && retentionSweepTimer && 'unref' in retentionSweepTimer) {
        (retentionSweepTimer as { unref: () => void }).unref()
      }
    }
  },
})

/** Stop the retention sweep (graceful shutdown / tests). */
export function stopOutboxRetentionSweep(): void {
  if (retentionSweepTimer) {
    clearInterval(retentionSweepTimer)
    retentionSweepTimer = null
  }
}

/** Close the underlying SQLite handle. Called by cli.ts on graceful shutdown. */
export function closeOutboxDb(): void {
  helper.close()
}

function getDb(): Database.Database | null {
  return helper.get()
}

/** Insert a new pending row. Returns the row id, or -1 if the DB is broken
 *  (caller should fall back to direct send).
 *
 *  R13 B5 — outbound text payloads are scrubbed for secret-shaped
 *  substrings before insert. Defense-in-depth tail behind B1's hard
 *  denylist: if an agent dumps a token / private key / .env block
 *  via a path the denylist missed, the scrubber catches it on the
 *  way out. The scrubbed payload is what hits SQLite + the wire;
 *  the original never persists. */
export function enqueue(opts: EnqueueOpts): number {
  const d = getDb()
  if (!d) return -1

  let payload = opts.payload
  if (opts.kind === 'text' && typeof payload === 'string' && payload.length > 0) {
    try {
      const scrub = scrubOutboundText(payload)
      if (scrub.redactedKinds.length > 0) {
        rootLogger.warn(
          {
            component: 'outbox',
            event: 'outbox.outbound_secret_redacted',
            kinds: scrub.redactedKinds,
            threadKey: opts.threadKey,
            jobId: opts.jobId ?? null,
          },
          'redacted secret-shaped substring(s) from outbound IM payload',
        )
        // Best-effort audit row so operators can see the rate via
        // /api/audit/events without parsing pino journal lines.
        void (async () => {
          try {
            const { logAuditEvent } = await import('./audit-log.js')
            logAuditEvent({
              eventType: 'approval.deny',
              actor: `${opts.platform}:${opts.threadId}`,
              target: 'outbox.send',
              outcome: 'denied',
              details: { reason: 'outbound_secret_redacted', kinds: scrub.redactedKinds },
            })
          } catch { /* best-effort */ }
        })()
        payload = scrub.text
      }
    } catch (err) {
      // Scrubber must never block delivery. Worst case: original
      // payload goes out unchanged, same as pre-R13 behavior.
      rootLogger.debug({ component: 'outbox', event: 'outbox.scrubber_failed', err: String(err) })
    }
  }

  const dedupKey = opts.dedupKey ?? null
  try {
    // INSERT OR IGNORE so a duplicate dedup_key collides on the partial unique
    // index and is silently skipped rather than throwing. dedup_key=NULL never
    // collides (NULLs are excluded from the partial index).
    const row = d.prepare(
      `INSERT OR IGNORE INTO outbox
         (job_id, thread_key, platform, channel_id, thread_id,
          payload, kind, priority, status, next_attempt_at, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?)`,
    ).run(
      opts.jobId ?? null,
      opts.threadKey,
      opts.platform,
      opts.channelId,
      opts.threadId,
      payload,
      opts.kind,
      opts.priority ?? 'normal',
      dedupKey,
    )
    if (row.changes === 0 && dedupKey !== null) {
      // Duplicate dedup_key — a row already exists for this logical message.
      // Return its id so the caller treats the enqueue as a (idempotent) success.
      const existing = d.prepare('SELECT id FROM outbox WHERE dedup_key = ?').get(dedupKey) as { id: number } | undefined
      if (existing) {
        rootLogger.debug(
          { component: 'outbox', event: 'outbox.dedup_hit', dedupKey, id: existing.id },
          'enqueue deduplicated — existing row reused',
        )
        return existing.id
      }
    }
    return Number(row.lastInsertRowid)
  } catch (err) {
    rootLogger.warn(
      { component: 'outbox', event: 'outbox.enqueue_failed', err: err instanceof Error ? err.message : String(err) },
      'outbox enqueue failed; caller should send directly',
    )
    return -1
  }
}

/** Pick up to `limit` pending rows whose next_attempt_at is now-or-past,
 *  highest priority first. Worker calls this on each tick. */
export function pickPending(limit: number = 10): OutboxRow[] {
  const d = getDb()
  if (!d) return []
  try {
    const rows = d.prepare(
      `SELECT * FROM outbox
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
        ORDER BY
          CASE priority WHEN 'high' THEN 0 ELSE 1 END,
          created_at ASC
        LIMIT ?`,
    ).all(limit) as OutboxRow[]
    return rows
  } catch (err) {
    rootLogger.warn(
      { component: 'outbox', event: 'outbox.pick_failed', err: err instanceof Error ? err.message : String(err) },
      'outbox pickPending failed',
    )
    return []
  }
}

/** Atomically claim a 'pending' row for delivery, transitioning it to the
 *  transient 'sending' lease. Returns true iff THIS caller won the claim
 *  (changes === 1). The worker must only call doSend() after a winning
 *  claim, so a re-entrant tick can never double-send the same row.
 *
 *  Note: attempts is intentionally NOT incremented here — markDelivered /
 *  markFailed own the attempts accounting, so direct (non-worker) callers
 *  and the existing tests keep their semantics. */
export function claimForSend(id: number): boolean {
  const d = getDb()
  if (!d) return false
  try {
    const info = d.prepare(
      `UPDATE outbox
          SET status = 'sending',
              last_attempt_at = datetime('now')
        WHERE id = ? AND status = 'pending'`,
    ).run(id)
    return info.changes === 1
  } catch (err) {
    rootLogger.warn(
      { component: 'outbox', event: 'outbox.claim_failed', id, err: err instanceof Error ? err.message : String(err) },
      'claimForSend failed',
    )
    return false
  }
}

/** Requeue rows orphaned in the transient 'sending' lease by a crash (the
 *  process died between claimForSend and markDelivered/markFailed). Called
 *  once at worker startup. Returns the number of rows requeued.
 *
 *  This preserves at-least-once delivery: a row that was actually sent but
 *  crashed before the delivered-ack is re-sent once on restart (a duplicate
 *  is the safe failure mode here vs. a silently dropped message). The win
 *  over the previous design is that, absent a crash, a failed delivered-ack
 *  leaves the row parked in 'sending' (not 'pending'), so the worker no
 *  longer re-sends it every tick. */
export function requeueStuckSending(): number {
  const d = getDb()
  if (!d) return 0
  try {
    const info = d.prepare(
      `UPDATE outbox
          SET status = 'pending',
              next_attempt_at = datetime('now')
        WHERE status = 'sending'`,
    ).run()
    if (info.changes > 0) {
      rootLogger.warn(
        { component: 'outbox', event: 'outbox.requeue_stuck_sending', requeued: info.changes },
        `requeued ${info.changes} outbox row(s) stuck in 'sending' after a prior crash`,
      )
    }
    return info.changes
  } catch (err) {
    rootLogger.warn(
      { component: 'outbox', event: 'outbox.requeue_failed', err: err instanceof Error ? err.message : String(err) },
      'requeueStuckSending failed',
    )
    return 0
  }
}

/** Mark a row delivered. Accepts a row that is either still 'pending' (the
 *  high-priority sync path enqueues then delivers directly) or held in the
 *  'sending' lease (the worker path, post claimForSend). */
export function markDelivered(id: number): void {
  const d = getDb()
  if (!d) return
  try {
    d.prepare(
      `UPDATE outbox
          SET status = 'delivered',
              delivered_at = datetime('now'),
              last_attempt_at = datetime('now'),
              attempts = attempts + 1,
              last_error = NULL,
              next_attempt_at = NULL
        WHERE id = ? AND status IN ('pending', 'sending')`,
    ).run(id)
  } catch (err) {
    rootLogger.warn(
      { component: 'outbox', event: 'outbox.mark_delivered_failed', id, err: err instanceof Error ? err.message : String(err) },
      'markDelivered failed',
    )
  }
}

/** Record a failed attempt. If attempts have exhausted the backoff schedule
 *  the row transitions to 'giving_up' (and no longer drains). Otherwise it
 *  stays 'pending' with next_attempt_at = now + backoff. */
export function markFailed(id: number, error: string): { gaveUp: boolean; attempts: number } {
  const d = getDb()
  if (!d) return { gaveUp: false, attempts: 0 }
  try {
    return d.transaction((): { gaveUp: boolean; attempts: number } => {
      const row = d.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number } | undefined
      if (!row) return { gaveUp: false, attempts: 0 }
      const nextAttempts = row.attempts + 1
      if (nextAttempts >= MAX_ATTEMPTS) {
        d.prepare(
          `UPDATE outbox
              SET status = 'giving_up',
                  attempts = ?,
                  last_attempt_at = datetime('now'),
                  last_error = ?,
                  next_attempt_at = NULL
            WHERE id = ?`,
        ).run(nextAttempts, error.slice(0, 1024), id)
        return { gaveUp: true, attempts: nextAttempts }
      }
      // Reschedule. BACKOFF_SECONDS is 0-indexed by failure count so the
      // first failure (nextAttempts=1) waits BACKOFF_SECONDS[0]=1s. status is
      // reset to 'pending' explicitly so a row failing out of the 'sending'
      // lease (worker path) re-enters the pending queue; it's a no-op for the
      // direct-call path where the row was already 'pending'.
      const waitSec = BACKOFF_SECONDS[nextAttempts - 1]
      d.prepare(
        `UPDATE outbox
            SET status = 'pending',
                attempts = ?,
                last_attempt_at = datetime('now'),
                last_error = ?,
                next_attempt_at = datetime('now', '+' || ? || ' seconds')
          WHERE id = ?`,
      ).run(nextAttempts, error.slice(0, 1024), waitSec, id)
      return { gaveUp: false, attempts: nextAttempts }
    })()
  } catch (err) {
    rootLogger.warn(
      { component: 'outbox', event: 'outbox.mark_failed_failed', id, err: err instanceof Error ? err.message : String(err) },
      'markFailed failed',
    )
    return { gaveUp: false, attempts: 0 }
  }
}

/** Get one row by id. */
export function getOutbox(id: number): OutboxRow | null {
  const d = getDb()
  if (!d) return null
  try {
    const row = d.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined
    return row ?? null
  } catch {
    return null
  }
}

/** List rows in 'giving_up' or 'pending' state for /outbox command. */
export function listOutbox(opts: { status?: OutboxStatus; limit?: number; threadKey?: string } = {}): OutboxRow[] {
  const d = getDb()
  if (!d) return []
  const limit = opts.limit ?? 20
  try {
    if (opts.threadKey && opts.status) {
      return d.prepare(
        'SELECT * FROM outbox WHERE thread_key = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
      ).all(opts.threadKey, opts.status, limit) as OutboxRow[]
    }
    if (opts.status) {
      return d.prepare(
        'SELECT * FROM outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      ).all(opts.status, limit) as OutboxRow[]
    }
    if (opts.threadKey) {
      return d.prepare(
        'SELECT * FROM outbox WHERE thread_key = ? ORDER BY created_at DESC LIMIT ?',
      ).all(opts.threadKey, limit) as OutboxRow[]
    }
    return d.prepare(
      'SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as OutboxRow[]
  } catch {
    return []
  }
}

/** Aggregate counts for /outbox status. */
export function getOutboxStats(): Record<OutboxStatus, number> {
  const d = getDb()
  const empty: Record<OutboxStatus, number> = { pending: 0, sending: 0, delivered: 0, giving_up: 0 }
  if (!d) return empty
  try {
    const rows = d.prepare('SELECT status, COUNT(*) as n FROM outbox GROUP BY status').all() as Array<{ status: OutboxStatus; n: number }>
    const out = { ...empty }
    for (const r of rows) out[r.status] = r.n
    return out
  } catch {
    return empty
  }
}

/** Resurrect a 'giving_up' row back to 'pending' so the worker tries again.
 *  Resets attempts to 0 so the full backoff ladder applies again. */
export function retryGivingUp(id: number): boolean {
  const d = getDb()
  if (!d) return false
  try {
    const info = d.prepare(
      `UPDATE outbox
          SET status = 'pending',
              attempts = 0,
              last_error = NULL,
              next_attempt_at = datetime('now')
        WHERE id = ? AND status = 'giving_up'`,
    ).run(id)
    return info.changes > 0
  } catch {
    return false
  }
}

/** Prune delivered + giving_up rows older than the retention window. */
export function pruneOldOutbox(d?: Database.Database): number {
  const db = d ?? getDb()
  if (!db) return 0
  const hours = resolveRetentionHours()
  try {
    const info = db.prepare(
      `DELETE FROM outbox
        WHERE status IN ('delivered', 'giving_up')
          AND COALESCE(delivered_at, last_attempt_at, created_at)
              < datetime('now', '-' || ? || ' hours')`,
    ).run(hours)
    if (info.changes > 0) {
      rootLogger.info(
        { component: 'outbox', event: 'outbox.prune', deleted: info.changes, retentionHours: hours },
        `Pruned ${info.changes} outbox row(s)`,
      )
    }
    return info.changes
  } catch (err) {
    rootLogger.warn(
      { component: 'outbox', event: 'outbox.prune_failed', err: err instanceof Error ? err.message : String(err) },
      'pruneOldOutbox failed',
    )
    return 0
  }
}

/** Test hook: wipe everything. Only safe in unit tests. */
export function _resetOutboxForTests(): void {
  const d = getDb()
  if (!d) return
  d.prepare('DELETE FROM outbox').run()
}
