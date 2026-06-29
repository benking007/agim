// WeChat iLink context_token persistence.
//
// The iLink Bot API requires a fresh context_token to push messages back to
// a user. The token is delivered with every incoming message and has a 30-min
// TTL. Without persistence, a service restart loses every cached token, which
// breaks anything that pushes async — most notably the new recurring-reminder
// engine: a "每天早上8点喝水" reminder fails to deliver because the user
// hasn't said anything in the 30 min before 8:00.
//
// Storage: a dedicated SQLite file mirroring the in-memory Map in
// ilink-adapter.ts. Write-through on every received message, lazy fallback
// on send-time cache miss. Same fail-soft helper as audit-log / reminders /
// schedule — if SQLite is unavailable (bun runtime), all calls degrade to
// no-ops and the adapter just behaves like before persistence existed.

import { join } from 'node:path'
import { logger as rootLogger } from '../../../core/logger.js'
import { createSqliteHelper } from '../../../core/sqlite-helper.js'
import { AGIM_HOME } from '../../../core/agim-paths.js'

const STORE_FILE = process.env.AGIM_WECHAT_CONTEXT_DB
  ?? join(AGIM_HOME, 'wechat-context.db')

const helper = createSqliteHelper({
  file: STORE_FILE,
  component: 'wechat-context-store',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS context_tokens (
      user_id    TEXT PRIMARY KEY,
      token      TEXT    NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_tokens_fetched_at
      ON context_tokens(fetched_at);
  `,
})

export interface StoredToken {
  userId: string
  token: string
  fetchedAt: number
}

/** Write-through UPSERT. Idempotent — same userId overrides previous token. */
export function persistContextToken(userId: string, token: string, fetchedAt: number): void {
  const d = helper.get()
  if (!d) return
  try {
    d.prepare(
      `INSERT INTO context_tokens (user_id, token, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         token = excluded.token,
         fetched_at = excluded.fetched_at`,
    ).run(userId, token, fetchedAt)
  } catch (err) {
    // Fail soft: persistence is best-effort. The in-memory Map still works.
    rootLogger.child({ component: 'wechat-context-store' }).warn({
      event: 'wechat.context.persist_failed',
      userId, err: err instanceof Error ? err.message : String(err),
    }, 'context_token persist failed')
  }
}

/** Load a single still-valid token, or null. */
export function loadContextToken(userId: string, ttlMs: number, now: number): StoredToken | null {
  const d = helper.get()
  if (!d) return null
  const row = d.prepare('SELECT * FROM context_tokens WHERE user_id = ?').get(userId) as
    | { user_id: string; token: string; fetched_at: number }
    | undefined
  if (!row) return null
  if (now - row.fetched_at > ttlMs) {
    // Expired — drop opportunistically so future scans stay small.
    d.prepare('DELETE FROM context_tokens WHERE user_id = ?').run(userId)
    return null
  }
  return { userId: row.user_id, token: row.token, fetchedAt: row.fetched_at }
}

/** Load every still-valid token. Used at adapter start() to warm the Map. */
export function loadAllContextTokens(ttlMs: number, now: number): StoredToken[] {
  const d = helper.get()
  if (!d) return []
  const cutoff = now - ttlMs
  // Scrub expired in same pass to keep the table small.
  d.prepare('DELETE FROM context_tokens WHERE fetched_at < ?').run(cutoff)
  const rows = d.prepare(
    'SELECT user_id, token, fetched_at FROM context_tokens ORDER BY fetched_at DESC',
  ).all() as Array<{ user_id: string; token: string; fetched_at: number }>
  return rows.map((r) => ({ userId: r.user_id, token: r.token, fetchedAt: r.fetched_at }))
}

/** Drop expired rows. Returns the number of rows deleted. */
export function cleanupExpiredTokens(ttlMs: number, now: number): number {
  const d = helper.get()
  if (!d) return 0
  const cutoff = now - ttlMs
  return d.prepare('DELETE FROM context_tokens WHERE fetched_at < ?').run(cutoff).changes
}

/** Drop the row for one user (e.g. after a sendMessage proves the token expired
 *  upstream — caller should evict so we don't keep retrying it). */
export function deleteContextToken(userId: string): void {
  const d = helper.get()
  if (!d) return
  try {
    d.prepare('DELETE FROM context_tokens WHERE user_id = ?').run(userId)
  } catch {
    /* fail soft */
  }
}

export function closeContextStore(): void {
  helper.close()
}
