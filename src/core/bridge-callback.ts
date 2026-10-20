// Signed callbacks for inbound bridge runs (phase 2).
//
// The queue lives in jobs.db, not outbox.db. Delivery copies the outbox
// lease and backoff: pending → sending → delivered, or giving_up.
// A poll-only peer (no callback URL) never gets a row. The job's own
// status is not changed when delivery gives up.
//
// The signed bytes are the stored body. Retries reuse that body and the
// same eventId; only the timestamp and signature are minted per attempt.

import { createHmac, randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { findPeerById, validateBridgeCallbackUrl } from './bridge-peers.js'
import { getJob, withJobsDatabase, type Job } from './job-board.js'
import { logger as rootLogger } from './logger.js'
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
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (run_id, event_type)
  );
`

export type BridgeCallbackType = 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled'

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

export function signBridgePayload(secret: string, timestampSec: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`, 'utf8').digest('hex')
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
  if (!peer?.enabled || !peer.callbackUrl || !peer.signingSecret) return
  const existing = db.prepare(
    'SELECT id FROM bridge_callbacks WHERE run_id = ? AND event_type = ?',
  ).get(run.run_id, eventType)
  if (existing) return
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

function withCallbackDb<T>(fn: (db: import('better-sqlite3').Database) => T): T | null {
  return withJobsDatabase((db) => {
    db.exec(SCHEMA)
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
  try {
    withCallbackDb((db) => {
      const run = loadRun(db, jobId)
      const job = getJob(jobId)
      if (!run || !job) return
      const eventType = eventTypeForStatus(job.status)
      if (!eventType) return
      insertEvent(db, run, job, eventType)
    })
  } catch (err) {
    log.warn({ event: 'bridge-callback.enqueue_terminal_failed', jobId, err: String(err) },
      'failed to enqueue terminal callback')
  }
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
    if (!peer?.callbackUrl || !peer.signingSecret) {
      withCallbackDb((db) => giveUpWithoutSend(db, row, 'callback peer unavailable'))
      continue
    }
    const allowed = await validateBridgeCallbackUrl(peer.callbackUrl, peer.callbackPinnedHost)
    if (!allowed.ok) {
      withCallbackDb((db) => giveUpWithoutSend(db, row, 'callback target is not public'))
      continue
    }
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = signBridgePayload(peer.signingSecret, timestamp, row.body)
    const result = await postCallback(peer.callbackUrl, row.body, {
      'X-Agim-Bridge-Timestamp': timestamp,
      'X-Agim-Bridge-Event': row.event_type,
      'X-Agim-Bridge-Signature': signature,
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

let workerTimer: ReturnType<typeof setInterval> | null = null

export function startBridgeCallbackWorker(): void {
  if (workerTimer) return
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
