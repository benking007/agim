// bridge-api — inbound production bridge (phase 1, poll only).
//
//   POST /api/bridge/runs
//   GET  /api/bridge/runs/:runId
//   POST /api/bridge/runs/:runId/cancel
//
// Disabled unless the admin switch (or AGIM_BRIDGE_ENABLED) is on. A bridge-scoped token is
// required even on loopback and even when AGIM_WEB_AUTH=off. Admin tokens
// are rejected. The caller's poll interval is not configured here.
//
// No callback is queued. callbackStatus stays `none`.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from '../core/logger.js'
import { registry } from '../core/registry.js'
import {
  findPeerByTokenId,
  type BridgePeer,
} from '../core/bridge-peers.js'
import {
  BRIDGE_PROMPT_MAX_CODE_POINTS,
  acceptBridgeRun,
  bridgeWorkspacePinned,
  clampBridgeTimeoutMs,
  codePointLength,
  getBridgeRunByRunId,
  isBridgeEnabled,
  startBridgeRun,
  type BridgeRunRow,
} from '../core/bridge-run.js'
import { extractToken } from './auth.js'
import { serveBridgeCallerGuide } from './bridge-caller-guide.js'
import { readBody, sendError, sendJson } from './http-utils.js'

const ALLOWED_FIELDS = new Set(['agent', 'prompt', 'timeoutMs', 'correlationId'])
const IDEMPOTENCY_MAX = 128
const CORRELATION_MAX = 128

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'NOT_FOUND', { message: 'not found' })
}

function unauthorized(res: ServerResponse): void {
  sendError(res, 401, 'AUTH_INVALID', { message: 'unauthorized' })
}

function forbidden(res: ServerResponse): void {
  sendError(res, 403, 'FORBIDDEN', { message: 'forbidden' })
}

async function authorize(
  req: IncomingMessage,
  url: URL,
): Promise<{ peer: BridgePeer } | { denied: 401 | 403 }> {
  const raw = extractToken(req, url)
  if (!raw) return { denied: 401 }
  const tokens = await import('../core/access-token.js')
  const id = tokens.verifyToken(raw)
  if (!id) return { denied: 401 }
  if (tokens.getTokenRole(id) !== 'bridge') return { denied: 403 }
  const peer = findPeerByTokenId(id)
  if (!peer?.enabled) return { denied: 403 }
  return { peer }
}

function sendDenied(res: ServerResponse, denied: 401 | 403): void {
  if (denied === 401) unauthorized(res)
  else forbidden(res)
}

function visibleIdempotencyKey(raw: string): string | null {
  const key = raw.trim()
  if (key.length < 1 || key.length > IDEMPOTENCY_MAX) return null
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return null
  }
  return key
}

function readIdempotencyKey(req: IncomingMessage): string | null {
  const header = req.headers?.['idempotency-key']
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw !== 'string') return null
  return visibleIdempotencyKey(raw)
}

function runBody(row: BridgeRunRow, job: { status: string; agent: string }) {
  return {
    ok: true,
    runId: row.run_id,
    jobId: row.job_id,
    status: job.status,
    agent: job.agent,
  }
}

export async function handleBridgeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  if (p !== '/api/bridge' && !p.startsWith('/api/bridge/')) return false
  const m = req.method ?? 'GET'
  if (p === '/api/bridge/caller-access' && m === 'GET') {
    serveBridgeCallerGuide(res)
    return true
  }
  if (!isBridgeEnabled()) {
    notFound(res)
    return true
  }
  if (p === '/api/bridge/runs' && m === 'POST') {
    await handleCreateRun(req, res, url)
    return true
  }
  if (p === '/api/bridge/callbacks' && m === 'POST') {
    await handleOutboundCallback(req, res)
    return true
  }
  const bridgeCancelMatch = p.match(/^\/api\/bridge\/runs\/([^/]+)\/cancel$/)
  if (bridgeCancelMatch && m === 'POST') {
    await handleCancelRun(req, res, url, decodeURIComponent(bridgeCancelMatch[1]))
    return true
  }
  const bridgeRunMatch = p.match(/^\/api\/bridge\/runs\/([^/]+)$/)
  if (bridgeRunMatch && m === 'GET') {
    await handleGetRun(req, res, url, decodeURIComponent(bridgeRunMatch[1]))
    return true
  }
  notFound(res)
  return true
}

async function handleOutboundCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readBody(req, res)
    const { applyOutboundCallback } = await import('../core/bridge-outbound.js')
    const status = await applyOutboundCallback(raw, req.headers || {})
    if (status === 401) unauthorized(res)
    else if (status === 500) sendError(res, 500, 'INTERNAL', { message: 'callback not applied' })
    else {
      res.writeHead(204)
      res.end()
    }
  } catch (err) {
    const handled = (err as { handled?: boolean }).handled
    if (handled || res.headersSent) return
    sendError(res, 500, 'INTERNAL', { message: 'callback not applied' })
  }
}

async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authorize(req, url)
  if ('denied' in auth) { sendDenied(res, auth.denied); return }
  const idempotencyKey = readIdempotencyKey(req)
  if (!idempotencyKey) {
    sendError(res, 400, 'VALIDATION', { message: 'Idempotency-Key must be 1–128 visible ASCII characters' })
    return
  }
  let parsed: Record<string, unknown>
  try {
    const body = await readBody(req, res)
    const value = JSON.parse(body || 'null') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      sendError(res, 400, 'VALIDATION', { message: 'JSON object required' })
      return
    }
    parsed = value as Record<string, unknown>
  } catch (err) {
    const handled = (err as { handled?: boolean }).handled
    if (handled || res.headersSent) return
    sendError(res, 400, 'VALIDATION', { message: 'Invalid JSON body' })
    return
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.has(key)) {
      sendError(res, 400, 'VALIDATION', { message: `field ${key} is not accepted` })
      return
    }
  }
  if (typeof parsed.agent !== 'string' || !parsed.agent.trim()) {
    sendError(res, 400, 'VALIDATION', { message: 'agent is required' })
    return
  }
  if (typeof parsed.prompt !== 'string' || parsed.prompt.trim().length === 0) {
    sendError(res, 400, 'VALIDATION', { message: 'prompt is required' })
    return
  }
  if (codePointLength(parsed.prompt) > BRIDGE_PROMPT_MAX_CODE_POINTS) {
    sendError(res, 400, 'VALIDATION', { message: 'prompt exceeds 32000 Unicode code points' })
    return
  }
  let timeoutMs = clampBridgeTimeoutMs(undefined)
  if (parsed.timeoutMs !== undefined) {
    if (typeof parsed.timeoutMs !== 'number' || !Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
      sendError(res, 400, 'VALIDATION', { message: 'timeoutMs must be a positive integer' })
      return
    }
    timeoutMs = clampBridgeTimeoutMs(parsed.timeoutMs)
  }
  let correlationId: string | null = null
  if (parsed.correlationId !== undefined) {
    if (typeof parsed.correlationId !== 'string' || codePointLength(parsed.correlationId) > CORRELATION_MAX) {
      sendError(res, 400, 'VALIDATION', { message: 'correlationId must be a string of at most 128 characters' })
      return
    }
    correlationId = parsed.correlationId.length > 0 ? parsed.correlationId : null
  }
  const agent = parsed.agent.trim()
  const peer = auth.peer
  if (!peer.agents.includes(agent)) {
    forbidden(res)
    return
  }
  if (!registry.findAgent(agent)) {
    forbidden(res)
    return
  }
  if (!bridgeWorkspacePinned(peer.peerId, peer.workspaceId)) {
    forbidden(res)
    return
  }
  try {
    const { createJob } = await import('../core/job-board.js')
    const accepted = acceptBridgeRun({
      peer,
      agent,
      prompt: parsed.prompt,
      idempotencyKey,
      correlationId,
      timeoutMs,
      createJob: (name, prompt, opts) => createJob(name, prompt, opts),
    })
    if (accepted.created) startBridgeRun(accepted.job.id)
    sendJson(res, accepted.created ? 202 : 200, runBody(accepted.row, accepted.job))
  } catch (err) {
    const handled = (err as { handled?: boolean }).handled
    if (handled || res.headersSent) return
    const log = createLogger({ component: 'bridge-api' })
    log.error({ event: 'bridge.create_failed', err: err instanceof Error ? err.message : String(err) },
      'bridge run create failed')
    sendError(res, 500, 'INTERNAL', { message: 'bridge run create failed' })
  }
}

function ownedRun(peer: BridgePeer, runId: string): BridgeRunRow | null {
  const row = getBridgeRunByRunId(runId)
  if (!row || row.peer_id !== peer.peerId || row.direction !== 'inbound') return null
  return row
}

async function handleGetRun(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runId: string,
): Promise<void> {
  const auth = await authorize(req, url)
  if ('denied' in auth) { sendDenied(res, auth.denied); return }
  const row = ownedRun(auth.peer, runId)
  if (!row) { notFound(res); return }
  const { getJob } = await import('../core/job-board.js')
  const job = getJob(row.job_id)
  if (!job) { notFound(res); return }
  const body: Record<string, unknown> = {
    ok: true,
    runId: row.run_id,
    jobId: row.job_id,
    status: job.status,
    agent: job.agent,
    result: job.result,
    error: job.error,
    callbackStatus: row.callback_status,
  }
  if (row.correlation_id) body.correlationId = row.correlation_id
  sendJson(res, 200, body)
}

async function handleCancelRun(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runId: string,
): Promise<void> {
  const auth = await authorize(req, url)
  if ('denied' in auth) { sendDenied(res, auth.denied); return }
  const row = ownedRun(auth.peer, runId)
  if (!row) { notFound(res); return }
  const { abortChildJobsForParentTurn, cancelJob, getJob } = await import('../core/job-board.js')
  const job = getJob(row.job_id)
  if (!job) { notFound(res); return }
  if (job.status === 'pending' || job.status === 'running') {
    cancelJob(row.job_id)
    abortChildJobsForParentTurn('bridge', row.peer_id, `bridge-${row.run_id}`)
  }
  sendJson(res, 200, { ok: true })
}
