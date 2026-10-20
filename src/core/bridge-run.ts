// Inbound bridge runs — one production job per accepted call.
//
// Phase 1 is poll-only. The side table records callback_status='none'
// and nothing is enqueued. A later phase owns signing, delivery, and
// the callback worker; this module does not start one.
//
// The jobs state machine stays in job-board. runJob owns pending →
// running → completed/failed/cancelled. A bridge timeout throws
// `bridge_timeout` instead of aborting runJob's controller, because
// aborting that controller is the cancel path.

import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { A2A_TIMEOUT_MS_DEFAULT, A2A_TIMEOUT_MS_MAX } from './a2a.js'
import { logInvocation } from './audit-log.js'
import { enqueueBridgeStarted, enqueueBridgeTerminal, noteBridgeProgress } from './bridge-callback.js'
import { findPeerById, type BridgePeer } from './bridge-peers.js'
import { createLogger, generateTraceId } from './logger.js'
import {
  abortChildJobsForParentTurn,
  getJob,
  runJob,
  withJobsDatabase,
  type Job,
} from './job-board.js'
import { routeMessage, type RouteContext } from './router.js'
import type { ParsedMessage } from './types.js'
import { isBridgeEnabled } from './bridge-switch.js'
import { workspaceRegistry } from './workspace.js'

export const BRIDGE_PROMPT_MAX_CODE_POINTS = 32_000
export const BRIDGE_TIMEOUT_ERROR = 'bridge_timeout'

export { isBridgeEnabled }

export type BridgeCallbackStatus = 'none' | 'pending' | 'sending' | 'delivered' | 'giving_up'

export interface BridgeRunRow {
  job_id: number
  run_id: string
  direction: 'inbound' | 'outbound'
  peer_id: string
  idempotency_key: string
  remote_job_id: number | null
  correlation_id: string | null
  callback_status: BridgeCallbackStatus
  wait_reason: string | null
  timeout_at: string | null
  last_event_seq: number
}

/** Shape attached to GET /api/jobs/:id. Column names, no secrets. */
export type BridgeJobView = BridgeRunRow

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
`

function ensureSchema(db: import('better-sqlite3').Database): void {
  db.exec(SCHEMA)
}

function mapRow(row: Record<string, unknown>): BridgeRunRow {
  return {
    job_id: Number(row.job_id),
    run_id: String(row.run_id),
    direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
    peer_id: String(row.peer_id),
    idempotency_key: String(row.idempotency_key),
    remote_job_id: row.remote_job_id == null ? null : Number(row.remote_job_id),
    correlation_id: row.correlation_id == null ? null : String(row.correlation_id),
    callback_status: (typeof row.callback_status === 'string'
      ? row.callback_status
      : 'none') as BridgeCallbackStatus,
    wait_reason: row.wait_reason == null || row.wait_reason === '' ? null : String(row.wait_reason),
    timeout_at: row.timeout_at == null ? null : String(row.timeout_at),
    last_event_seq: Number(row.last_event_seq) || 0,
  }
}

export function codePointLength(text: string): number {
  let n = 0
  for (const _ of text) n += 1
  return n
}

/** Clamp a caller timeout onto the A2A wall clock. `0` is rejected by the API. */
export function clampBridgeTimeoutMs(requested: number | undefined): number {
  if (requested == null) return A2A_TIMEOUT_MS_DEFAULT
  return Math.min(requested, A2A_TIMEOUT_MS_MAX)
}

/**
 * The pinned workspace must be the one routeMessage will actually use.
 * routeMessage resolves from the peer id; if that is a different workspace,
 * the pin failed and the caller is refused before a job row exists.
 */
export function bridgeWorkspacePinned(peerId: string, workspaceId: string): boolean {
  if (!workspaceId) return false
  if (!workspaceRegistry.get(workspaceId)) return false
  return workspaceRegistry.resolve(peerId).id === workspaceId
}

export function getBridgeRunByJobId(jobId: number): BridgeRunRow | null {
  return withJobsDatabase((db) => {
    ensureSchema(db)
    const row = db.prepare('SELECT * FROM bridge_runs WHERE job_id = ?').get(jobId) as
      | Record<string, unknown>
      | undefined
    return row ? mapRow(row) : null
  })
}

export function getBridgeRunByRunId(runId: string): BridgeRunRow | null {
  return withJobsDatabase((db) => {
    ensureSchema(db)
    const row = db.prepare('SELECT * FROM bridge_runs WHERE run_id = ?').get(runId) as
      | Record<string, unknown>
      | undefined
    return row ? mapRow(row) : null
  })
}

export interface AcceptBridgeRunInput {
  peer: BridgePeer
  agent: string
  prompt: string
  idempotencyKey: string
  correlationId: string | null
  timeoutMs: number
  createJob: (agent: string, prompt: string, opts: {
    kind: 'job'
    creatorId: string
    workspaceId: string
    threadKey: string
    callDepth: number
  }) => number
}

export type AcceptBridgeRunResult =
  | { created: true; row: BridgeRunRow; job: Job }
  | { created: false; row: BridgeRunRow; job: Job }

/**
 * Insert the job and the side row in one immediate transaction.
 * A concurrent duplicate idempotency key rolls back the losing job
 * insert and returns the winner. The loser does not call runJob.
 */
export function acceptBridgeRun(input: AcceptBridgeRunInput): AcceptBridgeRunResult {
  const outcome = withJobsDatabase((db) => {
    ensureSchema(db)
    const select = db.prepare(
      'SELECT * FROM bridge_runs WHERE peer_id = ? AND idempotency_key = ?',
    )
    const insert = db.prepare(
      `INSERT INTO bridge_runs (
         job_id, run_id, direction, peer_id, idempotency_key, remote_job_id,
         correlation_id, callback_status, wait_reason, timeout_at, last_event_seq
       ) VALUES (?, ?, 'inbound', ?, ?, NULL, ?, 'none', NULL, ?, 0)`,
    )
    const tx = db.transaction(() => {
      const existing = select.get(input.peer.peerId, input.idempotencyKey) as
        | Record<string, unknown>
        | undefined
      if (existing) return { created: false as const, row: mapRow(existing) }
      const runId = randomUUID()
      const timeoutAt = new Date(Date.now() + input.timeoutMs).toISOString()
      const jobId = input.createJob(input.agent, input.prompt, {
        kind: 'job',
        creatorId: input.peer.peerId,
        workspaceId: input.peer.workspaceId,
        threadKey: `bridge:${input.peer.peerId}:${runId}`,
        callDepth: 0,
      })
      insert.run(
        jobId,
        runId,
        input.peer.peerId,
        input.idempotencyKey,
        input.correlationId,
        timeoutAt,
      )
      const row = select.get(input.peer.peerId, input.idempotencyKey) as Record<string, unknown>
      return { created: true as const, row: mapRow(row) }
    })
    return tx.immediate()
  })
  if (!outcome) throw new Error('Job board unavailable (SQLite not initialized)')
  const job = getJob(outcome.row.job_id)
  if (!job) throw new Error('bridge run has no job row')
  return { created: outcome.created, row: outcome.row, job }
}

const inflightByPeer = new Map<string, Set<number>>()

export function resetBridgeInflightForTests(): void {
  inflightByPeer.clear()
}

function peerInflight(peerId: string): Set<number> {
  let set = inflightByPeer.get(peerId)
  if (!set) {
    set = new Set()
    inflightByPeer.set(peerId, set)
  }
  return set
}

function listPendingInbound(peerId: string): BridgeRunRow[] {
  const rows = withJobsDatabase((db) => {
    ensureSchema(db)
    return db.prepare(
      `SELECT * FROM bridge_runs
        WHERE peer_id = ? AND direction = 'inbound'
        ORDER BY job_id ASC`,
    ).all(peerId) as Array<Record<string, unknown>>
  }) ?? []
  return rows.map(mapRow).filter((row) => getJob(row.job_id)?.status === 'pending')
}

function pumpPeer(peerId: string): void {
  const peer = findPeerById(peerId)
  if (!peer?.enabled) return
  for (const row of listPendingInbound(peerId)) {
    const set = inflightByPeer.get(peerId)
    if (set && set.size >= peer.maxConcurrent) return
    startBridgeRun(row.job_id)
  }
}

/** Start the run when this peer still has a free concurrency slot. */
export function startBridgeRun(jobId: number): void {
  const row = getBridgeRunByJobId(jobId)
  if (row?.direction !== 'inbound') return
  const peer = findPeerById(row.peer_id)
  if (!peer?.enabled) return
  const job = getJob(jobId)
  if (job?.status !== 'pending') return
  const set = peerInflight(peer.peerId)
  if (set.has(jobId)) return
  if (set.size >= peer.maxConcurrent) return
  set.add(jobId)
  const logger = createLogger({ component: 'bridge-run', jobId, runId: row.run_id })
  void runJob(
    jobId,
    (current, runLogger, signal) => executeBridgeJob(current, row, runLogger, signal),
    logger,
  ).finally(() => {
    try { enqueueBridgeTerminal(jobId) } catch { /* callback failure does not change the job */ }
    set.delete(jobId)
    if (set.size === 0) inflightByPeer.delete(peer.peerId)
    pumpPeer(peer.peerId)
  })
}

/** After process start, continue inbound rows that are still pending. */
export function resumePendingBridgeRuns(): void {
  if (!isBridgeEnabled()) return
  const peerIds = withJobsDatabase((db) => {
    ensureSchema(db)
    return db.prepare(
      `SELECT DISTINCT peer_id AS peer_id FROM bridge_runs WHERE direction = 'inbound'`,
    ).all() as Array<{ peer_id: string }>
  }) ?? []
  for (const row of peerIds) pumpPeer(row.peer_id)
}

async function* iterateRoute(
  routed: string | AsyncGenerator<string>,
): AsyncGenerator<string> {
  if (typeof routed === 'string') {
    if (routed) yield routed
    return
  }
  yield* routed
}

function bridgeThreadId(runId: string): string {
  return `bridge-${runId}`
}

function stopChildJobs(peerId: string, runId: string): void {
  try {
    abortChildJobsForParentTurn('bridge', peerId, bridgeThreadId(runId))
  } catch { /* best-effort; the parent signal is already aborted */ }
}

async function* executeBridgeJob(
  job: Job,
  row: BridgeRunRow,
  logger: Logger,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const started = Date.now()
  const traceId = generateTraceId()
  let responseLen = 0
  let success = false
  let error: string | undefined
  let timedOut = false
  const routeAbort = new AbortController()
  const onAbort = () => { routeAbort.abort() }
  if (signal.aborted) routeAbort.abort()
  else signal.addEventListener('abort', onAbort)

  const deadline = Date.parse(row.timeout_at || '')
  const remaining = Number.isFinite(deadline) ? deadline - Date.now() : 0
  let timer: ReturnType<typeof setTimeout> | null = null
  if (remaining <= 0) timedOut = true
  else {
    timer = setTimeout(() => {
      timedOut = true
      routeAbort.abort()
    }, remaining)
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
  }

  const ctx: RouteContext = {
    channelId: row.peer_id,
    threadId: bridgeThreadId(row.run_id),
    platform: 'bridge',
    defaultAgent: job.agent,
    traceId,
    logger,
    userId: row.peer_id,
    parentJobId: job.id,
    callDepth: 0,
    signal: routeAbort.signal,
  }
  const parsed: ParsedMessage = { type: 'agent', agent: job.agent, prompt: job.prompt }
  try { enqueueBridgeStarted(job.id) } catch { /* callback failure does not change the job */ }

  try {
    if (timedOut && !signal.aborted) {
      stopChildJobs(row.peer_id, row.run_id)
      error = BRIDGE_TIMEOUT_ERROR
      throw new Error(BRIDGE_TIMEOUT_ERROR)
    }
    const routed = await routeMessage(parsed, ctx)
    for await (const chunk of iterateRoute(routed)) {
      if (signal.aborted || timedOut) break
      responseLen += chunk.length
      if (chunk.trim()) {
        try { noteBridgeProgress(job.id) } catch { /* progress must not change the job */ }
      }
      yield chunk
    }
    if (signal.aborted || timedOut) {
      stopChildJobs(row.peer_id, row.run_id)
      if (signal.aborted) return
      error = BRIDGE_TIMEOUT_ERROR
      throw new Error(BRIDGE_TIMEOUT_ERROR)
    }
    const outcome = ctx.agentOutcome
    if (outcome && outcome.status !== 'success' && outcome.status !== 'partial') {
      error = outcome.error || outcome.status || 'bridge_agent_error'
      throw new Error(error)
    }
    success = true
  } catch (err) {
    if (signal.aborted) {
      stopChildJobs(row.peer_id, row.run_id)
      return
    }
    if (timedOut) {
      stopChildJobs(row.peer_id, row.run_id)
      error = BRIDGE_TIMEOUT_ERROR
      throw new Error(BRIDGE_TIMEOUT_ERROR)
    }
    if (!error) error = err instanceof Error ? err.message : String(err)
    throw err instanceof Error ? err : new Error(error)
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    try {
      logInvocation({
        traceId,
        userId: row.peer_id,
        platform: 'bridge',
        agent: job.agent,
        intent: 'bridge',
        promptLen: job.prompt.length,
        responseLen,
        durationMs: Date.now() - started,
        cost: 0,
        success,
        error,
      })
    } catch { /* audit failure must not change the job outcome */ }
  }
}
