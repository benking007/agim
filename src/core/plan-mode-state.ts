// plan-mode-state.ts — per-thread PlanMode override (v1.2.120).
//
// Why this file exists:
//   v1.2.119 shipped PlanMode as a process-global env (AGIM_NATIVE_PLAN_MODE).
//   That's clumsy: every toggle requires a service restart, and there's no
//   way to plan-mode ONE thread while the rest stay free. User
//   feedback was direct: "Plan模式下，退出Plan 需要重启Agim，感觉
//   太严格了".
//
//   v1.2.120 adds a per-thread override layer in front of the env. The
//   /plan slash command writes here; isPlanModeOn(threadKey) checks
//   per-thread first, falls back to env. The env stays as the
//   process-default for read-only sandbox deployments.
//
// Storage: ~/.agim/plan-mode.db. Single table, fail-soft via sqlite-helper.

import { join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { AGIM_HOME } from './agim-paths.js'

const log = rootLogger.child({ component: 'plan-mode-state' })

const SCHEMA = `
CREATE TABLE IF NOT EXISTS native_plan_mode (
  thread_key TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

const DB_PATH_FROM_ENV = process.env.AGIM_PLAN_MODE_DB
const dbPath = DB_PATH_FROM_ENV && DB_PATH_FROM_ENV.length > 0
  ? DB_PATH_FROM_ENV
  : join(AGIM_HOME, 'plan-mode.db')

const helper = createSqliteHelper({
  file: dbPath,
  schema: SCHEMA,
  logger: rootLogger,
  component: 'plan-mode-db',
})

/**
 * Get the per-thread PlanMode flag.
 *
 * Returns:
 *   - true  → thread is explicitly in PlanMode
 *   - false → thread is explicitly out of PlanMode (overrides env=on)
 *   - null  → no per-thread setting; caller should check env
 *
 * Three-state return matters because `setPlanMode(key, false)` is a
 * meaningful explicit "no, don't apply env default here" not a clear.
 * `clearPlanMode` is the way to wipe a row entirely.
 */
export function getPlanModeForThread(threadKey: string): boolean | null {
  if (!threadKey) return null
  return helper.safe((d) => {
    const row = d
      .prepare('SELECT enabled FROM native_plan_mode WHERE thread_key = ?')
      .get(threadKey) as { enabled?: number } | undefined
    if (!row || row.enabled == null) return null
    return row.enabled === 1
  }, null)
}

/** Upsert the per-thread PlanMode flag. */
export function setPlanModeForThread(threadKey: string, enabled: boolean): boolean {
  if (!threadKey) return false
  return helper.safe((d) => {
    d.prepare(
      `INSERT INTO native_plan_mode (thread_key, enabled, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(thread_key) DO UPDATE SET
         enabled    = excluded.enabled,
         updated_at = datetime('now')`,
    ).run(threadKey, enabled ? 1 : 0)
    return true
  }, false)
}

/** Remove the per-thread row entirely so the env default applies again. */
export function clearPlanModeForThread(threadKey: string): boolean {
  if (!threadKey) return false
  return helper.safe((d) => {
    d.prepare('DELETE FROM native_plan_mode WHERE thread_key = ?').run(threadKey)
    return true
  }, false)
}

/** List all threads currently with PlanMode explicitly enabled. Useful
 *  for the web admin view + audit. Returns ordered most-recent-first. */
export function listPlanModeEnabledThreads(): Array<{ threadKey: string; updatedAt: string }> {
  return helper.safe((d) => {
    const rows = d
      .prepare(
        'SELECT thread_key as threadKey, updated_at as updatedAt FROM native_plan_mode '
        + 'WHERE enabled = 1 ORDER BY updated_at DESC',
      )
      .all() as Array<{ threadKey: string; updatedAt: string }>
    return rows
  }, [])
}

/** Test-only: close the underlying handle so a temp DB can be unlinked. */
export function closePlanModeStateDb(): void {
  helper.close()
}

// Re-export for callers that want a single "is plan mode on for this
// thread?" answer including the env fallback. The native agent calls
// this from resolvePolicy() + buildSystemPrompt().
export function readEnvPlanModeDefault(): boolean {
  const raw = (process.env.AGIM_NATIVE_PLAN_MODE ?? '').toLowerCase().trim()
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}

/**
 * Resolve effective PlanMode for a thread, layering per-thread → env.
 *
 *   per-thread = true   → on  (regardless of env)
 *   per-thread = false  → off (regardless of env — useful to opt one
 *                              thread out when env=on for the rest)
 *   per-thread = null   → env (whatever AGIM_NATIVE_PLAN_MODE says)
 *
 * When `threadKey` is omitted or empty (no thread context, e.g. CLI
 * boot banner), we return the env default — matches v1.2.119 behaviour.
 */
export function effectivePlanModeOn(threadKey?: string): boolean {
  if (threadKey) {
    const explicit = getPlanModeForThread(threadKey)
    if (explicit !== null) {
      log.debug({ threadKey, explicit, source: 'per-thread' })
      return explicit
    }
  }
  return readEnvPlanModeDefault()
}
