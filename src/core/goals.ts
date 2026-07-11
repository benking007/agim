// goals — sustained-objective tracking for IM threads (P0 #2).
//
// Distinct from reminders / cron / heartbeats:
//   - `/remind`     — one-shot: fire at time T, deliver text, done.
//   - `/cron`       — repeating: same fire shape, no agent state across runs.
//   - `/heartbeat`  — periodic self-check that asks the agent if anything
//                     is worth doing right now (binding body = what to
//                     watch). Each tick is independent.
//   - `/goal`       — sustained MULTI-TURN objective: "ship v1.3.0 by
//                     Friday" / "research X over the next week". The
//                     agent sees the active goal injected into EVERY
//                     turn's prompt so it can keep the user on-mission
//                     across many back-and-forths. Users / agent log
//                     progress notes; on completion the row stays for
//                     historical browsing.
//
// One ACTIVE goal per thread at a time. Older goals are kept on disk
// for /goal list browsing but never injected into prompts.
//
// Storage: ~/.agim/goals.db (SQLite), same fail-soft helper as the
// rest of agim's per-user state.

import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'

const GOALS_DB = process.env.AGIM_GOALS_DB ?? join(AGIM_HOME, 'goals.db')

/** Hard caps. Goals are user-typed prose; tight limits keep prompt
 *  injection from blowing the context window on a single thread. */
export const MAX_TITLE_CHARS = 200
export const MAX_BODY_CHARS = 4_000
export const MAX_PROGRESS_NOTE_CHARS = 500
export const MAX_PROGRESS_NOTES_INJECTED = 5  // most recent

/** Most-recent N progress notes shown in /goal show output. */
const MAX_PROGRESS_NOTES_LISTED = 20

/** Goal lifecycle states.
 *  - active: counted as the thread's current goal; injected into prompts
 *  - paused: kept around but NOT injected (operator wants a break)
 *  - completed / cancelled: historical only */
export type GoalStatus = 'active' | 'paused' | 'completed' | 'cancelled'

export interface ProgressNote {
  ts: string       // ISO UTC
  by: string       // 'user' | 'agent' | 'system'
  text: string
}

export interface GoalRow {
  id: number
  platform: string
  channelId: string
  threadId: string
  userId: string
  title: string
  body: string
  status: GoalStatus
  /** Newest-last array (push on progress; render reversed for "most recent first"). */
  progressLog: ProgressNote[]
  createdAt: string
  updatedAt: string
  /** ISO timestamp of completion / cancellation, when applicable. */
  closedAt: string | null
}

interface GoalRowRaw {
  id: number
  platform: string
  channel_id: string
  thread_id: string
  user_id: string
  title: string
  body: string
  status: string
  progress_log: string
  created_at: string
  updated_at: string
  closed_at: string | null
}

const helper = createSqliteHelper({
  file: GOALS_DB,
  component: 'goals',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS goals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      platform      TEXT    NOT NULL,
      channel_id    TEXT    NOT NULL,
      thread_id     TEXT    NOT NULL,
      user_id       TEXT    NOT NULL DEFAULT '',
      title         TEXT    NOT NULL,
      body          TEXT    NOT NULL DEFAULT '',
      status        TEXT    NOT NULL DEFAULT 'active',
      progress_log  TEXT    NOT NULL DEFAULT '[]',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      closed_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goals_thread   ON goals(platform, channel_id, thread_id, status);
    CREATE INDEX IF NOT EXISTS idx_goals_status   ON goals(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_goals_owner    ON goals(platform, user_id, status);
  `,
})

function getDb(): Database.Database | null {
  return helper.get()
}

function rowFromRaw(r: GoalRowRaw): GoalRow {
  let progress: ProgressNote[] = []
  try {
    const parsed = JSON.parse(r.progress_log || '[]') as unknown
    if (Array.isArray(parsed)) {
      progress = parsed
        .filter((n): n is ProgressNote => (
          typeof n === 'object' && n !== null &&
          typeof (n as ProgressNote).ts === 'string' &&
          typeof (n as ProgressNote).by === 'string' &&
          typeof (n as ProgressNote).text === 'string'
        ))
    }
  } catch { /* malformed JSON; fall back to empty list */ }
  return {
    id: r.id,
    platform: r.platform,
    channelId: r.channel_id,
    threadId: r.thread_id,
    userId: r.user_id,
    title: r.title,
    body: r.body,
    status: (r.status || 'active') as GoalStatus,
    progressLog: progress,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
  }
}

/**
 * Set (or replace) the ACTIVE goal for a thread. Idempotent semantics:
 * if there's already an active goal, it's auto-paused first (kept in
 * the table) and a fresh row replaces it. This avoids accidental
 * silent drops of partially-tracked work — the operator can /goal
 * list to find paused predecessors and /goal resume <id> if they
 * changed their mind.
 */
export function setActiveGoal(input: {
  platform: string
  channelId: string
  threadId: string
  userId: string
  title: string
  body?: string
}): GoalRow | null {
  const d = getDb()
  if (!d) return null
  const title = input.title.trim().slice(0, MAX_TITLE_CHARS)
  const body = (input.body ?? '').trim().slice(0, MAX_BODY_CHARS)
  if (!title) return null
  try {
    // Auto-pause any existing ACTIVE goal in this thread so there's
    // never more than one row to inject. Older paused/completed
    // rows are untouched.
    d.prepare(`
      UPDATE goals SET
        status = 'paused',
        updated_at = datetime('now')
      WHERE platform = ? AND channel_id = ? AND thread_id = ? AND status = 'active'
    `).run(input.platform, input.channelId, input.threadId)

    const info = d.prepare(`
      INSERT INTO goals (platform, channel_id, thread_id, user_id, title, body, status, progress_log)
      VALUES (?, ?, ?, ?, ?, ?, 'active', '[]')
    `).run(
      input.platform, input.channelId, input.threadId,
      input.userId, title, body,
    )
    return getGoalById(Number(info.lastInsertRowid))
  } catch (err) {
    rootLogger.warn({ event: 'goals.set_active_failed', err: String(err) })
    return null
  }
}

/** Append a progress note to a goal. Caller picks `by` (typically
 *  'user' for /goal progress, 'agent' for future MCP tool call,
 *  'system' for status transitions). */
export function appendProgress(goalId: number, by: ProgressNote['by'], text: string): boolean {
  const d = getDb()
  if (!d) return false
  const note: ProgressNote = {
    ts: new Date().toISOString(),
    by,
    text: text.trim().slice(0, MAX_PROGRESS_NOTE_CHARS),
  }
  if (!note.text) return false
  try {
    // Read-modify-write inside one transaction so two near-simultaneous
    // /goal progress calls don't clobber each other.
    const tx = d.transaction((): boolean => {
      const row = d.prepare(`SELECT progress_log FROM goals WHERE id = ?`).get(goalId) as { progress_log: string } | undefined
      if (!row) return false
      let list: ProgressNote[]
      try {
        const parsed = JSON.parse(row.progress_log || '[]') as unknown
        list = Array.isArray(parsed) ? (parsed as ProgressNote[]) : []
      } catch { list = [] }
      list.push(note)
      d.prepare(`
        UPDATE goals SET progress_log = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(list), goalId)
      return true
    })
    return tx()
  } catch (err) {
    rootLogger.warn({ event: 'goals.append_progress_failed', err: String(err) })
    return false
  }
}

export function updateStatus(goalId: number, status: GoalStatus): boolean {
  const d = getDb()
  if (!d) return false
  const isClose = status === 'completed' || status === 'cancelled'
  try {
    const info = d.prepare(`
      UPDATE goals SET
        status = ?,
        updated_at = datetime('now'),
        closed_at = CASE WHEN ? THEN datetime('now') ELSE closed_at END
      WHERE id = ?
    `).run(status, isClose ? 1 : 0, goalId)
    return info.changes > 0
  } catch (err) {
    rootLogger.warn({ event: 'goals.update_status_failed', err: String(err) })
    return false
  }
}

/** Resume a paused goal — also auto-pauses any currently-active goal
 *  in the same thread so there's never more than one active. */
export function resumeGoal(goalId: number): boolean {
  const d = getDb()
  if (!d) return false
  try {
    const row = d.prepare(`SELECT platform, channel_id, thread_id, status FROM goals WHERE id = ?`)
      .get(goalId) as { platform: string; channel_id: string; thread_id: string; status: string } | undefined
    if (!row) return false
    if (row.status === 'completed' || row.status === 'cancelled') return false
    const tx = d.transaction((): void => {
      d.prepare(`
        UPDATE goals SET status = 'paused', updated_at = datetime('now')
        WHERE platform = ? AND channel_id = ? AND thread_id = ? AND status = 'active'
      `).run(row.platform, row.channel_id, row.thread_id)
      d.prepare(`
        UPDATE goals SET status = 'active', updated_at = datetime('now')
        WHERE id = ?
      `).run(goalId)
    })
    tx()
    return true
  } catch (err) {
    rootLogger.warn({ event: 'goals.resume_failed', err: String(err) })
    return false
  }
}

export function getGoalById(id: number): GoalRow | null {
  const d = getDb()
  if (!d) return null
  try {
    const row = d.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as GoalRowRaw | undefined
    return row ? rowFromRaw(row) : null
  } catch (err) {
    rootLogger.warn({ event: 'goals.get_by_id_failed', err: String(err) })
    return null
  }
}

/** The single active goal for a thread (or null if none). */
export function getActiveGoal(platform: string, channelId: string, threadId: string): GoalRow | null {
  const d = getDb()
  if (!d) return null
  try {
    const row = d.prepare(`
      SELECT * FROM goals
      WHERE platform = ? AND channel_id = ? AND thread_id = ? AND status = 'active'
      ORDER BY id DESC LIMIT 1
    `).get(platform, channelId, threadId) as GoalRowRaw | undefined
    return row ? rowFromRaw(row) : null
  } catch (err) {
    rootLogger.warn({ event: 'goals.get_active_failed', err: String(err) })
    return null
  }
}

/** Cheap boolean form of getActiveGoal — same query but returns only a
 *  flag. Used by the wall-timeout extension path (v1.2.86) where the
 *  caller just needs to know "should we be generous about timeouts on
 *  this thread". Safe to call from hot paths; same fail-soft semantics
 *  as getActiveGoal (db unavailable → false). */
export function hasActiveGoal(platform: string, channelId: string, threadId: string): boolean {
  const d = getDb()
  if (!d) return false
  try {
    const row = d.prepare(`
      SELECT 1 FROM goals
      WHERE platform = ? AND channel_id = ? AND thread_id = ? AND status = 'active'
      LIMIT 1
    `).get(platform, channelId, threadId)
    return !!row
  } catch (err) {
    rootLogger.warn({ event: 'goals.has_active_failed', err: String(err) })
    return false
  }
}

/** v1.2.86 — when an active goal exists on the addressed thread, the
 *  caller may legitimately need much longer to finish (research/coding
 *  marathons). Multiply the base timeout by AGIM_GOAL_ACTIVE_TIMEOUT_MULTIPLIER
 *  (default 3×). Returns `base` unchanged when no thread context, no
 *  active goal, or db unavailable.
 *
 *  Hard cap: 6 h. Even with goals, a runaway loop should not pin a
 *  worker indefinitely.
 */
export function applyGoalTimeoutBoost(
  base: number,
  ctx?: { platform?: string; channelId?: string; threadId?: string },
): number {
  if (!ctx?.platform || !ctx.channelId || !ctx.threadId) return base
  if (!hasActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)) return base
  const raw = process.env.AGIM_GOAL_ACTIVE_TIMEOUT_MULTIPLIER
  let mult = 3
  if (raw) {
    const n = parseFloat(raw)
    if (Number.isFinite(n) && n > 0) mult = n
  }
  const HARD_CAP_MS = 6 * 60 * 60 * 1000
  return Math.min(Math.floor(base * mult), HARD_CAP_MS)
}

/** All goals (any status) for a thread, newest first. Used by /goal list. */
export function listGoalsForThread(platform: string, channelId: string, threadId: string, limit = 20): GoalRow[] {
  const d = getDb()
  if (!d) return []
  try {
    const rows = d.prepare(`
      SELECT * FROM goals
      WHERE platform = ? AND channel_id = ? AND thread_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(platform, channelId, threadId, limit) as GoalRowRaw[]
    return rows.map(rowFromRaw)
  } catch (err) {
    rootLogger.warn({ event: 'goals.list_thread_failed', err: String(err) })
    return []
  }
}

/** Admin / debug — every active goal across the install. */
export function listAllActiveGoals(): GoalRow[] {
  const d = getDb()
  if (!d) return []
  try {
    const rows = d.prepare(`
      SELECT * FROM goals WHERE status = 'active' ORDER BY id ASC
    `).all() as GoalRowRaw[]
    return rows.map(rowFromRaw)
  } catch (err) {
    rootLogger.warn({ event: 'goals.list_all_failed', err: String(err) })
    return []
  }
}

/**
 * Build the per-turn prompt-prefix snippet for the active goal. Bounded
 * to ~MAX_PROGRESS_NOTES_INJECTED recent notes + truncated body so a
 * verbose goal doesn't dominate the prompt budget. Empty string when no
 * active goal — router treats falsy snippets as "skip this block".
 *
 * The snippet is OVER THE WIRE only — it's prepended to the prompt the
 * agent sees but NOT stored in session history, so it doesn't bloat the
 * persisted conversation.
 */
export function buildGoalSnippet(platform: string, channelId: string, threadId: string): string {
  const goal = getActiveGoal(platform, channelId, threadId)
  if (!goal) return ''
  const lines: string[] = []
  lines.push(`[agim context — active goal #${goal.id} for this thread]`)
  lines.push(`Title: ${goal.title}`)
  if (goal.body) {
    const truncated = goal.body.length > 800 ? `${goal.body.slice(0, 800)}…` : goal.body
    lines.push('Body:')
    lines.push(truncated)
  }
  if (goal.progressLog.length > 0) {
    lines.push('Recent progress:')
    const recent = goal.progressLog.slice(-MAX_PROGRESS_NOTES_INJECTED)
    for (const note of recent) {
      // Strip seconds/ms for compactness; UTC suffix omitted (already understood).
      const t = note.ts.slice(0, 16).replace('T', ' ')
      lines.push(`  - ${t} (${note.by}) ${note.text}`)
    }
  }
  lines.push('Use this goal to keep replies on-mission. Ignore if the user explicitly changes topic.')
  lines.push('')
  return lines.join('\n')
}

/** For /goal show — render an operator-facing summary including ALL
 *  retained progress notes (capped at MAX_PROGRESS_NOTES_LISTED so the
 *  IM bubble doesn't explode). */
export function formatGoalShow(goal: GoalRow): string {
  const out: string[] = []
  const statusFlag = ({
    active: '✅ active',
    paused: '⏸ paused',
    completed: '🎯 completed',
    cancelled: '✖ cancelled',
  })[goal.status]
  out.push(`🎯 Goal #${goal.id} — ${statusFlag}`)
  out.push(`Title: ${goal.title}`)
  out.push(`Updated: ${goal.updatedAt} UTC`)
  if (goal.closedAt) out.push(`Closed:  ${goal.closedAt} UTC`)
  if (goal.body) {
    out.push('')
    out.push('Body:')
    out.push('```')
    out.push(goal.body)
    out.push('```')
  }
  if (goal.progressLog.length > 0) {
    out.push('')
    out.push(`Progress (${goal.progressLog.length} notes):`)
    const recent = goal.progressLog.slice(-MAX_PROGRESS_NOTES_LISTED).reverse()
    for (const n of recent) {
      out.push(`  - ${n.ts.slice(0, 19).replace('T', ' ')} UTC (${n.by}) ${n.text}`)
    }
  }
  return out.join('\n')
}

/** Test-only. Drops everything; safe to call repeatedly in beforeEach. */
export function _truncateForTests(): void {
  const d = getDb()
  if (!d) return
  d.exec('DELETE FROM goals')
}
