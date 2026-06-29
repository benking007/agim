// user-coord-prefs.ts — per-user coord-system preference store.
//
// Why this file exists:
//   coord-systems.ts uses a single env flag (AGIM_TELEGRAM_COORDS_GCJ02)
//   to decide whether to treat incoming Telegram coords as GCJ-02 or
//   WGS-84. That's wrong for any deployment with mixed clients —
//   iPhone (system location → GCJ-02), Android+GMS (WGS-84), Telegram
//   Desktop (WGS-84), Apple Maps share (GCJ-02), Google Maps share
//   (WGS-84) all flow through the same `message.location` payload with
//   no source label.
//
//   Plan C (2026-05-22): per-(platform, user_id) preference, learned
//   from explicit user feedback. Default = in-China → GCJ-02 (covers
//   the most common iOS path which is also the most common deployment
//   shape we see). User replies `#wgs` / `#gcj` / `#bd` once → bot
//   stores the choice → all future locations from that user are
//   normalized accordingly.
//
//   Storage: ~/.agim/user-prefs.db. Single small table, no migrations,
//   fail-soft via sqlite-helper (bun-runtime safe).

import { join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { AGIM_HOME } from './agim-paths.js'

const log = rootLogger.child({ component: 'user-coord-prefs' })

export type CoordSystem = 'wgs84' | 'gcj02' | 'bd09'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_coord_prefs (
  platform     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  coord_system TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, user_id)
);
`

const dbPath = join(AGIM_HOME, 'user-prefs.db')
const helper = createSqliteHelper({
  file: dbPath,
  schema: SCHEMA,
  logger: rootLogger,
  component: 'user-prefs-db',
})

/**
 * Look up the coord-system preference for a given user. Returns null
 * if the user has never set one — caller falls back to the in-China
 * default (GCJ-02) or out-of-China pass-through (WGS-84).
 */
export function getUserCoordPref(platform: string, userId: string): CoordSystem | null {
  return helper.safe((d) => {
    const row = d
      .prepare('SELECT coord_system FROM user_coord_prefs WHERE platform = ? AND user_id = ?')
      .get(platform, userId) as { coord_system?: string } | undefined
    if (!row?.coord_system) return null
    if (row.coord_system !== 'wgs84' && row.coord_system !== 'gcj02' && row.coord_system !== 'bd09') {
      log.warn({ platform, userId, value: row.coord_system }, 'invalid coord_system in DB')
      return null
    }
    return row.coord_system as CoordSystem
  }, null)
}

/**
 * Set / overwrite the user's coord-system preference. Idempotent
 * upsert. Returns true on success, false if the DB is unavailable.
 */
export function setUserCoordPref(platform: string, userId: string, coordSystem: CoordSystem): boolean {
  return helper.safe((d) => {
    d.prepare(
      `INSERT INTO user_coord_prefs (platform, user_id, coord_system, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(platform, user_id) DO UPDATE SET
         coord_system = excluded.coord_system,
         updated_at   = datetime('now')`,
    ).run(platform, userId, coordSystem)
    return true
  }, false)
}

/** Remove the user's preference (back to default). */
export function clearUserCoordPref(platform: string, userId: string): boolean {
  return helper.safe((d) => {
    d.prepare('DELETE FROM user_coord_prefs WHERE platform = ? AND user_id = ?').run(platform, userId)
    return true
  }, false)
}

/** Test-only: close the underlying handle so a temp DB can be unlinked. */
export function closeUserCoordPrefsDb(): void {
  helper.close()
}
