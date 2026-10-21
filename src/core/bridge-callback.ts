// Callbacks for inbound bridge runs (phase 2).
//
// The queue lives in jobs.db, not outbox.db. Delivery copies the outbox
// lease and backoff: pending → sending → delivered, or giving_up.
// A poll-only peer (no callback URL) never gets a row. The job's own
// status is not changed when delivery gives up.
//
// Each POST authenticates with Authorization: Bearer <peer key>.
// Retries reuse the stored body and the same eventId.

import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { eventBus } from './event-bus.js'
import { effectiveCallbackMode, findPeerById, validateBridgeCallbackUrl } from './bridge-peers.js'
import { getJob, withJobsDatabase, type Job } from './job-board.js'
import { logger as rootLogger } from './logger.js'
import { scheduleBridgeMcpFinished } from './bridge-mcp-events.js'
import { scrubOutboundText } from './sensitive-paths.js'

const log = rootLogger.child({ component: 'bridge-callback' })

/** Same schedule as the IM outbox. Six attempts, then giving_up. */
export const BRIDGE_CALLBACK_BACKOFF_SECONDS = [1, 5, 30, 300, 1800, 7200] as const
export const BRIDGE_CALLBACK_MAX_ATTEMPTS = BRIDGE_CALLBACK_BACKOFF_SECONDS.length
export const BRIDGE_CALLBACK_TIMEOUT_MS = 10_000
const RESULT_MAX_CODE_POINTS = 32_000
const ERROR_MESSAGE_MAX_CODE_POINTS = 500
const RESTART_ERROR = 'agim restarted while running'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bridge_callbacks (
    id              INTEGER PRIMARY KEY,
    event_id        TEXT    NOT NULL UNIQUE,
    run_id          TEXT    NOT NULL,
    job_id          INTEGER NOT NULL,
    peer_id         TEXT    NOT NULL,
    event_type      TEXT    NOT NULL,
    seq             INTEGER NOT NULL,
    body            TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error      TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`

export type BridgeCallbackType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.waiting_approval'
  | 'run.progress'

const PROGRESS_MIN_INTERVAL_MS = 10_000
const lastProgressAt = new Map<string, number>()
let bridgeNow = (): number => Date.now()

/** Test hook. Production uses the wall clock and a 10 second gap. */
export function __setBridgeClockForTests(fn: (() => number) | null): void {
  bridgeNow = fn ?? (() => Date.now())
  if (!fn) lastProgressAt.clear()
}

interface CallbackRow {
  id: number
  event_id: string
  run_id: string
  job_id: number
  peer_id: string
  event_type: string
  seq: number
  body: string
  status: string
  attempts: number
}

interface RunRef {
  run_id: string
  job_id: number
  peer_id: string
  idempotency_key: string
  correlation_id: string | null
  last_event_seq: number
}

function sliceCodePoints(text: string, max: number): { text: string; truncated: boolean } {
  let count = 0
  let index = 0
  for (const ch of text) {
    if (count === max) return { text: text.slice(0, index), truncated: true }
    count += 1
    index += ch.length
  }
  return { text, truncated: false }
}

function parseJobTime(value: string | null): number | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : null
}

function errorCode(eventType: BridgeCallbackType, jobError: string | null): string {
  if (eventType === 'run.cancelled') return 'bridge_cancelled'
  const msg = jobError || ''
  if (msg === 'bridge_timeout' || msg.startsWith('bridge_timeout')) return 'bridge_timeout'
  if (msg === RESTART_ERROR) return 'bridge_restarted'
  if (msg === 'bridge_rejected' || msg.startsWith('bridge_rejected')) return 'bridge_rejected'
  return 'bridge_agent_error'
}

function eventTypeForStatus(status: string): BridgeCallbackType | null {
  if (status === 'completed') return 'run.completed'
  if (status === 'failed') return 'run.failed'
  if (status === 'cancelled') return 'run.cancelled'
  return null
}

function buildBody(run: RunRef, job: Job, eventType: BridgeCallbackType, eventId: string, seq: number): string {
  const emittedAt = new Date().toISOString()
  const payload: Record<string, unknown> = {
    specVersion: 1,
    eventId,
    type: eventType,
    seq,
    emittedAt,
    runId: run.run_id,
    jobId: run.job_id,
    peerId: run.peer_id,
    idempotencyKey: run.idempotency_key,
    agent: job.agent,
    status: job.status,
  }
  if (run.correlation_id) payload.correlationId = run.correlation_id
  if (eventType === 'run.waiting_approval' || eventType === 'run.progress') {
    payload.status = 'running'
  }
  if (eventType === 'run.completed') {
    const raw = job.result || ''
    const sliced = sliceCodePoints(raw, RESULT_MAX_CODE_POINTS)
    const marker = raw.includes('[agim: result truncated')
    payload.result = sliced.text
    payload.resultTruncated = sliced.truncated || marker
  }
  if (eventType === 'run.failed') {
    const message = sliceCodePoints(job.error || '', ERROR_MESSAGE_MAX_CODE_POINTS).text
    payload.error = { code: errorCode(eventType, job.error), message }
  }
  const started = parseJobTime(job.started_at)
  const completed = parseJobTime(job.completed_at)
  if (eventType !== 'run.started' && started != null && completed != null && completed >= started) {
    payload.durationMs = completed - started
  }
  return scrubOutboundText(JSON.stringify(payload)).text
}

function refreshStatus(db: import('better-sqlite3').Database, runId: string): void {
  const rows = db.prepare(
    'SELECT status FROM bridge_callbacks WHERE run_id = ?',
  ).all(runId) as Array<{ status: string }>
  let status = 'none'
  if (rows.some((row) => row.status === 'sending')) status = 'sending'
  else if (rows.some((row) => row.status === 'pending')) status = 'pending'
  else if (rows.some((row) => row.status === 'giving_up')) status = 'giving_up'
  else if (rows.length > 0 && rows.every((row) => row.status === 'delivered')) status = 'delivered'
  db.prepare('UPDATE bridge_runs SET callback_status = ? WHERE run_id = ?').run(status, runId)
}

function loadRun(db: import('better-sqlite3').Database, jobId: number): RunRef | null {
  const row = db.prepare(
    `SELECT run_id, job_id, peer_id, idempotency_key, correlation_id, last_event_seq
       FROM bridge_runs WHERE job_id = ? AND direction = 'inbound'`,
  ).get(jobId) as RunRef | undefined
  return row ?? null
}

function insertEvent(
  db: import('better-sqlite3').Database,
  run: RunRef,
  job: Job,
  eventType: BridgeCallbackType,
): void {
  const peer = findPeerById(run.peer_id)
  if (!peer?.enabled || effectiveCallbackMode(peer) !== 'webhook' || !peer.callbackUrl || !peer.signingSecret) return
  const once = eventType !== 'run.progress' && eventType !== 'run.waiting_approval'
  if (once) {
    const existing = db.prepare(
      'SELECT id FROM bridge_callbacks WHERE run_id = ? AND event_type = ?',
    ).get(run.run_id, eventType)
    if (existing) return
  }
  const seq = Number(run.last_event_seq) + 1
  const eventId = randomUUID()
  const body = buildBody(run, job, eventType, eventId, seq)
  db.prepare(
    `INSERT INTO bridge_callbacks (
       event_id, run_id, job_id, peer_id, event_type, seq, body, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(eventId, run.run_id, run.job_id, run.peer_id, eventType, seq, body)
  db.prepare(
    'UPDATE bridge_runs SET last_event_seq = ? WHERE run_id = ?',
  ).run(seq, run.run_id)
  run.last_event_seq = seq
  refreshStatus(db, run.run_id)
}

function relaxSingletonUnique(db: import('better-sqlite3').Database): void {
  const indexes = db.prepare('PRAGMA index_list(bridge_callbacks)').all() as Array<{ name: string; unique: number }>
  const hasPair = indexes.some((index) => {
    if (!index.unique) return false
    const safe = index.name.replace(/'/g, "''")
    const cols = db.prepare(`PRAGMA index_info('${safe}')`).all() as Array<{ name: string }>
    const names = cols.map((col) => col.name)
    return names.includes('run_id') && names.includes('event_type')
  })
  if (!hasPair) return
  db.exec(`
    CREATE TABLE bridge_callbacks_v2 (
      id              INTEGER PRIMARY KEY,
      event_id        TEXT    NOT NULL UNIQUE,
      run_id          TEXT    NOT NULL,
      job_id          INTEGER NOT NULL,
      peer_id         TEXT    NOT NULL,
      event_type      TEXT    NOT NULL,
      seq             INTEGER NOT NULL,
      body            TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error      TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO bridge_callbacks_v2 (
      id, event_id, run_id, job_id, peer_id, event_type, seq, body, status,
      attempts, next_attempt_at, last_error, created_at
    )
    SELECT id, event_id, run_id, job_id, peer_id, event_type, seq, body, status,
           attempts, next_attempt_at, last_error, created_at
      FROM bridge_callbacks;
    DROP TABLE bridge_callbacks;
    ALTER TABLE bridge_callbacks_v2 RENAME TO bridge_callbacks;
  `)
}

function withCallbackDb<T>(fn: (db: import('better-sqlite3').Database) => T): T | null {
  return withJobsDatabase((db) => {
    db.exec(SCHEMA)
    relaxSingletonUnique(db)
    return fn(db)
  })
}

/** Queue run.started once the job is running. No-op for poll-only peers. */
export function enqueueBridgeStarted(jobId: number): void {
  try {
    withCallbackDb((db) => {
      const run = loadRun(db, jobId)
      const job = getJob(jobId)
      if (!run || !job || job.status !== 'running') return
      insertEvent(db, run, job, 'run.started')
    })
  } catch (err) {
    log.warn({ event: 'bridge-callback.enqueue_started_failed', jobId, err: String(err) },
      'failed to enqueue run.started')
  }
}

/** Queue the terminal event that matches the job row. Does not change the job. */
export function enqueueBridgeTerminal(jobId: number): void {
  const flag = { terminal: false }
  try {
    withCallbackDb((db) => {
      const run = loadRun(db, jobId)
      const job = getJob(jobId)
      if (!run || !job) return
      const eventType = eventTypeForStatus(job.status)
      if (!eventType) return
      flag.terminal = true
      insertEvent(db, run, job, eventType)
    })
  } catch (err) {
    log.warn({ event: 'bridge-callback.enqueue_terminal_failed', jobId, err: String(err) },
      'failed to enqueue terminal callback')
  }
  if (flag.terminal) scheduleBridgeMcpFinished(jobId)
}

/** Startup: a reaped running bridge job becomes run.failed / bridge_restarted. */
export function enqueueRestartedBridgeFailures(): number {
  const queued = withCallbackDb((db) => {
    const rows = db.prepare(
      `SELECT r.job_id AS job_id
         FROM bridge_runs r
         JOIN jobs j ON j.id = r.job_id
        WHERE r.direction = 'inbound'
          AND j.status = 'failed'
          AND j.error = ?`,
    ).all(RESTART_ERROR) as Array<{ job_id: number }>
    let n = 0
    for (const row of rows) {
      const before = db.prepare(
        `SELECT id FROM bridge_callbacks WHERE job_id = ? AND event_type = 'run.failed'`,
      ).get(row.job_id)
      enqueueBridgeTerminal(row.job_id)
      const after = db.prepare(
        `SELECT id FROM bridge_callbacks WHERE job_id = ? AND event_type = 'run.failed'`,
      ).get(row.job_id)
      if (!before && after) n += 1
    }
    return n
  })
  return queued ?? 0
}

function claim(db: import('better-sqlite3').Database, id: number): boolean {
  const info = db.prepare(
    `UPDATE bridge_callbacks
        SET status = 'sending'
      WHERE id = ? AND status = 'pending'`,
  ).run(id)
  return info.changes === 1
}

function dueRows(db: import('better-sqlite3').Database, limit: number): CallbackRow[] {
  return db.prepare(
    `SELECT id, event_id, run_id, job_id, peer_id, event_type, seq, body, status, attempts
       FROM bridge_callbacks
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
      ORDER BY seq ASC, id ASC
      LIMIT ?`,
  ).all(limit) as CallbackRow[]
}

export function requeueStuckBridgeCallbacks(): number {
  const n = withCallbackDb((db) => {
    const info = db.prepare(
      `UPDATE bridge_callbacks
          SET status = 'pending', next_attempt_at = datetime('now')
        WHERE status = 'sending'`,
    ).run()
    const runIds = db.prepare(
      `SELECT DISTINCT run_id AS run_id FROM bridge_callbacks`,
    ).all() as Array<{ run_id: string }>
    for (const row of runIds) refreshStatus(db, row.run_id)
    return info.changes
  })
  return n ?? 0
}

/** Test hook: deliver the same stored body and eventId again. */
export function requeueCallbackByEventIdForTests(eventId: string): boolean {
  const ok = withCallbackDb((db) => {
    const info = db.prepare(
      `UPDATE bridge_callbacks
          SET status = 'pending', next_attempt_at = datetime('now')
        WHERE event_id = ?`,
    ).run(eventId)
    const row = db.prepare(
      'SELECT run_id FROM bridge_callbacks WHERE event_id = ?',
    ).get(eventId) as { run_id: string } | undefined
    if (row) refreshStatus(db, row.run_id)
    return info.changes === 1
  })
  return ok === true
}

type SendResult = { status: number } | { networkError: string }

export interface DeliverOptions {
  caPem?: string
  /** Override the outbox backoff for this call. Production omits it. */
  backoffSeconds?: readonly number[]
  limit?: number
}

function postCallback(url: string, body: string, headers: Record<string, string>, caPem?: string): Promise<SendResult> {
  return new Promise((resolve) => {
    let target: URL
    try { target = new URL(url) } catch {
      resolve({ networkError: 'malformed URL' })
      return
    }
    const lib = target.protocol === 'https:' ? https : http
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: BRIDGE_CALLBACK_TIMEOUT_MS,
      rejectUnauthorized: true,
      ...(caPem ? { ca: caPem } : {}),
    }, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0 })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ networkError: 'timeout' })
    })
    req.on('error', (err) => resolve({ networkError: err.message }))
    req.end(body)
  })
}

function classifyHttp(status: number): 'delivered' | 'retry' | 'give_up' {
  if (status >= 200 && status < 300) return 'delivered'
  if (status === 408 || status === 429 || status >= 500) return 'retry'
  return 'give_up'
}

function markDelivered(db: import('better-sqlite3').Database, row: CallbackRow): void {
  db.prepare(
    `UPDATE bridge_callbacks
        SET status = 'delivered',
            attempts = attempts + 1,
            next_attempt_at = NULL,
            last_error = NULL
      WHERE id = ? AND status = 'sending'`,
  ).run(row.id)
  refreshStatus(db, row.run_id)
}

function markRetryOrGiveUp(
  db: import('better-sqlite3').Database,
  row: CallbackRow,
  reason: string,
  backoffSeconds: readonly number[],
  forceGiveUp: boolean,
): void {
  const nextAttempts = row.attempts + 1
  const giveUp = forceGiveUp || nextAttempts >= backoffSeconds.length
  if (giveUp) {
    db.prepare(
      `UPDATE bridge_callbacks
          SET status = 'giving_up',
              attempts = ?,
              next_attempt_at = NULL,
              last_error = ?
        WHERE id = ? AND status = 'sending'`,
    ).run(nextAttempts, reason.slice(0, 500), row.id)
  } else {
    const waitSec = backoffSeconds[nextAttempts - 1] ?? backoffSeconds[backoffSeconds.length - 1] ?? 1
    db.prepare(
      `UPDATE bridge_callbacks
          SET status = 'pending',
              attempts = ?,
              last_error = ?,
              next_attempt_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ? AND status = 'sending'`,
    ).run(nextAttempts, reason.slice(0, 500), String(waitSec), row.id)
  }
  refreshStatus(db, row.run_id)
}

function giveUpWithoutSend(db: import('better-sqlite3').Database, row: CallbackRow, reason: string): void {
  db.prepare(
    `UPDATE bridge_callbacks
        SET status = 'giving_up',
            last_error = ?,
            next_attempt_at = NULL
      WHERE id = ? AND status = 'sending'`,
  ).run(reason.slice(0, 500), row.id)
  refreshStatus(db, row.run_id)
}

/** Deliver callbacks that are due. Returns how many rows were claimed. */
export async function deliverDueCallbacks(opts: DeliverOptions = {}): Promise<number> {
  const backoff = opts.backoffSeconds ?? BRIDGE_CALLBACK_BACKOFF_SECONDS
  const picked = withCallbackDb((db) => dueRows(db, opts.limit ?? 20).filter((row) => claim(db, row.id))) ?? []
  for (const row of picked) {
    const peer = findPeerById(row.peer_id)
    if (!peer || effectiveCallbackMode(peer) !== 'webhook' || !peer.callbackUrl || !peer.signingSecret) {
      const reason = peer && effectiveCallbackMode(peer) === 'poll'
        ? 'callback mode is poll'
        : 'callback peer unavailable'
      withCallbackDb((db) => giveUpWithoutSend(db, row, reason))
      continue
    }
    const allowed = await validateBridgeCallbackUrl(peer.callbackUrl, peer.callbackPinnedHost)
    if (!allowed.ok) {
      withCallbackDb((db) => giveUpWithoutSend(db, row, 'callback target is not public'))
      continue
    }
    const result = await postCallback(peer.callbackUrl, row.body, {
      Authorization: `Bearer ${peer.signingSecret}`,
    }, opts.caPem)
    if ('networkError' in result) {
      withCallbackDb((db) => markRetryOrGiveUp(db, row, result.networkError, backoff, false))
      continue
    }
    const kind = classifyHttp(result.status)
    if (kind === 'delivered') withCallbackDb((db) => markDelivered(db, row))
    else withCallbackDb((db) => markRetryOrGiveUp(db, row, `HTTP ${result.status}`, backoff, kind === 'give_up'))
    log.info({
      event: 'bridge-callback.attempt',
      runId: row.run_id,
      eventType: row.event_type,
      httpStatus: result.status,
      disposition: kind,
    }, 'bridge callback attempt finished')
  }
  return picked.length
}

function enqueueObservable(jobId: number, eventType: 'run.waiting_approval' | 'run.progress'): void {
  withCallbackDb((db) => {
    const run = loadRun(db, jobId)
    const job = getJob(jobId)
    if (!run || !job || job.status !== 'running') return
    insertEvent(db, run, job, eventType)
  })
}

/**
 * Visible assistant text arrived. Empty text is ignored by the caller.
 * The text is not an argument: the contract has no summary field, so the
 * body stays on the common fields and cannot carry tool parameters.
 * The first note for a job always emits; later notes wait 10 seconds.
 */
export function noteBridgeProgress(jobId: number): void {
  try {
    const now = bridgeNow()
    const previous = lastProgressAt.get(String(jobId))
    if (previous != null && now - previous < PROGRESS_MIN_INTERVAL_MS) return
    lastProgressAt.set(String(jobId), now)
    enqueueObservable(jobId, 'run.progress')
  } catch (err) {
    log.warn({ event: 'bridge-callback.progress_failed', jobId, err: String(err) },
      'failed to enqueue run.progress')
  }
}

export function enqueueBridgeWaitingApproval(runId: string): void {
  if (!runId) return
  try {
    const jobId = withCallbackDb((db) => {
      const row = db.prepare(
        `SELECT job_id FROM bridge_runs WHERE run_id = ? AND direction = 'inbound'`,
      ).get(runId) as { job_id: number } | undefined
      return row?.job_id ?? 0
    }) ?? 0
    if (!jobId) return
    enqueueObservable(jobId, 'run.waiting_approval')
  } catch (err) {
    log.warn({ event: 'bridge-callback.waiting_approval_failed', err: String(err) },
      'failed to enqueue run.waiting_approval')
  }
}

let approvalListening = false

/** Top-level bridge approvals only. Tool name and input stay off the callback. */
export function ensureBridgeApprovalListener(): void {
  if (approvalListening) return
  approvalListening = true
  eventBus.on('event', (event: { type?: string; phase?: string; platform?: string; threadId?: string }) => {
    if (event.type !== 'approval' || event.phase !== 'requested') return
    if (event.platform !== 'bridge') return
    const threadId = event.threadId || ''
    if (!threadId.startsWith('bridge-')) return
    enqueueBridgeWaitingApproval(threadId.slice('bridge-'.length))
  })
}

let workerTimer: ReturnType<typeof setInterval> | null = null

export function startBridgeCallbackWorker(): void {
  if (workerTimer) return
  ensureBridgeApprovalListener()
  requeueStuckBridgeCallbacks()
  enqueueRestartedBridgeFailures()
  void deliverDueCallbacks().catch((err) => {
    log.warn({ event: 'bridge-callback.tick_failed', err: String(err) }, 'callback tick failed')
  })
  workerTimer = setInterval(() => {
    void deliverDueCallbacks().catch(() => { /* logged above on the next explicit call */ })
  }, 1000)
  if (typeof workerTimer === 'object' && workerTimer && 'unref' in workerTimer) workerTimer.unref()
}

export function stopBridgeCallbackWorkerForTests(): void {
  if (!workerTimer) return
  clearInterval(workerTimer)
  workerTimer = null
}
