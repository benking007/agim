// background-tasks-api — unified web REST surface for the three
// per-thread background primitives that previously had IM-only admin
// (P1 follow-up to Stage 6):
//
//   * heartbeat bindings  — `/api/heartbeat/*`
//   * goals               — `/api/goals/*`
//   * pending ask_user    — `/api/asks/pending`
//
// All three sit under one file so the dispatch + helper plumbing
// (json body parsing, status mapping) isn't triplicated across three
// modules. Each endpoint stays small — the routes are essentially
// thin wrappers around the core/* helpers that already exist.
//
// All endpoints are admin-gated upstream in server.ts because the
// data is global (cross-thread) and includes user-typed content.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  listAllBindings as listAllHeartbeats,
  enableBinding as enableHeartbeat,
  disableBinding as disableHeartbeat,
  updateInterval as updateHeartbeatInterval,
} from '../core/heartbeat-store.js'
import {
  listAllActiveGoals,
  listGoalsForThread,
  getGoalById,
  updateStatus as updateGoalStatus,
  type GoalStatus,
} from '../core/goals.js'
import {
  listPendingAsks,
  cancelPendingAsk,
} from '../core/ask-user-rpc.js'

// ─── HTTP helpers (mirrors llm-api + mcp-api shape) ─────────────────

function send(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw.trim()) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

// ─── dispatcher ─────────────────────────────────────────────────────

/**
 * Match-and-handle. Returns true when handled, false when the URL
 * didn't match any background-task endpoint.
 */
export async function handleBackgroundTasksApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  // ── heartbeat ──
  if (p === '/api/heartbeat/bindings' && m === 'GET') {
    await handleHeartbeatList(res); return true
  }
  const hbToggle = p.match(/^\/api\/heartbeat\/bindings\/(.+)\/(enable|disable)$/)
  if (hbToggle && m === 'POST') {
    await handleHeartbeatToggle(res, hbToggle[1], hbToggle[2] as 'enable' | 'disable'); return true
  }
  const hbInterval = p.match(/^\/api\/heartbeat\/bindings\/(.+)\/interval$/)
  if (hbInterval && m === 'PUT') {
    await handleHeartbeatInterval(req, res, hbInterval[1]); return true
  }

  // ── goals ──
  if (p === '/api/goals' && m === 'GET') {
    await handleGoalsList(res, url); return true
  }
  const goalById = p.match(/^\/api\/goals\/(\d+)$/)
  if (goalById && m === 'GET') {
    await handleGoalGet(res, Number(goalById[1])); return true
  }
  const goalStatus = p.match(/^\/api\/goals\/(\d+)\/status$/)
  if (goalStatus && m === 'PUT') {
    await handleGoalUpdateStatus(req, res, Number(goalStatus[1])); return true
  }

  // ── asks ──
  if (p === '/api/asks/pending' && m === 'GET') {
    await handleAsksList(res); return true
  }
  const askCancel = p.match(/^\/api\/asks\/pending\/(.+)\/cancel$/)
  if (askCancel && m === 'POST') {
    await handleAskCancel(res, askCancel[1]); return true
  }

  return false
}

// ─── heartbeat handlers ─────────────────────────────────────────────

async function handleHeartbeatList(res: ServerResponse): Promise<void> {
  const rows = listAllHeartbeats().map((r) => ({
    platform: r.platform,
    channelId: r.channelId,
    threadId: r.threadId,
    userId: r.userId,
    body: r.body,
    intervalMinutes: r.intervalMinutes,
    enabled: r.enabled,
    lastTickAt: r.lastTickAt,
    lastStatus: r.lastStatus,
    lastReason: r.lastReason,
    lastTextPreview: r.lastTextPreview,
    createdAt: r.createdAt,
  }))
  send(res, 200, { bindings: rows, count: rows.length })
}

/**
 * Toggle key is `platform:channelId:threadId` URL-encoded. Same
 * tri-key shape the heartbeat-store uses internally.
 */
function parseBindingKey(raw: string): { platform: string; channelId: string; threadId: string } | null {
  const parts = decodeURIComponent(raw).split(':')
  if (parts.length < 3) return null
  // threadId may itself contain ':' (e.g. Discord channel IDs). Re-join everything after the second ':'.
  const [platform, channelId, ...rest] = parts
  return { platform, channelId, threadId: rest.join(':') }
}

async function handleHeartbeatToggle(
  res: ServerResponse, rawKey: string, op: 'enable' | 'disable',
): Promise<void> {
  const key = parseBindingKey(rawKey)
  if (!key) { send(res, 400, { error: 'malformed key, expected platform:channelId:threadId' }); return }
  const ok = op === 'enable'
    ? enableHeartbeat(key.platform, key.channelId, key.threadId)
    : disableHeartbeat(key.platform, key.channelId, key.threadId)
  if (!ok) { send(res, 404, { error: 'binding not found' }); return }
  send(res, 200, { ...key, op, ok: true })
}

async function handleHeartbeatInterval(
  req: IncomingMessage, res: ServerResponse, rawKey: string,
): Promise<void> {
  const key = parseBindingKey(rawKey)
  if (!key) { send(res, 400, { error: 'malformed key' }); return }
  const body = await readJsonBody<{ intervalMin?: unknown }>(req)
  if (!body || typeof body.intervalMin !== 'number') {
    send(res, 400, { error: 'body.intervalMin (number) required' }); return
  }
  const ok = updateHeartbeatInterval(key.platform, key.channelId, key.threadId, body.intervalMin)
  if (!ok) { send(res, 404, { error: 'binding not found OR interval out of range' }); return }
  send(res, 200, { ...key, intervalMin: body.intervalMin })
}

// ─── goal handlers ──────────────────────────────────────────────────

async function handleGoalsList(res: ServerResponse, url: URL): Promise<void> {
  // ?platform=...&channelId=...&threadId=... narrows to one thread;
  // omit all three to get all-active (admin overview).
  const platform  = url.searchParams.get('platform')
  const channelId = url.searchParams.get('channelId')
  const threadId  = url.searchParams.get('threadId')
  if (platform && channelId && threadId) {
    const rows = listGoalsForThread(platform, channelId, threadId)
    send(res, 200, { goals: rows.map(sanitizeGoal), count: rows.length, scope: 'thread' })
    return
  }
  const rows = listAllActiveGoals()
  send(res, 200, { goals: rows.map(sanitizeGoal), count: rows.length, scope: 'all-active' })
}

async function handleGoalGet(res: ServerResponse, id: number): Promise<void> {
  const row = getGoalById(id)
  if (!row) { send(res, 404, { error: `no goal #${id}` }); return }
  send(res, 200, { goal: sanitizeGoal(row) })
}

async function handleGoalUpdateStatus(
  req: IncomingMessage, res: ServerResponse, id: number,
): Promise<void> {
  const body = await readJsonBody<{ status?: unknown }>(req)
  const raw = body?.status
  if (raw !== 'active' && raw !== 'paused' && raw !== 'completed' && raw !== 'cancelled') {
    send(res, 400, { error: 'body.status must be one of: active | paused | completed | cancelled' })
    return
  }
  const status: GoalStatus = raw
  const ok = updateGoalStatus(id, status)
  if (!ok) { send(res, 404, { error: `no goal #${id}` }); return }
  send(res, 200, { id, status })
}

function sanitizeGoal(g: ReturnType<typeof getGoalById> & object) {
  // Trim the per-row progress log so a noisy goal with 500 notes
  // doesn't blow the wire response — admin UI shows the latest N
  // anyway; full body lives at GET /:id.
  const MAX_NOTES = 10
  return {
    id: g.id,
    platform: g.platform,
    channelId: g.channelId,
    threadId: g.threadId,
    userId: g.userId,
    title: g.title,
    body: g.body,
    status: g.status,
    progressLog: g.progressLog.slice(-MAX_NOTES),
    progressCount: g.progressLog.length,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    closedAt: g.closedAt,
  }
}

// ─── ask handlers ───────────────────────────────────────────────────

async function handleAsksList(res: ServerResponse): Promise<void> {
  const rows = listPendingAsks()
  send(res, 200, { pending: rows, count: rows.length })
}

async function handleAskCancel(res: ServerResponse, rawReqId: string): Promise<void> {
  const reqId = decodeURIComponent(rawReqId)
  const ok = cancelPendingAsk(reqId, 'cancelled from admin panel')
  if (!ok) { send(res, 404, { error: 'no pending ask with that reqId' }); return }
  send(res, 200, { reqId, ok: true })
}
