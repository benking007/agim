// schedule-api — member-writable REST for cron schedules.
// GET /api/schedules stays on jobs-api.ts (per signed-in owner, including admins).
// Model / artifacts are NOT columns — Portal wraps them into `prompt`.
//
// Endpoints:
//   POST   /api/schedules              body { name, agent, cron, prompt, enabled? } → 201 { id }
//   PATCH  /api/schedules/:id          body { name?, agent?, cron?, prompt?, enabled? } → 200 { ok }
//   DELETE /api/schedules/:id          → 200 { ok }

import type { IncomingMessage, ServerResponse } from 'node:http'
import { registry } from '../core/registry.js'
import { parseCron } from '../core/cron.js'
import { readBody, sendJson, sendError } from './http-utils.js'
import { ownerIdIsAccount, requestOwnerId } from './member-scope.js'

/**
 * Match-and-handle dispatcher. Returns true when the request was served.
 */
export async function handleScheduleApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/schedules' && m === 'POST') {
    await handleCreate(req, res); return true
  }
  const scheduleIdMatch = p.match(/^\/api\/schedules\/(\d+)$/)
  if (scheduleIdMatch && m === 'PATCH') {
    await handlePatch(req, res, parseInt(scheduleIdMatch[1], 10)); return true
  }
  if (scheduleIdMatch && m === 'DELETE') {
    await handleDelete(req, res, parseInt(scheduleIdMatch[1], 10)); return true
  }
  return false
}

function asNonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ownerId = requestOwnerId(req)
  if (!ownerId) {
    sendError(res, 401, 'AUTH_REQUIRED', { message: 'login required' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse((await readBody(req, res)) || '{}') as Record<string, unknown>
  } catch {
    sendError(res, 400, 'BAD_BODY', { message: 'invalid JSON body' })
    return
  }
  const name = asNonEmptyString(body.name, 120)
  const agent = asNonEmptyString(body.agent, 64)
  const cron = asNonEmptyString(body.cron, 120)
  const prompt = asNonEmptyString(body.prompt, 32_000)
  if (!name || !agent || !cron || !prompt) {
    sendError(res, 400, 'BAD_BODY', { message: 'body { name, agent, cron, prompt } required' })
    return
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    sendError(res, 400, 'BAD_BODY', { message: 'enabled must be boolean' })
    return
  }
  if (!registry.findAgent(agent)) {
    sendError(res, 400, 'UNKNOWN_AGENT', { message: `unknown agent "${agent}"` })
    return
  }
  try { parseCron(cron) } catch (err) {
    sendError(res, 400, 'BAD_CRON', { message: err instanceof Error ? err.message : String(err) })
    return
  }
  try {
    const { createSchedule, getSchedule } = await import('../core/schedule.js')
    const id = createSchedule({
      name,
      agent,
      cron,
      prompt,
      enabled: body.enabled !== false,
      creatorId: ownerId,
    })
    sendJson(res, 201, { id, schedule: getSchedule(id) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.includes('unavailable') ? 503 : 400
    sendError(res, status, 'SCHEDULE_CREATE_FAILED', { message })
  }
}

async function loadOwned(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
): Promise<import('../core/schedule.js').Schedule | null> {
  if (!Number.isFinite(id) || id <= 0) {
    sendError(res, 400, 'BAD_ID', { message: 'invalid id' })
    return null
  }
  const { getSchedule } = await import('../core/schedule.js')
  const row = getSchedule(id)
  if (!row) {
    sendJson(res, 404, { error: 'not found' })
    return null
  }
  const ownerId = requestOwnerId(req)
  if (!ownerId) {
    sendError(res, 401, 'AUTH_REQUIRED', { message: 'login required' })
    return null
  }
  const creator = row.creator_id || ''
  const ownRow = creator === ownerId
    || (!creator && !ownerIdIsAccount(ownerId))
  if (!ownRow) {
    sendError(res, 403, 'FORBIDDEN', { message: 'not allowed' })
    return null
  }
  return row
}

async function handlePatch(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  const row = await loadOwned(req, res, id)
  if (!row) return
  let body: Record<string, unknown>
  try {
    body = JSON.parse((await readBody(req, res)) || '{}') as Record<string, unknown>
  } catch {
    sendError(res, 400, 'BAD_BODY', { message: 'invalid JSON body' })
    return
  }
  const patch: {
    name?: string
    agent?: string
    cron?: string
    prompt?: string
    enabled?: boolean
  } = {}
  if (body.name !== undefined) {
    const name = asNonEmptyString(body.name, 120)
    if (!name) { sendError(res, 400, 'BAD_BODY', { message: 'invalid name' }); return }
    patch.name = name
  }
  if (body.agent !== undefined) {
    const agent = asNonEmptyString(body.agent, 64)
    if (!agent) { sendError(res, 400, 'BAD_BODY', { message: 'invalid agent' }); return }
    if (!registry.findAgent(agent)) {
      sendError(res, 400, 'UNKNOWN_AGENT', { message: `unknown agent "${agent}"` })
      return
    }
    patch.agent = agent
  }
  if (body.cron !== undefined) {
    const cron = asNonEmptyString(body.cron, 120)
    if (!cron) { sendError(res, 400, 'BAD_BODY', { message: 'invalid cron' }); return }
    try { parseCron(cron) } catch (err) {
      sendError(res, 400, 'BAD_CRON', { message: err instanceof Error ? err.message : String(err) })
      return
    }
    patch.cron = cron
  }
  if (body.prompt !== undefined) {
    const prompt = asNonEmptyString(body.prompt, 32_000)
    if (!prompt) { sendError(res, 400, 'BAD_BODY', { message: 'invalid prompt' }); return }
    patch.prompt = prompt
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      sendError(res, 400, 'BAD_BODY', { message: 'enabled must be boolean' })
      return
    }
    patch.enabled = body.enabled
  }
  if (Object.keys(patch).length === 0) {
    sendError(res, 400, 'BAD_BODY', { message: 'empty patch' })
    return
  }
  try {
    const { updateSchedule, getSchedule } = await import('../core/schedule.js')
    const ok = updateSchedule(id, patch)
    if (!ok) { sendJson(res, 404, { error: 'not found' }); return }
    sendJson(res, 200, { ok: true, schedule: getSchedule(id) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendError(res, 400, 'SCHEDULE_UPDATE_FAILED', { message })
  }
}

async function handleDelete(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  const row = await loadOwned(req, res, id)
  if (!row) return
  const { deleteSchedule } = await import('../core/schedule.js')
  const ok = deleteSchedule(id)
  if (!ok) { sendJson(res, 404, { error: 'not found' }); return }
  sendJson(res, 200, { ok: true, id })
}
