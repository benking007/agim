// Shared SQLite helper — fail-soft DB initialization with the same
// `getDb()` + `dbBroken` pattern previously copied across audit-log,
// job-board, and schedule. Centralizing it makes the bun-degraded
// behavior consistent and one-place-to-fix.

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from 'pino'

export interface SqliteHelper {
  /** Get the live Database, or null if init has failed. */
  get(): Database.Database | null
  /** Wrap a DB call with a try/catch that returns `fallback` on error. */
  safe<T>(fn: (d: Database.Database) => T, fallback: T): T
  /** Close the underlying handle if open. Idempotent — subsequent get()
   *  attempts will re-open a fresh connection. Used by graceful shutdown
   *  in cli.ts so WAL is checkpointed cleanly instead of leaving the
   *  next startup to recover from -wal/-shm.  */
  close(): void
  /** True while init is failing (until the next retry window). */
  isBroken(): boolean
  /** Component tag used in status / logs. */
  component(): string
  /** Mark the DB broken (test hook). */
  _markBroken(reason: string): void
}

export interface CreateOptions {
  /** Absolute path to the .db file. The parent dir is created if missing. */
  file: string
  /** SQL DDL run once after open (`CREATE TABLE IF NOT EXISTS …`). */
  schema: string
  /** Optional one-time migration / cleanup callback (e.g. job-board's
   *  reapStaleRunning). Invoked exactly once per process, after schema. */
  init?: (d: Database.Database) => void
  /** Pino logger (or compatible). Used to surface init failures. */
  logger?: Logger
  /** Component tag for logger child binding. Default: derived from file basename. */
  component?: string
}

/**
 * Create an opener that lazily initializes the DB on first call. If the
 * native module can't be loaded (bun runtime, missing libstdc++) or any
 * step throws, the helper transitions to "broken" and every subsequent
 * `get()` returns null — letting callers fail soft without crashing the
 * pipeline.
 */
const RETRY_BROKEN_MS = 5 * 60 * 1000
const helpers: SqliteHelper[] = []

export function sqlitePersistenceStatus(): Array<{ component: string; broken: boolean }> {
  return helpers.map((h) => ({ component: h.component(), broken: h.isBroken() }))
}

export function createSqliteHelper(opts: CreateOptions): SqliteHelper {
  let db: Database.Database | null = null
  let dbBroken = false
  let brokenAt = 0
  const component = opts.component || 'sqlite'
  const log = opts.logger?.child({ component })

  const helper: SqliteHelper = {
    get(): Database.Database | null {
      if (dbBroken) {
        if (Date.now() - brokenAt < RETRY_BROKEN_MS) return null
        dbBroken = false
        log?.info({ event: 'sqlite.retry_init', file: opts.file },
          `${component} retrying SQLite init after broken window`)
      }
      if (!db) {
        try {
          mkdirSync(dirname(opts.file), { recursive: true })
          db = new Database(opts.file)
          db.pragma('journal_mode = WAL')
          db.pragma('synchronous = NORMAL')
          db.exec(opts.schema)
          if (opts.init) opts.init(db)
        } catch (err) {
          dbBroken = true
          brokenAt = Date.now()
          db = null
          const msg = err instanceof Error ? err.message : String(err)
          log?.warn({ event: 'sqlite.disabled', file: opts.file, error: msg },
            `${component} disabled: ${msg}`)
          return null
        }
      }
      return db
    },

    safe<T>(fn: (d: Database.Database) => T, fallback: T): T {
      const d = this.get()
      if (!d) return fallback
      try {
        return fn(d)
      } catch (err) {
        log?.warn({ event: 'sqlite.query.failed', error: err instanceof Error ? err.message : String(err) },
          'SQLite query failed')
        return fallback
      }
    },

    close(): void {
      if (!db) return
      try {
        // better-sqlite3 .close() does an implicit WAL checkpoint and
        // releases the file handles — no async, throws synchronously on
        // double-close (we guard with the null check above).
        db.close()
        log?.info({ event: 'sqlite.closed', file: opts.file })
      } catch (err) {
        log?.warn({ event: 'sqlite.close.failed', error: err instanceof Error ? err.message : String(err) })
      } finally {
        db = null
      }
    },

    isBroken(): boolean {
      return dbBroken
    },

    component(): string {
      return component
    },

    _markBroken(reason: string): void {
      dbBroken = true
      brokenAt = Date.now()
      db = null
      log?.warn({ event: 'sqlite.markbroken', reason }, `marked broken: ${reason}`)
    },
  }
  helpers.push(helper)
  return helper
}
