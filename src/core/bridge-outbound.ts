// Dev-side Agim as a bridge caller.
//
// Creates a local kind=job row first, POSTs that prompt to production, then
// advances the local row from GET (authoritative) or from run.started.
// A peer with no signing secret is poll-only. The production token and
// signing secret stay in bridge-peers.json and are never written onto the job.

import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  findOutboundTarget,
  type BridgeOutboundTarget,
} from './bridge-peers.js'
import { signBridgePayload } from './bridge-callback.js'
import {
  cancelJob,
  createJob,
  getJob,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
  withJobsDatabase,
} from './job-board.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'bridge-outbound' })

const TIMESTAMP_WINDOW_SEC = 300
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bridge_runs (
    job_id            INTEGER PRIMARY KEY,
    run_id            TEXT    NOT NULL UNIQUE,
    direction         TEXT    NOT NULL,
    peer_id           TEXT    NOT NULL,
    idempotency_key   TEXT    NOT NULL,
    remote_job_id     INTEGER,
    correlation_id    TEXT,
    callback_status   TEXT    NOT NULL DEFAULT 'none',
    wait_reason       TEXT,
    timeout_at        TEXT,
    last_event_seq    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (peer_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS bridge_outbound_inbox (
    event_id   TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event_type TEXT NOT NULL
  );
`

export class BridgeOutboundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeOutboundError'
  }
}

interface OutboundRow {
  job_id: number
  run_id: string
  peer_id: string
  idempotency_key: string
  remote_job_id: number | null
  correlation_id: string | null
  last_event_seq: number
}

interface RemoteRun {
  runId: string
  jobId: number
  status: string
  agent: string
  result: string | null
  error: string | null
}

export interface StartOutboundInput {
  peerId: string
  agent: string
  prompt: string
  idempotencyKey: string
  correlationId?: string
  timeoutMs?: number
}

export interface OutboundRunHandle {
  jobId: number
  runId: string | null
  remoteJobId: number | null
  status: string
}

function withDb<T>(fn: (db: import('better-sqlite3').Database) => T): T | null {
  return withJobsDatabase((db) => {
    db.exec(SCHEMA)
    return fn(db)
  })
}

function isPlaceholder(runId: string): boolean {
  return runId.startsWith('pending:')
}

function visibleKey(raw: string): boolean {
  if (raw.length < 1 || raw.length > 128) return false
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

function mapRow(row: Record<string, unknown>): OutboundRow {
  return {
    job_id: Number(row.job_id),
    run_id: String(row.run_id),
    peer_id: String(row.peer_id),
    idempotency_key: String(row.idempotency_key),
    remote_job_id: row.remote_job_id == null ? null : Number(row.remote_job_id),
    correlation_id: row.correlation_id == null ? null : String(row.correlation_id),
    last_event_seq: Number(row.last_event_seq) || 0,
  }
}

function existingOutbound(db: import('better-sqlite3').Database, peerId: string, key: string): OutboundRow | null {
  const row = db.prepare(
    `SELECT * FROM bridge_runs
      WHERE direction = 'outbound' AND peer_id = ? AND idempotency_key = ?`,
  ).get(peerId, key) as Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

function handleOf(row: OutboundRow): OutboundRunHandle {
  const job = getJob(row.job_id)
  return {
    jobId: row.job_id,
    runId: isPlaceholder(row.run_id) ? null : row.run_id,
    remoteJobId: row.remote_job_id,
    status: job?.status || 'pending',
  }
}

async function postRemote(
  target: BridgeOutboundTarget,
  input: StartOutboundInput,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const payload: Record<string, unknown> = { agent: input.agent, prompt: input.prompt }
  if (input.timeoutMs !== undefined) payload.timeoutMs = input.timeoutMs
  if (input.correlationId) payload.correlationId = input.correlationId
  let response: Response
  try {
    response = await fetch(`${target.baseUrl}/api/bridge/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token}`,
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    log.warn({ event: 'bridge-outbound.post_failed', peerId: target.peerId, err: err instanceof Error ? err.message : 'network' },
      'outbound POST failed')
    return { status: 0, body: null }
  }
  let body: Record<string, unknown> | null = null
  try {
    const parsed = await response.json() as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch { /* empty or non-json */ }
  return { status: response.status, body }
}

async function getRemote(target: BridgeOutboundTarget, runId: string): Promise<RemoteRun | null> {
  let response: Response
  try {
    response = await fetch(`${target.baseUrl}/api/bridge/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${target.token}` },
    })
  } catch (err) {
    log.warn({ event: 'bridge-outbound.get_failed', peerId: target.peerId, err: err instanceof Error ? err.message : 'network' },
      'outbound GET failed')
    return null
  }
  if (!response.ok) return null
  let body: Record<string, unknown>
  try {
    body = await response.json() as Record<string, unknown>
  } catch {
    return null
  }
  const error = body.error
  return {
    runId: String(body.runId || runId),
    jobId: Number(body.jobId),
    status: String(body.status || ''),
    agent: String(body.agent || ''),
    result: typeof body.result === 'string' ? body.result : null,
    error: typeof error === 'string' ? error : null,
  }
}

function applyRemote(jobId: number, remote: RemoteRun): void {
  const job = getJob(jobId)
  if (!job) return
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return
  if (remote.status === 'running') {
    if (job.status === 'pending') markJobRunning(jobId)
    return
  }
  if (remote.status === 'completed') {
    markJobCompleted(jobId, remote.result || '')
    return
  }
  if (remote.status === 'failed') {
    markJobFailed(jobId, remote.error || 'bridge_agent_error')
    return
  }
  if (remote.status === 'cancelled') cancelJob(jobId)
}

function rememberRemote(
  db: import('better-sqlite3').Database,
  row: OutboundRow,
  runId: string,
  remoteJobId: number,
): void {
  db.prepare(
    `UPDATE bridge_runs SET run_id = ?, remote_job_id = ? WHERE job_id = ?`,
  ).run(runId, remoteJobId, row.job_id)
  db.prepare(`UPDATE jobs SET thread_key = ? WHERE id = ?`).run(`bridge:${row.peer_id}:${runId}`, row.job_id)
}

/** Create the local job, then POST. The same idempotency key never creates a second row. */
export async function startOutboundRun(input: StartOutboundInput): Promise<OutboundRunHandle> {
  const target = findOutboundTarget(input.peerId)
  if (!target) throw new BridgeOutboundError('outbound peer not found')
  if (!input.agent || !target.agents.includes(input.agent)) {
    throw new BridgeOutboundError('agent is not in the outbound allowlist')
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    throw new BridgeOutboundError('prompt is required')
  }
  if (!visibleKey(input.idempotencyKey)) {
    throw new BridgeOutboundError('idempotency key must be 1–128 visible ASCII characters')
  }
  const existing = withDb((db) => existingOutbound(db, input.peerId, input.idempotencyKey))
  if (existing) return handleOf(existing)

  const jobId = createJob(input.agent, input.prompt, {
    kind: 'job',
    creatorId: input.peerId,
    callDepth: 0,
    threadKey: `bridge:${input.peerId}:pending`,
  })
  const placeholder = `pending:${randomUUID()}`
  const inserted = withDb((db) => {
    db.prepare(
      `INSERT INTO bridge_runs (
         job_id, run_id, direction, peer_id, idempotency_key, remote_job_id,
         correlation_id, callback_status, wait_reason, timeout_at, last_event_seq
       ) VALUES (?, ?, 'outbound', ?, ?, NULL, ?, 'none', NULL, NULL, 0)`,
    ).run(jobId, placeholder, input.peerId, input.idempotencyKey, input.correlationId || null)
    return existingOutbound(db, input.peerId, input.idempotencyKey)
  })
  if (!inserted) throw new BridgeOutboundError('failed to record outbound run')
  await submitOutbound(inserted, target, input)
  const after = withDb((db) => existingOutbound(db, input.peerId, input.idempotencyKey))
  return handleOf(after || inserted)
}

async function submitOutbound(row: OutboundRow, target: BridgeOutboundTarget, input: StartOutboundInput): Promise<void> {
  const posted = await postRemote(target, input)
  if (posted.status === 202 || posted.status === 200) {
    const runId = typeof posted.body?.runId === 'string' ? posted.body.runId : ''
    const remoteJobId = Number(posted.body?.jobId)
    if (!runId || !Number.isFinite(remoteJobId)) return
    withDb((db) => rememberRemote(db, row, runId, remoteJobId))
    return
  }
  if (posted.status >= 400 && posted.status < 500) {
    markJobFailed(row.job_id, `bridge_rejected: HTTP ${posted.status}`)
  }
}

/** One poll pass. GET is the terminal authority. Safe to call from tests. */
export async function pollOutboundRuns(): Promise<number> {
  const rows = withDb((db) => db.prepare(
    `SELECT * FROM bridge_runs WHERE direction = 'outbound'`,
  ).all() as Array<Record<string, unknown>>) ?? []
  let n = 0
  for (const raw of rows) {
    const row = mapRow(raw)
    const job = getJob(row.job_id)
    if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') continue
    const target = findOutboundTarget(row.peer_id)
    if (!target) continue
    if (isPlaceholder(row.run_id)) {
      await submitOutbound(row, target, {
        peerId: row.peer_id,
        agent: job.agent,
        prompt: job.prompt,
        idempotencyKey: row.idempotency_key,
        correlationId: row.correlation_id || undefined,
      })
      n += 1
      continue
    }
    const remote = await getRemote(target, row.run_id)
    if (!remote) continue
    applyRemote(row.job_id, remote)
    n += 1
  }
  return n
}

function signaturesMatch(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = signBridgePayload(secret, timestamp, rawBody)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] || '' : value || ''
}

/**
 * Caller callback endpoint. 401 on a bad timestamp or signature.
 * Terminal state is copied from GET, not from the event body.
 * Returns 204 when the notice is accepted, including duplicates.
 */
export async function applyOutboundCallback(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<204 | 401 | 500> {
  const timestamp = headerValue(headers, 'x-agim-bridge-timestamp')
  const signature = headerValue(headers, 'x-agim-bridge-signature')
  const eventHeader = headerValue(headers, 'x-agim-bridge-event')
  const stamp = Number(timestamp)
  if (!Number.isFinite(stamp) || Math.abs(Math.floor(Date.now() / 1000) - stamp) > TIMESTAMP_WINDOW_SEC) {
    return 401
  }
  let parsed: {
    specVersion?: number
    eventId?: string
    type?: string
    seq?: number
    runId?: string
    peerId?: string
    status?: string
  }
  try {
    parsed = JSON.parse(rawBody) as typeof parsed
  } catch {
    return 204
  }
  const peer = parsed.peerId ? findOutboundTarget(parsed.peerId) : null
  if (!peer?.signingSecret || !signaturesMatch(peer.signingSecret, timestamp, rawBody, signature)) return 401
  if (parsed.specVersion !== 1 || !parsed.eventId || !parsed.runId || eventHeader !== parsed.type) return 204
  const eventId = parsed.eventId
  const runId = parsed.runId
  const seq = Number(parsed.seq) || 0
  const eventType = parsed.type || ''
  const seen = withDb((db) => db.prepare(
    'SELECT event_id FROM bridge_outbound_inbox WHERE event_id = ?',
  ).get(eventId))
  if (seen) return 204

  const row = withDb((db) => {
    const found = db.prepare(
      `SELECT * FROM bridge_runs WHERE direction = 'outbound' AND run_id = ?`,
    ).get(runId) as Record<string, unknown> | undefined
    return found ? mapRow(found) : null
  })
  if (!row) return 204
  const job = getJob(row.job_id)
  if (!job) return 204
  const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
  if (terminal && (eventType === 'run.started' || seq < row.last_event_seq)) {
    withDb((db) => {
      db.prepare(
        `INSERT OR IGNORE INTO bridge_outbound_inbox (event_id, run_id, seq, event_type) VALUES (?, ?, ?, ?)`,
      ).run(eventId, runId, seq, eventType)
    })
    return 204
  }
  if (eventType === 'run.completed' || eventType === 'run.failed' || eventType === 'run.cancelled') {
    const remote = await getRemote(peer, runId)
    if (!remote) return 500
    applyRemote(row.job_id, remote)
  } else if (eventType === 'run.started' && job.status === 'pending') {
    markJobRunning(row.job_id)
  }
  withDb((db) => {
    db.prepare(
      `INSERT OR IGNORE INTO bridge_outbound_inbox (event_id, run_id, seq, event_type) VALUES (?, ?, ?, ?)`,
    ).run(eventId, runId, seq, eventType)
    if (seq > row.last_event_seq) {
      db.prepare('UPDATE bridge_runs SET last_event_seq = ? WHERE job_id = ?').run(seq, row.job_id)
    }
  })
  return 204
}

let poller: ReturnType<typeof setInterval> | null = null

export function startOutboundPoller(): void {
  if (poller) return
  poller = setInterval(() => {
    void pollOutboundRuns().catch((err) => {
      log.warn({ event: 'bridge-outbound.poll_failed', err: err instanceof Error ? err.message : 'poll' },
        'outbound poll failed')
    })
  }, 5000)
  if (typeof poller === 'object' && poller && 'unref' in poller) poller.unref()
}

export function stopOutboundPollerForTests(): void {
  if (!poller) return
  clearInterval(poller)
  poller = null
}
