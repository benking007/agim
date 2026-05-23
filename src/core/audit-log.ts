// Audit log — lightweight invocation tracking via SQLite
//
// Schema: one row per agent invocation with trace id, user, platform, cost, duration etc.
// Reuses the traceId from structured logging.

import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { recordInvocation, recordAuditPruneFailure } from './metrics.js'
import { eventBus } from './event-bus.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { AGIM_HOME } from './agim-paths.js'

const log = rootLogger.child({ component: 'audit-log' })

const AUDIT_DB = join(AGIM_HOME, 'audit.db')

/** Default number of days to keep audit rows. Override via env. */
function resolveRetentionDays(): number {
  const raw = process.env.IM_HUB_AUDIT_RETENTION_DAYS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 30
}

/** R12 ⑤ — events table retention. Default 180d is GDPR-friendly and
 *  satisfies 等保 2.0 三级 (≥ 6 months). 0 = permanent. */
function resolveAuditEventsRetentionDays(): number {
  const raw = process.env.IMHUB_AUDIT_EVENTS_RETENTION_DAYS
  if (raw === undefined) return 180
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 180
  return n
}

/** How often to run the retention sweep (epoch-ms). 0 disables. */
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6 hours

let sweepTimer: ReturnType<typeof setInterval> | null = null

const helper = createSqliteHelper({
  file: AUDIT_DB,
  component: 'audit-log',
  logger: rootLogger,
  schema: `
    CREATE TABLE IF NOT EXISTS invocations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id  TEXT    NOT NULL,
      ts        TEXT    NOT NULL DEFAULT (datetime('now')),
      user_id   TEXT    NOT NULL DEFAULT '',
      platform  TEXT    NOT NULL DEFAULT '',
      agent     TEXT    NOT NULL,
      intent    TEXT    NOT NULL DEFAULT 'default',
      prompt_len INTEGER NOT NULL DEFAULT 0,
      response_len INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      cost      REAL    NOT NULL DEFAULT 0.0,
      success   INTEGER NOT NULL DEFAULT 1,
      error     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inv_ts ON invocations(ts);
    CREATE INDEX IF NOT EXISTS idx_inv_agent ON invocations(agent);
    CREATE INDEX IF NOT EXISTS idx_inv_trace ON invocations(trace_id);
    CREATE INDEX IF NOT EXISTS idx_inv_user ON invocations(user_id);
    CREATE INDEX IF NOT EXISTS idx_inv_platform ON invocations(platform);
    CREATE INDEX IF NOT EXISTS idx_inv_intent ON invocations(intent);

    -- R12 ⑤ — persistent audit table for governance events (approvals,
    -- admin elevations, config / env / token / workspace mutations).
    -- Separate from invocations because retention requirements differ
    -- (compliance asks for ≥ 6 months on access-control events; calls
    -- are typically 30 days).
    CREATE TABLE IF NOT EXISTS audit_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT    NOT NULL DEFAULT (datetime('now')),
      trace_id   TEXT    NOT NULL DEFAULT '',
      event_type TEXT    NOT NULL,
      actor      TEXT    NOT NULL DEFAULT '',
      target     TEXT    NOT NULL DEFAULT '',
      outcome    TEXT    NOT NULL DEFAULT 'ok',
      details    TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor);
  `,
  init: (d) => {
    pruneExpired(d)
    pruneExpiredEvents(d)
    if (RETENTION_SWEEP_INTERVAL_MS > 0 && sweepTimer === null) {
      sweepTimer = setInterval(() => {
        const live = helper.get()
        if (!live) return
        pruneExpired(live)
        pruneExpiredEvents(live)
      }, RETENTION_SWEEP_INTERVAL_MS)
      if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
        (sweepTimer as { unref: () => void }).unref()
      }
    }
  },
})

function getDb(): Database.Database | null {
  return helper.get()
}

export interface AuditRecord {
  traceId: string
  userId: string
  platform: string
  agent: string
  intent: string
  promptLen: number
  responseLen: number
  durationMs: number
  cost: number
  success: boolean
  error?: string
}

export function logInvocation(rec: AuditRecord): void {
  // Always update in-memory metrics first so /api/metrics works even when
  // the SQLite layer is degraded (e.g. bun runtime, disk full).
  recordInvocation({
    agent: rec.agent,
    intent: rec.intent,
    platform: rec.platform,
    durationMs: rec.durationMs,
    cost: rec.cost,
    success: rec.success,
  })

  // Real-time fan-out for the dashboard's SSE consumer. Best-effort —
  // event-bus swallows listener errors so a buggy subscriber can't break
  // the audit hot path.
  eventBus.publish({
    type: 'audit',
    ts: new Date().toISOString(),
    agent: rec.agent,
    intent: rec.intent,
    platform: rec.platform,
    durationMs: rec.durationMs,
    cost: rec.cost,
    success: rec.success,
    traceId: rec.traceId,
    userId: rec.userId,
  })

  const d = getDb()
  if (!d) return
  try {
    const stmt = d.prepare(`
      INSERT INTO invocations (trace_id, user_id, platform, agent, intent, prompt_len, response_len, duration_ms, cost, success, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(rec.traceId, rec.userId, rec.platform, rec.agent, rec.intent,
      rec.promptLen, rec.responseLen, rec.durationMs, rec.cost,
      rec.success ? 1 : 0, rec.error || null)
  } catch {
    // Best-effort logging; never fail the request because of audit IO
  }
}

export interface QueryOpts {
  limit?: number
  agent?: string
  platform?: string
  userId?: string
  intent?: string
  days?: number
}

export interface InvocationRow {
  id: number
  trace_id: string
  ts: string
  user_id: string
  platform: string
  agent: string
  intent: string
  prompt_len: number
  response_len: number
  duration_ms: number
  cost: number
  success: number
  error: string | null
}

export function queryInvocations(opts: QueryOpts = {}): InvocationRow[] {
  const d = getDb()
  if (!d) return []
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  if (opts.platform) { conditions.push('platform = ?'); params.push(opts.platform) }
  if (opts.userId) { conditions.push('user_id = ?'); params.push(opts.userId) }
  if (opts.intent) { conditions.push('intent = ?'); params.push(opts.intent) }
  if (opts.days && Number.isFinite(opts.days) && opts.days > 0) {
    conditions.push("ts >= datetime('now', ?)")
    params.push(`-${Math.floor(opts.days)} days`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rawLimit = opts.limit
  const limit = Number.isFinite(rawLimit) && rawLimit! > 0 ? Math.min(Math.floor(rawLimit!), 1000) : 20

  try {
    return d.prepare(`SELECT * FROM invocations ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as InvocationRow[]
  } catch {
    return []
  }
}

/**
 * Delete rows older than the retention window. Returns number of deleted
 * rows so callers / tests can assert behavior.
 */
export function pruneExpired(d: Database.Database = getDb()!): number {
  if (!d) return 0
  const days = resolveRetentionDays()
  try {
    const info = d.prepare("DELETE FROM invocations WHERE ts < datetime('now', ?)")
      .run(`-${days} days`)
    if (info.changes > 0) {
      log.info({ event: 'audit-log.pruned', deleted: info.changes, days },
        `Pruned ${info.changes} audit row(s) older than ${days}d`)
    }
    return info.changes
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ event: 'audit-log.prune.failed', error: msg }, 'audit-log retention sweep failed')
    // M7: surface as Prometheus counter so a stuck retention loop becomes
    // observable beyond a stderr warn line. Alert on any non-zero rate.
    recordAuditPruneFailure()
    return 0
  }
}

// ─── R12 ⑤ — Governance audit events ────────────────────────────────
//
// A second table in the same audit.db captures 6 categories of high-
// risk control-plane events that previously only hit pino stdout. With
// systemd-journald restart, those events vanished — making post-hoc
// "who promoted X to admin?" or "which token revoked the wechat hook?"
// impossible to answer beyond the live journal window.
//
// Design contract:
//   - `details` is a small JSON blob: field names, lengths, hash prefixes
//     only. NEVER put plaintext credentials, prompt bodies, or PII here.
//     The injection sites are responsible for stripping; this layer just
//     persists what it's given.
//   - Schema is fixed (no extra columns) — query by event_type + actor
//     + time range covers every audit need we have.
//   - Retention is separate from invocations (IMHUB_AUDIT_EVENTS_RETENTION_DAYS,
//     default 180d). 0 = permanent.

export type AuditEventType =
  | 'approval.allow'
  | 'approval.deny'
  | 'admin.elevate'
  | 'admin.revoke'
  | 'config.put'
  | 'env.put'
  | 'token.create'
  | 'token.revoke'
  | 'workspace.add'
  | 'workspace.delete'
  // D+ Stage 1 follow-up — notification-evaluator gate (#9 in the D+
  // plan). Only suppressions are audited; deliveries are visible in
  // outbox / invocations rows anyway, so logging both would just inflate
  // audit_events without adding signal.
  | 'notification.suppress'

export interface AuditEvent {
  traceId?: string
  eventType: AuditEventType
  actor: string                          // platform:userId or 'system'
  target?: string                        // affected object (token id, workspace name, etc.)
  outcome?: 'ok' | 'denied' | 'error'
  details?: Record<string, unknown>      // sanitized — field names + lengths + hash prefixes only
}

export interface AuditEventRow {
  id: number
  ts: string
  trace_id: string
  event_type: string
  actor: string
  target: string
  outcome: string
  details: string  // JSON-encoded; caller can JSON.parse if it wants the object back
}

export function logAuditEvent(ev: AuditEvent): void {
  const d = getDb()
  if (!d) return
  try {
    const detailsJson = JSON.stringify(ev.details ?? {})
    d.prepare(`
      INSERT INTO audit_events (trace_id, event_type, actor, target, outcome, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      ev.traceId ?? '',
      ev.eventType,
      ev.actor,
      ev.target ?? '',
      ev.outcome ?? 'ok',
      detailsJson,
    )
  } catch (err) {
    // Best-effort — audit logging must never break the caller's request.
    log.warn({ event: 'audit-events.write_failed', err: String(err) })
  }
}

export interface AuditEventQueryOpts {
  types?: AuditEventType[]
  actor?: string
  days?: number
  limit?: number
}

export function queryAuditEvents(opts: AuditEventQueryOpts = {}): AuditEventRow[] {
  const d = getDb()
  if (!d) return []
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.types && opts.types.length > 0) {
    const placeholders = opts.types.map(() => '?').join(',')
    conditions.push(`event_type IN (${placeholders})`)
    params.push(...opts.types)
  }
  if (opts.actor) { conditions.push('actor = ?'); params.push(opts.actor) }
  if (opts.days && Number.isFinite(opts.days) && opts.days > 0) {
    conditions.push("ts >= datetime('now', ?)")
    params.push(`-${Math.floor(opts.days)} days`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rawLimit = opts.limit
  const limit = Number.isFinite(rawLimit) && rawLimit! > 0 ? Math.min(Math.floor(rawLimit!), 1000) : 100
  try {
    return d.prepare(`SELECT * FROM audit_events ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as AuditEventRow[]
  } catch {
    return []
  }
}

export function pruneExpiredEvents(d: Database.Database = getDb()!): number {
  if (!d) return 0
  const days = resolveAuditEventsRetentionDays()
  if (days <= 0) return 0
  try {
    const info = d.prepare("DELETE FROM audit_events WHERE ts < datetime('now', ?)")
      .run(`-${days} days`)
    if (info.changes > 0) {
      log.info({ event: 'audit-events.pruned', deleted: info.changes, days },
        `Pruned ${info.changes} audit event row(s) older than ${days}d`)
    }
    return info.changes
  } catch (err) {
    log.warn({ event: 'audit-events.prune.failed', error: String(err) })
    return 0
  }
}

/** Stop the periodic retention sweep (used by tests and graceful shutdown). */
export function stopRetentionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

/** Close the underlying SQLite handle. Pairs with stopRetentionSweep on
 *  graceful shutdown so WAL is checkpointed cleanly (L2). */
export function closeAuditDb(): void {
  helper.close()
}

// ─── v1.3 — Cost & Health aggregations ─────────────────────────────────
//
// Shared SQL helpers backing /api/health/*. All accept a `days` window
// (relative to now()) and return small JSON-friendly objects.

function safeDays(d: number): number {
  if (!Number.isFinite(d) || d <= 0) return 7
  return Math.min(Math.floor(d), 365)
}

/**
 * Top-line metrics for a recent window: total calls, total cost, error
 * rate, average + p95 latency. Used by /api/health/summary's KPI cards.
 */
export interface HealthSummary {
  since: string
  until: string
  days: number
  totals: {
    calls: number
    cost: number
    errors: number
    errorRate: number
    avgLatencyMs: number
    p95LatencyMs: number
  }
  byDay: Array<{ date: string; calls: number; cost: number; errors: number; avgLatencyMs: number }>
}

export function getHealthSummary(days: number): HealthSummary {
  const window = safeDays(days)
  const now = new Date()
  const until = now.toISOString().slice(0, 10)
  const since = new Date(now.getTime() - window * 86400_000).toISOString().slice(0, 10)
  const empty: HealthSummary = {
    since, until, days: window,
    totals: { calls: 0, cost: 0, errors: 0, errorRate: 0, avgLatencyMs: 0, p95LatencyMs: 0 },
    byDay: [],
  }
  const d = getDb()
  if (!d) return empty
  try {
    const tot = d.prepare(`
      SELECT
        COUNT(*) AS calls,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(AVG(duration_ms), 0) AS avg_latency
      FROM invocations
      WHERE ts >= datetime('now', ?)
    `).get(`-${window} days`) as { calls: number; cost: number; errors: number; avg_latency: number }

    // p95 — pull all latencies (capped) into JS for percentile calc. For
    // huge tables this is suboptimal; switch to per-bucket histogram later.
    const lats = d.prepare(`
      SELECT duration_ms FROM invocations
      WHERE ts >= datetime('now', ?) AND duration_ms > 0
      ORDER BY duration_ms ASC LIMIT 100000
    `).all(`-${window} days`) as Array<{ duration_ms: number }>
    let p95 = 0
    if (lats.length > 0) {
      const idx = Math.max(0, Math.floor(lats.length * 0.95) - 1)
      p95 = lats[idx].duration_ms
    }

    const dayRows = d.prepare(`
      SELECT
        substr(ts, 1, 10) AS date,
        COUNT(*) AS calls,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(AVG(duration_ms), 0) AS avg_latency
      FROM invocations
      WHERE ts >= datetime('now', ?)
      GROUP BY date
      ORDER BY date ASC
    `).all(`-${window} days`) as Array<{ date: string; calls: number; cost: number; errors: number; avg_latency: number }>

    return {
      since, until, days: window,
      totals: {
        calls: tot.calls,
        cost: Math.round(tot.cost * 10000) / 10000,
        errors: tot.errors,
        errorRate: tot.calls > 0 ? Math.round((tot.errors / tot.calls) * 10000) / 10000 : 0,
        avgLatencyMs: Math.round(tot.avg_latency),
        p95LatencyMs: p95,
      },
      byDay: dayRows.map((r) => ({
        date: r.date,
        calls: r.calls,
        cost: Math.round(r.cost * 10000) / 10000,
        errors: r.errors,
        avgLatencyMs: Math.round(r.avg_latency),
      })),
    }
  } catch (err) {
    log.warn({ event: 'audit-log.summary_failed', err: String(err) })
    return empty
  }
}

export type TopNDim = 'user' | 'agent' | 'platform' | 'intent'
export type TopNMetric = 'cost' | 'calls' | 'errors' | 'avg_latency'

export interface TopNItem {
  key: string
  calls: number
  cost: number
  errors: number
  avgLatencyMs: number
}

/**
 * Top-N grouped by `dim`, sorted by `metric` desc. Used to surface
 * "which users / agents / platforms drove the most cost / errors".
 */
export function getTopN(dim: TopNDim, metric: TopNMetric, days: number, limit: number = 10): TopNItem[] {
  const window = safeDays(days)
  const lim = Math.min(Math.max(Math.floor(limit), 1), 100)
  const d = getDb()
  if (!d) return []
  const col = ({ user: 'user_id', agent: 'agent', platform: 'platform', intent: 'intent' } as const)[dim]
  const orderCol = ({
    cost: 'SUM(cost)',
    calls: 'COUNT(*)',
    errors: 'SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END)',
    avg_latency: 'AVG(duration_ms)',
  } as const)[metric]
  try {
    const rows = d.prepare(`
      SELECT
        ${col} AS key,
        COUNT(*) AS calls,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(AVG(duration_ms), 0) AS avg_latency
      FROM invocations
      WHERE ts >= datetime('now', ?)
      GROUP BY ${col}
      ORDER BY ${orderCol} DESC
      LIMIT ?
    `).all(`-${window} days`, lim) as Array<{ key: string; calls: number; cost: number; errors: number; avg_latency: number }>
    return rows.map((r) => ({
      key: r.key || '(empty)',
      calls: r.calls,
      cost: Math.round(r.cost * 10000) / 10000,
      errors: r.errors,
      avgLatencyMs: Math.round(r.avg_latency),
    }))
  } catch (err) {
    log.warn({ event: 'audit-log.topn_failed', err: String(err) })
    return []
  }
}

export function getStats(): { total: number; byAgent: Record<string, number>; totalCost: number } {
  const d = getDb()
  if (!d) return { total: 0, byAgent: {}, totalCost: 0 }
  try {
    const total = (d.prepare('SELECT COUNT(*) as n FROM invocations').get() as { n: number }).n
    const rows = d.prepare('SELECT agent, COUNT(*) as n, SUM(cost) as total_cost FROM invocations GROUP BY agent').all() as Array<{ agent: string; n: number; total_cost: number | null }>
    const byAgent: Record<string, number> = {}
    let totalCost = 0
    for (const r of rows) {
      byAgent[r.agent] = r.n
      totalCost += r.total_cost || 0
    }
    return { total, byAgent, totalCost }
  } catch {
    return { total: 0, byAgent: {}, totalCost: 0 }
  }
}
