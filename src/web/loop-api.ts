// loop-api — Portal Loop chrome + Tasks audit list/detail.
//
// Portal (thread-scoped):
//   GET  /api/loop
//   POST /api/loop/confirm-met
//
// Tasks audit (admin):
//   GET  /api/loops
//   GET  /api/loops/:id

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  countLoopChildJobs,
  formatLoopEndedSummary,
  getLoopRun,
  getLoopRunById,
  listLoopRuns,
  maybeEnforceLoopExit,
  readLoopReportMarkdown,
  resolveLoopMetConfirm,
  toLoopAuditDto,
  toLoopListItemDto,
  toLoopStatusDto,
  type LoopStatus,
} from '../core/loop-run.js'
import { sessionManager } from '../core/session.js'
import { requireAdmin } from './auth.js'
import { readBody, sendJson } from './http-utils.js'

/**
 * Match-and-handle dispatcher. Returns true when served.
 */
export async function handleLoopApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/loop' && m === 'GET') {
    await handleGetLoop(res, url)
    return true
  }
  if (p === '/api/loop/confirm-met' && m === 'POST') {
    await handleConfirmMet(req, res)
    return true
  }
  if (p === '/api/loops' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleListLoops(res, url)
    return true
  }
  // Named *Match bindings are scraped into tools/endpoints.json.
  const loopReportMatch = p.match(/^\/api\/loops\/([^/]+)\/report$/)
  if (loopReportMatch && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleGetLoopReport(res, decodeURIComponent(loopReportMatch[1]!))
    return true
  }
  const loopIdMatch = p.match(/^\/api\/loops\/([^/]+)$/)
  if (loopIdMatch && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleGetLoopById(res, url, decodeURIComponent(loopIdMatch[1]!))
    return true
  }
  return false
}

async function handleGetLoop(res: ServerResponse, url: URL): Promise<void> {
  const threadId = (url.searchParams.get('threadId') || '').trim().slice(0, 120)
  if (!threadId) {
    sendJson(res, 400, { error: 'threadId required' })
    return
  }
  const platform = (url.searchParams.get('platform') || 'web').trim().slice(0, 40) || 'web'
  const channelId = (url.searchParams.get('channelId') || 'web').trim().slice(0, 40) || 'web'
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'

  // Active wall truncate on poll — exit must not wait for loop_verdict.
  maybeEnforceLoopExit(platform, channelId, threadId)
  const run = getLoopRun(platform, channelId, threadId)
  if (!run) {
    sendJson(res, 200, { ok: true, loop: null })
    return
  }
  sendJson(res, 200, { ok: true, loop: toLoopStatusDto(run, lang) })
}

async function handleListLoops(res: ServerResponse, url: URL): Promise<void> {
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
  const statusRaw = (url.searchParams.get('status') || '').trim()
  const platform = (url.searchParams.get('platform') || '').trim().slice(0, 40) || undefined
  const threadId = (url.searchParams.get('threadId') || '').trim().slice(0, 120) || undefined
  const sessionKey = (url.searchParams.get('sessionKey') || '').trim().slice(0, 200) || undefined
  const limitRaw = Number.parseInt(url.searchParams.get('limit') || '100', 10)
  const limit = Number.isFinite(limitRaw) ? limitRaw : 100

  let status: LoopStatus | 'active' | undefined
  if (statusRaw === 'active') status = 'active'
  else if (statusRaw) status = statusRaw as LoopStatus

  const runs = listLoopRuns({ status, platform, threadId, sessionKey, limit })
  sendJson(res, 200, {
    ok: true,
    count: runs.length,
    loops: runs.map((r) => toLoopListItemDto(r, lang)),
  })
}

async function handleGetLoopById(
  res: ServerResponse,
  url: URL,
  runId: string,
): Promise<void> {
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
  const id = (runId || '').trim().slice(0, 80)
  if (!id) {
    sendJson(res, 400, { error: 'id required' })
    return
  }
  const run = getLoopRunById(id)
  if (!run) {
    sendJson(res, 404, { ok: false, error: 'not_found' })
    return
  }
  sendJson(res, 200, { ok: true, loop: toLoopAuditDto(run, lang) })
}

async function handleGetLoopReport(
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const id = (runId || '').trim().slice(0, 80)
  if (!id) {
    sendJson(res, 400, { error: 'id required' })
    return
  }
  const r = readLoopReportMarkdown(id)
  if (!r.ok) {
    sendJson(res, r.error === 'no_report' ? 404 : 500, { ok: false, error: r.error })
    return
  }
  sendJson(res, 200, {
    ok: true,
    loopId: id,
    path: r.path,
    markdown: r.markdown,
  })
}

async function handleConfirmMet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>
  try {
    const raw = await readBody(req, res)
    body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  } catch (err) {
    const e = err as Error & { handled?: boolean }
    if (e.handled) return
    sendJson(res, 400, { error: 'Invalid JSON body' })
    return
  }

  const threadId = typeof body.threadId === 'string' ? body.threadId.trim().slice(0, 120) : ''
  if (!threadId) {
    sendJson(res, 400, { error: 'threadId required' })
    return
  }
  const platform = typeof body.platform === 'string' && body.platform.trim()
    ? body.platform.trim().slice(0, 40)
    : 'web'
  const channelId = typeof body.channelId === 'string' && body.channelId.trim()
    ? body.channelId.trim().slice(0, 40)
    : 'web'
  const action = body.action === 'continue' ? 'continue' : body.action === 'end' ? 'end' : null
  if (!action) {
    sendJson(res, 400, { error: 'action must be end|continue' })
    return
  }
  const supplement = typeof body.supplement === 'string' ? body.supplement : undefined
  const lang = body.lang === 'en' ? 'en' : 'zh'

  const r = resolveLoopMetConfirm(platform, channelId, threadId, { action, supplement })
  if (!r.ok) {
    sendJson(res, 409, { ok: false, error: r.error })
    return
  }

  // After the user confirms end: post the Loop ended summary into chat.
  // During pending_user_confirm the parent must NOT dump the full conclusion
  // early — the dock owns the preview; the durable summary lands here.
  let endedSummary: string | undefined
  let childJobCount = 0
  if (action === 'end' && r.run.status === 'ended') {
    endedSummary = formatLoopEndedSummary(r.run)
    childJobCount = countLoopChildJobs(platform, channelId, threadId)
    try {
      await sessionManager.addMessage(platform, channelId, threadId, {
        role: 'assistant',
        content: endedSummary,
        agent: 'agim',
        timestamp: new Date(),
      })
    } catch {
      /* best-effort — dock already showed the claim summary */
    }
  }

  sendJson(res, 200, {
    ok: true,
    loop: toLoopStatusDto(r.run, lang),
    ...(endedSummary ? { endedSummary } : {}),
    ...(action === 'end' ? { childJobCount, suggestReport: true } : {}),
  })
}
