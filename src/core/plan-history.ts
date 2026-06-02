// plan-history.ts — audit log for native_exit_plan_mode handshakes
// (v1.2.131 P0a).
//
// Why a separate sqlite table from plan-mode.db:
//   plan-mode.db holds the CURRENT state per thread (PK = thread_key,
//   one row max). plan-history records EACH transition — many rows
//   per thread over time — so operators can see "what did the model
//   propose 3 turns ago, did the user accept, why was it rejected".
//
// Schema is intentionally small + write-once. We never UPDATE rows;
// each entry is immutable for audit integrity. Retention is the
// operator's problem (vacuum-on-rotation could be added later).

import { join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { AGIM_HOME } from './agim-paths.js'

const log = rootLogger.child({ component: 'plan-history' })

/** Outcome strings written into the row. `expired` is reserved for the
 *  later approval-timeout path (v1.2.131 P0b only writes the first
 *  three). */
export type PlanOutcome = 'approved' | 'rejected' | 'edited' | 'expired'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  plan_md    TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  /** Free-form text — rejection reason, edit diff summary, etc. */
  detail     TEXT,
  /** ISO timestamp at the moment of resolution. */
  resolved_at TEXT NOT NULL DEFAULT (datetime('now')),
  /** Wall-clock seconds spent waiting for the user. */
  pending_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plan_history_thread
  ON plan_history(thread_key, resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_history_resolved
  ON plan_history(resolved_at DESC);
`

const DB_PATH_FROM_ENV = process.env.IMHUB_PLAN_HISTORY_DB
const dbPath = DB_PATH_FROM_ENV && DB_PATH_FROM_ENV.length > 0
  ? DB_PATH_FROM_ENV
  : join(AGIM_HOME, 'plan-history.db')

const helper = createSqliteHelper({
  file: dbPath,
  schema: SCHEMA,
  logger: rootLogger,
  component: 'plan-history-db',
})

/** What the audit callers pass in. `pendingMs` is optional because
 *  callers may not have measured it (e.g. test paths); the column
 *  stays NULL in that case. */
export interface RecordPlanInput {
  threadKey: string
  planMd: string
  outcome: PlanOutcome
  detail?: string | null
  pendingMs?: number | null
}

/** Insert a new immutable row. Returns the auto-id or null on failure. */
export function recordPlanHistory(input: RecordPlanInput): number | null {
  if (!input.threadKey || !input.planMd || !input.outcome) return null
  return helper.safe((d) => {
    const res = d.prepare(
      `INSERT INTO plan_history (thread_key, plan_md, outcome, detail, pending_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.threadKey,
      input.planMd,
      input.outcome,
      input.detail ?? null,
      input.pendingMs ?? null,
    )
    log.info({
      event: 'plan-history.recorded',
      threadKey: input.threadKey,
      outcome: input.outcome,
      planLen: input.planMd.length,
      id: res.lastInsertRowid,
    })
    return Number(res.lastInsertRowid)
  }, null)
}

export interface PlanHistoryRow {
  id: number
  threadKey: string
  planMd: string
  outcome: PlanOutcome
  detail: string | null
  resolvedAt: string
  pendingMs: number | null
}

/** Recent entries — admin UI uses this. `threadKey` filter is optional;
 *  omit to see global history. */
export function listPlanHistory(opts: {
  threadKey?: string
  limit?: number
} = {}): PlanHistoryRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))
  return helper.safe((d) => {
    const sql = opts.threadKey
      ? `SELECT id, thread_key as threadKey, plan_md as planMd, outcome,
                detail, resolved_at as resolvedAt, pending_ms as pendingMs
         FROM plan_history WHERE thread_key = ?
         ORDER BY resolved_at DESC, id DESC
         LIMIT ?`
      : `SELECT id, thread_key as threadKey, plan_md as planMd, outcome,
                detail, resolved_at as resolvedAt, pending_ms as pendingMs
         FROM plan_history
         ORDER BY resolved_at DESC, id DESC
         LIMIT ?`
    const rows = opts.threadKey
      ? d.prepare(sql).all(opts.threadKey, limit)
      : d.prepare(sql).all(limit)
    return rows as PlanHistoryRow[]
  }, [])
}

/** Test-only: close the db handle so a tmp file can be unlinked. */
export function closePlanHistoryDb(): void {
  helper.close()
}
