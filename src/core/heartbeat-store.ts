// heartbeat-store — persistent state for the heartbeat service (P0 #1).
//
// One row per IM thread that has a heartbeat configured. The row holds
// the markdown "body" the heartbeat agent reasons against, the tick
// recurrence, the latest tick outcome (for /heartbeat show), and a tiny
// preview of the most recent delivery (so users can see "I last pinged
// you about X at HH:MM").
//
// Storage layout decision: SQLite, NOT a file-per-workspace markdown
// store (nanobot's HEARTBEAT.md design). agim is multi-tenant by IM
// thread; co-locating heartbeat config with the rest of agim's state
// (reminders.db, audit.db, etc.) keeps backup / restore / migration
// simple and avoids creating workspace directories for users who never
// touch the CLI agents.
//
// All public APIs return / accept plain objects (HeartbeatRow). Callers
// don't see SQLite directly so swapping the backend later is easy.

import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'

const HEARTBEAT_DB = process.env.IMHUB_HEARTBEAT_DB
  ?? join(AGIM_HOME, 'heartbeat.db')

/** Per-thread tick recurrence, in minutes. The default lines up with
 *  nanobot's 30-min cadence; operators can override per binding with
 *  `/heartbeat interval N` or the IMHUB_HEARTBEAT_DEFAULT_INTERVAL env. */
export const DEFAULT_INTERVAL_MIN = 30

/** Hard lower bound on the recurrence. 1-minute heartbeats are almost
 *  always a misconfiguration (the agent burns through API calls and
 *  there's no time for the previous tick to even finish). */
export const MIN_INTERVAL_MIN = 5

/** Hard upper bound — 24h. Above this just use cron + reminders. */
export const MAX_INTERVAL_MIN = 24 * 60

/** Max characters in a heartbeat body. Keeps prompt size bounded; the
 *  body is the entire context the cheap decide-step LLM sees, so
 *  unbounded text would silently blow the context window. */
export const MAX_BODY_CHARS = 8_000

/** Max characters of the last delivered text we keep around for the
 *  /heartbeat show preview. Beyond this is truncated with "…". */
const MAX_PREVIEW_CHARS = 240

/** Tick statuses recorded per attempt. */
export type TickStatus =
  | 'pending'      // never ticked
  | 'skipped'      // decide phase said no work to do
  | 'delivered'    // ran + evaluator passed + sink got the message
  | 'suppressed'   // ran + evaluator dropped the result
  | 'no-agent'     // ran phase aborted because no CLI agent for the thread
  | 'failed'       // exception somewhere; details in last_reason

export interface HeartbeatRow {
  id: number
  /** IM coordinates — the binding scope. */
  platform: string
  channelId: string
  threadId: string
  /** Owner of this binding (the IM user who ran /heartbeat bind). Used
   *  for audit and for picking the same agent the user is chatting
   *  with at tick time. */
  userId: string
  /** Markdown body — what the decide-step LLM and the execute-step
   *  agent reason against. Plain UTF-8; users can include lists, code
   *  fences, whatever they want. Max MAX_BODY_CHARS. */
  body: string
  /** Tick recurrence (minutes). MIN_INTERVAL_MIN ≤ x ≤ MAX_INTERVAL_MIN. */
  intervalMinutes: number
  /** Soft kill-switch. Disabled rows survive but never tick. */
  enabled: boolean
  /** ISO timestamp of the last attempted tick (null = never ticked). */
  lastTickAt: string | null
  /** Status of that last tick. */
  lastStatus: TickStatus
  /** Operator-facing one-liner from the last tick. */
  lastReason: string
  /** First MAX_PREVIEW_CHARS of the last successfully delivered text. */
  lastTextPreview: string
  createdAt: string
  updatedAt: string
}

interface HeartbeatRowRaw {
  id: number
  platform: string
  channel_id: string
  thread_id: string
  user_id: string
  body: string
  interval_minutes: number
  enabled: number
  last_tick_at: string | null
  last_status: string
  last_reason: string
  last_text_preview: string
  created_at: string
  updated_at: string
}

const helper = createSqliteHelper({
  file: HEARTBEAT_DB,
  component: 'heartbeat-store',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS heartbeats (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      platform          TEXT    NOT NULL,
      channel_id        TEXT    NOT NULL,
      thread_id         TEXT    NOT NULL,
      user_id           TEXT    NOT NULL DEFAULT '',
      body              TEXT    NOT NULL,
      interval_minutes  INTEGER NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      last_tick_at      TEXT,
      last_status       TEXT    NOT NULL DEFAULT 'pending',
      last_reason       TEXT    NOT NULL DEFAULT '',
      last_text_preview TEXT    NOT NULL DEFAULT '',
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (platform, channel_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeats_tick   ON heartbeats(enabled, last_tick_at);
    CREATE INDEX IF NOT EXISTS idx_heartbeats_owner  ON heartbeats(platform, user_id);
  `,
})

function getDb(): Database.Database | null {
  return helper.get()
}

function rowFromRaw(r: HeartbeatRowRaw): HeartbeatRow {
  return {
    id: r.id,
    platform: r.platform,
    channelId: r.channel_id,
    threadId: r.thread_id,
    userId: r.user_id,
    body: r.body,
    intervalMinutes: r.interval_minutes,
    enabled: r.enabled !== 0,
    lastTickAt: r.last_tick_at,
    lastStatus: (r.last_status || 'pending') as TickStatus,
    lastReason: r.last_reason || '',
    lastTextPreview: r.last_text_preview || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Read the operator-provided default interval (env override or constant). */
export function defaultIntervalMinutes(): number {
  const raw = process.env.IMHUB_HEARTBEAT_DEFAULT_INTERVAL_MIN
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= MIN_INTERVAL_MIN && n <= MAX_INTERVAL_MIN) {
      return n
    }
  }
  return DEFAULT_INTERVAL_MIN
}

/**
 * Create or replace the heartbeat for a thread. UPSERT semantics — one
 * binding per thread, calling bind() again overwrites the body and
 * resets last_tick_at so the new body takes effect on the next tick
 * (not 30 min later).
 */
export function upsertBinding(input: {
  platform: string
  channelId: string
  threadId: string
  userId: string
  body: string
  intervalMinutes?: number
}): HeartbeatRow | null {
  const d = getDb()
  if (!d) return null
  const body = input.body.slice(0, MAX_BODY_CHARS)
  const interval = clampInterval(input.intervalMinutes ?? defaultIntervalMinutes())
  try {
    // ON CONFLICT preserves the auto-increment id and timestamps while
    // refreshing the user-visible fields. We deliberately RESET
    // last_tick_at to NULL on rebind so the new body runs at the next
    // scheduler tick — otherwise the user's "/heartbeat bind X" sits
    // dormant for up to `intervalMinutes` minutes.
    d.prepare(`
      INSERT INTO heartbeats
        (platform, channel_id, thread_id, user_id, body, interval_minutes,
         enabled, last_tick_at, last_status, last_reason, last_text_preview,
         updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 'pending', '', '', datetime('now'))
      ON CONFLICT (platform, channel_id, thread_id) DO UPDATE SET
        user_id          = excluded.user_id,
        body             = excluded.body,
        interval_minutes = excluded.interval_minutes,
        enabled          = 1,
        last_tick_at     = NULL,
        last_status      = 'pending',
        last_reason      = '',
        updated_at       = datetime('now')
    `).run(
      input.platform, input.channelId, input.threadId,
      input.userId, body, interval,
    )
    return getBinding(input.platform, input.channelId, input.threadId)
  } catch (err) {
    rootLogger.warn({ event: 'heartbeat-store.upsert_failed', err: String(err) })
    return null
  }
}

/** Disable (don't delete) a binding for the given thread. */
export function disableBinding(platform: string, channelId: string, threadId: string): boolean {
  const d = getDb()
  if (!d) return false
  try {
    const info = d.prepare(`
      UPDATE heartbeats SET enabled = 0, updated_at = datetime('now')
      WHERE platform = ? AND channel_id = ? AND thread_id = ?
    `).run(platform, channelId, threadId)
    return info.changes > 0
  } catch (err) {
    rootLogger.warn({ event: 'heartbeat-store.disable_failed', err: String(err) })
    return false
  }
}

/** Soft-enable an existing binding (no-op if missing). */
export function enableBinding(platform: string, channelId: string, threadId: string): boolean {
  const d = getDb()
  if (!d) return false
  try {
    const info = d.prepare(`
      UPDATE heartbeats SET enabled = 1, updated_at = datetime('now')
      WHERE platform = ? AND channel_id = ? AND thread_id = ?
    `).run(platform, channelId, threadId)
    return info.changes > 0
  } catch (err) {
    rootLogger.warn({ event: 'heartbeat-store.enable_failed', err: String(err) })
    return false
  }
}

/** Replace the interval for an existing binding (no-op if missing). */
export function updateInterval(
  platform: string, channelId: string, threadId: string,
  intervalMinutes: number,
): boolean {
  const d = getDb()
  if (!d) return false
  const interval = clampInterval(intervalMinutes)
  try {
    const info = d.prepare(`
      UPDATE heartbeats
        SET interval_minutes = ?, updated_at = datetime('now')
      WHERE platform = ? AND channel_id = ? AND thread_id = ?
    `).run(interval, platform, channelId, threadId)
    return info.changes > 0
  } catch (err) {
    rootLogger.warn({ event: 'heartbeat-store.update_interval_failed', err: String(err) })
    return false
  }
}

/** Stamp the outcome of a tick. Caller is the scheduler / runForBinding. */
export function recordTick(input: {
  id: number
  status: TickStatus
  reason: string
  /** When delivered, the (truncated) body text. Ignored for non-delivered. */
  deliveredText?: string
}): void {
  const d = getDb()
  if (!d) return
  try {
    if (input.status === 'delivered') {
      const preview = (input.deliveredText ?? '').slice(0, MAX_PREVIEW_CHARS)
      d.prepare(`
        UPDATE heartbeats SET
          last_tick_at      = datetime('now'),
          last_status       = ?,
          last_reason       = ?,
          last_text_preview = ?,
          updated_at        = datetime('now')
        WHERE id = ?
      `).run(input.status, input.reason.slice(0, 240), preview, input.id)
    } else {
      d.prepare(`
        UPDATE heartbeats SET
          last_tick_at = datetime('now'),
          last_status  = ?,
          last_reason  = ?,
          updated_at   = datetime('now')
        WHERE id = ?
      `).run(input.status, input.reason.slice(0, 240), input.id)
    }
  } catch (err) {
    rootLogger.warn({ event: 'heartbeat-store.record_tick_failed', err: String(err) })
  }
}

export function getBinding(platform: string, channelId: string, threadId: string): HeartbeatRow | null {
  const d = getDb()
  if (!d) return null
  try {
    const row = d.prepare(`
      SELECT * FROM heartbeats
      WHERE platform = ? AND channel_id = ? AND thread_id = ?
    `).get(platform, channelId, threadId) as HeartbeatRowRaw | undefined
    return row ? rowFromRaw(row) : null
  } catch (err) {
    rootLogger.warn({ event: 'heartbeat-store.get_failed', err: String(err) })
    return null
  }
}

/** All bindings, regardless of enabled state. Admin-facing /heartbeat list. */
export function listAllBindings(): HeartbeatRow[] {
  const d = getDb()
  if (!d) return []
  try {
    const rows = d.prepare(`SELECT * FROM heartbeats ORDER BY id ASC`).all() as HeartbeatRowRaw[]
    return rows.map(rowFromRaw)
  } catch (err) {
    rootLogger.warn({ event: 'heartbeat-store.list_failed', err: String(err) })
    return []
  }
}

/**
 * All enabled bindings whose next tick is due. "Due" = `last_tick_at IS
 * NULL` OR `datetime(last_tick_at) <= datetime('now', '-N minutes')`.
 *
 * Each row carries its own interval, so we can't precompute a single
 * cutoff — the SQL filter checks per-row using interval_minutes.
 */
export function listDueBindings(): HeartbeatRow[] {
  const d = getDb()
  if (!d) return []
  try {
    const rows = d.prepare(`
      SELECT * FROM heartbeats
      WHERE enabled = 1
        AND (
          last_tick_at IS NULL
          OR datetime(last_tick_at, '+' || interval_minutes || ' minutes') <= datetime('now')
        )
      ORDER BY (last_tick_at IS NULL) DESC, last_tick_at ASC
      LIMIT 50
    `).all() as HeartbeatRowRaw[]
    return rows.map(rowFromRaw)
  } catch (err) {
    rootLogger.warn({ event: 'heartbeat-store.list_due_failed', err: String(err) })
    return []
  }
}

/** Strictly for tests: drop the table contents. NEVER call from runtime
 *  paths — the alternative is `disableBinding` per row. */
export function _truncateForTests(): void {
  const d = getDb()
  if (!d) return
  d.exec('DELETE FROM heartbeats')
}

function clampInterval(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MIN
  if (n < MIN_INTERVAL_MIN) return MIN_INTERVAL_MIN
  if (n > MAX_INTERVAL_MIN) return MAX_INTERVAL_MIN
  return Math.floor(n)
}
