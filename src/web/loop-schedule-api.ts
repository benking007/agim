// loop-schedule-api — Portal dock for scheduled Loop drafts.
//
// GET  /api/loop-schedule/pending
// POST /api/loop-schedule/confirm
// POST /api/loop-schedule/cancel

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  clearPendingLoopSchedule,
  getPendingLoopSchedule,
  setPendingLoopSchedule,
} from '../core/pending-loop-schedule.js'
import {
  commitPendingLoopSchedule,
  formatCreatedLoopScheduleReply,
  resolveScheduleTime,
} from '../core/loop-schedule-intent.js'
import { suggestLoopScheduleName } from '../core/loop-schedule-nl.js'
import { sessionManager } from '../core/session.js'
import { readBody, sendJson } from './http-utils.js'
import { getRequestUserId, isRequestAdmin } from './auth.js'
import { requireWebThreadAccess } from './member-scope.js'

function threadKeyOf(platform: string, channelId: string, threadId: string): string {
  return `${platform}:${channelId}:${threadId}`
}

function pendingDto(threadKey: string) {
  const p = getPendingLoopSchedule(threadKey)
  if (!p) return null
  return {
    name: p.name,
    cron: p.cron,
    cronLabel: p.cronLabel,
    timeText: p.timeText,
    objective: p.objective,
    exitDescription: p.exitDescription,
    headless: p.headless,
    createdAt: p.createdAt,
  }
}

export async function handleLoopScheduleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/loop-schedule/pending' && m === 'GET') {
    const threadId = (url.searchParams.get('threadId') || '').trim().slice(0, 120)
    if (!threadId) {
      sendJson(res, 400, { error: 'threadId required' })
      return true
    }
    const platform = (url.searchParams.get('platform') || 'web').trim().slice(0, 40) || 'web'
    const channelId = (url.searchParams.get('channelId') || 'web').trim().slice(0, 40) || 'web'
    if (!(await requireWebThreadAccess(req, res, threadId, platform, channelId))) return true
    sendJson(res, 200, { ok: true, pending: pendingDto(threadKeyOf(platform, channelId, threadId)) })
    return true
  }

  if (p === '/api/loop-schedule/confirm' && m === 'POST') {
    await handleConfirm(req, res)
    return true
  }
  if (p === '/api/loop-schedule/cancel' && m === 'POST') {
    await handleCancel(req, res)
    return true
  }
  return false
}

async function handleConfirm(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: {
    threadId?: string
    platform?: string
    channelId?: string
    userId?: string
    timeText?: string
    cron?: string
    objective?: string
    exitDescription?: string
    headless?: boolean
  }
  try {
    body = JSON.parse(await readBody(req, res)) as typeof body
  } catch {
    sendJson(res, 400, { error: 'invalid json' })
    return
  }
  const threadId = (body.threadId || '').trim().slice(0, 120)
  if (!threadId) {
    sendJson(res, 400, { error: 'threadId required' })
    return
  }
  const platform = (body.platform || 'web').trim().slice(0, 40) || 'web'
  const channelId = (body.channelId || 'web').trim().slice(0, 40) || 'web'
  if (!(await requireWebThreadAccess(req, res, threadId, platform, channelId))) return
  const threadKey = threadKeyOf(platform, channelId, threadId)
  const existing = getPendingLoopSchedule(threadKey)
  const timeText = (body.timeText || existing?.timeText || '').trim()
  const resolved = resolveScheduleTime(timeText) || (
    body.cron?.trim() ? resolveScheduleTime(body.cron.trim()) : null
  ) || (existing?.cron ? { cron: existing.cron, label: existing.cronLabel } : null)
  const objective = (body.objective ?? existing?.objective ?? '').trim()
  const exitDescription = (body.exitDescription ?? existing?.exitDescription ?? '').trim()
  const headless = body.headless === true || existing?.headless === true
  if (!resolved) {
    sendJson(res, 400, { ok: false, error: '请填写可解析的时间（如每天凌晨2点，或 0 2 * * *）' })
    return
  }
  if (!objective) {
    sendJson(res, 400, { ok: false, error: '请填写目标' })
    return
  }
  if (!exitDescription) {
    sendJson(res, 400, { ok: false, error: '请填写退出条件' })
    return
  }
  const pending = {
    name: existing?.name || suggestLoopScheduleName(objective),
    cron: resolved.cron,
    cronLabel: resolved.label,
    timeText,
    objective: objective.slice(0, 200),
    exitDescription: exitDescription.slice(0, 200),
    headless,
  }
  setPendingLoopSchedule(threadKey, pending)
  const created = commitPendingLoopSchedule({
    pending: { ...pending, createdAt: Date.now() },
    userId: isRequestAdmin(req)
      ? (body.userId || getRequestUserId(req) || '').trim()
      : (getRequestUserId(req) || '').trim(),
  })
  if (!created.ok) {
    sendJson(res, 400, { ok: false, error: created.error })
    return
  }
  clearPendingLoopSchedule(threadKey)
  const reply = formatCreatedLoopScheduleReply({
    id: created.id,
    pending,
    nextIso: created.nextIso,
  })
  try {
    await sessionManager.addMessage(platform, channelId, threadId, {
      role: 'assistant',
      content: reply,
      agent: 'agim',
      timestamp: new Date(),
    })
  } catch {
    /* best-effort — toast still fires on the client */
  }
  sendJson(res, 200, {
    ok: true,
    id: created.id,
    nextIso: created.nextIso,
    reply,
    pending: null,
  })
}

async function handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { threadId?: string; platform?: string; channelId?: string }
  try {
    body = JSON.parse(await readBody(req, res)) as typeof body
  } catch {
    sendJson(res, 400, { error: 'invalid json' })
    return
  }
  const threadId = (body.threadId || '').trim().slice(0, 120)
  if (!threadId) {
    sendJson(res, 400, { error: 'threadId required' })
    return
  }
  const platform = (body.platform || 'web').trim().slice(0, 40) || 'web'
  const channelId = (body.channelId || 'web').trim().slice(0, 40) || 'web'
  if (!(await requireWebThreadAccess(req, res, threadId, platform, channelId))) return
  clearPendingLoopSchedule(threadKeyOf(platform, channelId, threadId))
  sendJson(res, 200, { ok: true, pending: null })
}
