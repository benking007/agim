// Scheduler — persistent cron-driven Job creation.
//
// Schedules live in the same SQLite DB as Jobs (extra table). A 30s tick
// scans for due rows, creates a Job for each, and bumps `next_run`. When
// SQLite is unavailable (bun runtime / disk error) the scheduler exposes
// the same API but persists nothing — exact same fail-soft pattern as
// audit-log + job-board.

import type Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { logger as rootLogger } from './logger.js'
import { parseCron, nextOccurrence } from './cron.js'
import { createJob, runJob } from './job-board.js'
import { registry } from './registry.js'
import { AgentBase } from './agent-base.js'
import { createSqliteHelper } from './sqlite-helper.js'

const SCHED_DB = join(homedir(), '.im-hub', 'schedules.db')
const TICK_INTERVAL_MS = 30 * 1000
const NOTIFY_TIMEOUT_MS = 10 * 1000
/** Hard cap on webhook response body — we only read a small ack. */
const NOTIFY_MAX_RESPONSE_BYTES = 64 * 1024

const log = rootLogger.child({ component: 'schedule' })

let tickTimer: ReturnType<typeof setInterval> | null = null

/**
 * Validate a user-supplied webhook URL before the scheduler POSTs to it.
 * Defends against accidental misconfig and basic SSRF: no protocols other
 * than http(s); no loopback / RFC1918 / link-local destinations unless the
 * operator explicitly opts in via IMHUB_ALLOW_PRIVATE_WEBHOOKS=1.
 *
 * Note: this is a lexical check (IP literals + "localhost"). DNS-rebinding
 * mitigation requires an at-fetch-time guard; tracked separately.
 */
export function validateWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL
  try { u = new URL(raw) } catch {
    return { ok: false, reason: 'malformed URL' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `protocol ${u.protocol} not allowed (use http: or https:)` }
  }
  if (process.env.IMHUB_ALLOW_PRIVATE_WEBHOOKS === '1') return { ok: true, url: u }
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '[::]') {
    return { ok: false, reason: `host ${host} not allowed` }
  }
  // IPv4 literals
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const o = v4.slice(1, 5).map(Number)
    if (o.some((b) => !Number.isFinite(b) || b < 0 || b > 255)) {
      return { ok: false, reason: 'malformed IPv4 literal' }
    }
    const [a, b] = o
    // 127/8 loopback, 10/8, 192.168/16, 172.16-31/12, 169.254/16 link-local,
    // 0/8 "this network", 100.64/10 CGNAT.
    if (a === 127 || a === 10 || a === 0
      || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)) {
      return { ok: false, reason: `private/loopback IPv4 ${host} not allowed` }
    }
  }
  // IPv6 literals come wrapped in [] in URL.hostname strips them; bracket
  // forms still surface in u.host though. Block well-known unsafe prefixes.
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return { ok: false, reason: `private/loopback IPv6 ${host} not allowed` }
  }
  return { ok: true, url: u }
}

export interface Schedule {
  id: number
  name: string
  agent: string
  prompt: string
  cron: string
  enabled: number  // SQLite stores as 0/1
  next_run: string  // ISO
  last_run: string | null
  notify_url: string | null
  created_at: string
  /** IM userId of the originating caller, or '' for legacy / system rows. */
  creator_id: string
  /** Workspace this schedule was created under, or '' if unknown. */
  workspace_id: string
}

/** Filter / scoping options for owner-sensitive schedule APIs. Identical
 *  semantics to {@link OwnerOpts} on job-board.ts. */
export interface OwnerOpts {
  creatorId?: string
  /** Optional agent-name filter, mirrors job-board.OwnerOpts.agent. */
  agent?: string
}

/**
 * Idempotent column-add for ownership tracking. Same shape as job-board's
 * migrateOwnership — survive multiple boots without breaking.
 */
function migrateOwnership(d: Database.Database): void {
  for (const col of ['creator_id', 'workspace_id'] as const) {
    try {
      d.prepare(`ALTER TABLE schedules ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`).run()
      rootLogger.info({ component: 'schedule', column: col, event: 'schedule.migration' },
        `Added ${col} column to schedules table`)
    } catch {
      // duplicate column — already migrated
    }
  }
}

const helper = createSqliteHelper({
  file: SCHED_DB,
  component: 'schedule',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS schedules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      agent         TEXT    NOT NULL,
      prompt        TEXT    NOT NULL,
      cron          TEXT    NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      next_run      TEXT    NOT NULL,
      last_run      TEXT,
      notify_url    TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      creator_id    TEXT    NOT NULL DEFAULT '',
      workspace_id  TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sched_next ON schedules(next_run, enabled);
    CREATE INDEX IF NOT EXISTS idx_sched_creator ON schedules(creator_id);
  `,
  init: (d) => migrateOwnership(d),
})

function getDb(): Database.Database | null {
  return helper.get()
}

export interface CreateScheduleInput {
  name: string
  agent: string
  prompt: string
  cron: string
  notifyUrl?: string
  enabled?: boolean
  /** IM userId of the originating caller. Empty / undefined → '' (legacy). */
  creatorId?: string
  /** Workspace this schedule was created under. */
  workspaceId?: string
}

export function createSchedule(input: CreateScheduleInput): number {
  const d = getDb()
  if (!d) throw new Error('Scheduler unavailable (SQLite not initialized)')
  const spec = parseCron(input.cron)  // throws on bad expr
  const next = nextOccurrence(spec, new Date())
  if (!next) throw new Error('Cron expression has no future occurrence')
  if (input.notifyUrl) {
    const v = validateWebhookUrl(input.notifyUrl)
    if (!v.ok) throw new Error(`notifyUrl rejected: ${v.reason}`)
  }
  const info = d.prepare(
    'INSERT INTO schedules (name, agent, prompt, cron, enabled, next_run, notify_url, creator_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(input.name, input.agent, input.prompt, input.cron,
    input.enabled === false ? 0 : 1, next.toISOString(), input.notifyUrl || null,
    input.creatorId || '', input.workspaceId || '')
  return Number(info.lastInsertRowid)
}

export function listSchedules(limit = 50, opts: OwnerOpts = {}): Schedule[] {
  const d = getDb()
  if (!d) return []
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.creatorId !== undefined) {
    conditions.push("(creator_id = ? OR creator_id = '')")
    params.push(opts.creatorId)
  }
  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return d.prepare(`SELECT * FROM schedules ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Schedule[]
}

export function getSchedule(id: number, opts: OwnerOpts = {}): Schedule | null {
  const d = getDb()
  if (!d) return null
  const row = (opts.creatorId !== undefined
    ? d.prepare("SELECT * FROM schedules WHERE id = ? AND (creator_id = ? OR creator_id = '')")
        .get(id, opts.creatorId)
    : d.prepare('SELECT * FROM schedules WHERE id = ?').get(id)) as Schedule | undefined
  return row || null
}

export function deleteSchedule(id: number, opts: OwnerOpts = {}): boolean {
  const d = getDb()
  if (!d) return false
  if (opts.creatorId !== undefined) {
    return d.prepare("DELETE FROM schedules WHERE id = ? AND (creator_id = ? OR creator_id = '')")
      .run(id, opts.creatorId).changes > 0
  }
  return d.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0
}

export function setEnabled(id: number, enabled: boolean, opts: OwnerOpts = {}): boolean {
  const d = getDb()
  if (!d) return false
  if (opts.creatorId !== undefined) {
    return d.prepare(
      "UPDATE schedules SET enabled = ? WHERE id = ? AND (creator_id = ? OR creator_id = '')"
    ).run(enabled ? 1 : 0, id, opts.creatorId).changes > 0
  }
  return d.prepare('UPDATE schedules SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id).changes > 0
}

/** Find schedules whose next_run is at or before `now` and are enabled. */
function dueSchedules(d: Database.Database, now: Date): Schedule[] {
  return d.prepare(
    "SELECT * FROM schedules WHERE enabled = 1 AND next_run <= ?"
  ).all(now.toISOString()) as Schedule[]
}

/**
 * Execute a single scheduled run: create a Job, kick it off through Job
 * Board (which honors the concurrency cap), bump next_run.
 */
async function fireSchedule(s: Schedule, logger: Logger): Promise<void> {
  const d = getDb()
  if (!d) return

  const agent = registry.findAgent(s.agent)
  if (!agent) {
    logger.warn({ scheduleId: s.id, agent: s.agent }, 'Schedule agent not registered, skipping')
    return
  }

  const jobId = createJob(s.agent, s.prompt, {
    creatorId: s.creator_id,
    workspaceId: s.workspace_id,
  })
  logger.info({ scheduleId: s.id, jobId, name: s.name }, 'Schedule fired')

  // Compute next_run BEFORE running so even a long-running job doesn't
  // block the next tick.
  try {
    const nextSpec = parseCron(s.cron)
    const next = nextOccurrence(nextSpec, new Date())
    if (next) {
      d.prepare('UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?')
        .run(new Date().toISOString(), next.toISOString(), s.id)
    }
  } catch {
    // Bad cron at this point would only happen if it was edited externally.
    // Disable rather than re-fire forever.
    d.prepare('UPDATE schedules SET enabled = 0 WHERE id = ?').run(s.id)
  }

  // Run via Job Board so the result is persisted + bounded concurrency.
  void runJob(jobId, async function* (job, _jobLogger, signal) {
    if (agent instanceof AgentBase) {
      const text = await agent.spawnAndCollect(job.prompt, signal)
      if (text) yield text
    } else {
      for await (const chunk of agent.sendPrompt(`schedule-${s.id}-${jobId}`, job.prompt, [])) {
        if (signal.aborted) break
        yield chunk
      }
    }
  }, logger).then(async () => {
    if (!s.notify_url) return
    // Defense in depth: re-validate at fire time in case the row was edited
    // out-of-band (manual SQL, future v0.x importer) — never trust DB content
    // as an authorization bypass for the SSRF gate.
    const v = validateWebhookUrl(s.notify_url)
    if (!v.ok) {
      logger.warn({ scheduleId: s.id, reason: v.reason, event: 'schedule.notify.rejected' },
        'Schedule notify webhook rejected by URL validator')
      return
    }
    try {
      const job = (await import('./job-board.js')).getJob(jobId)
      if (!job) return
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), NOTIFY_TIMEOUT_MS)
      try {
        const resp = await fetch(v.url.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scheduleId: s.id,
            jobId,
            status: job.status,
            result: job.result,
            error: job.error,
          }),
          signal: ctrl.signal,
          // Drop redirects so a 30x can't pivot us back to a private host.
          redirect: 'manual',
        })
        // Drain (capped) so the connection can be reused / closed cleanly.
        if (resp.body) {
          let read = 0
          const reader = resp.body.getReader()
          while (read < NOTIFY_MAX_RESPONSE_BYTES) {
            const { done, value } = await reader.read()
            if (done) break
            read += value?.byteLength ?? 0
          }
          await reader.cancel().catch(() => {})
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      logger.warn({ scheduleId: s.id, err: err instanceof Error ? err.message : String(err) },
        'Schedule notify webhook failed')
    }
  }).catch(() => { /* runJob already logged */ })
}

/** Run one tick — exposed for tests so they don't have to wait for setInterval. */
export async function tick(now: Date = new Date()): Promise<number> {
  const d = getDb()
  if (!d) return 0
  const due = dueSchedules(d, now)
  for (const s of due) {
    await fireSchedule(s, log).catch((err) => {
      log.error({ scheduleId: s.id, err: err instanceof Error ? err.message : String(err) },
        'fireSchedule threw')
    })
  }
  return due.length
}

/** Start the periodic ticker. Idempotent. */
export function startScheduler(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => { void tick() }, TICK_INTERVAL_MS)
  if (typeof tickTimer === 'object' && tickTimer && 'unref' in tickTimer) {
    (tickTimer as { unref: () => void }).unref()
  }
  log.info({ tickMs: TICK_INTERVAL_MS }, 'Scheduler started')
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

/** Close the underlying SQLite handle. Called by cli.ts on graceful
 *  shutdown so the WAL is checkpointed before exit (L2). */
export function closeScheduleDb(): void {
  helper.close()
}
