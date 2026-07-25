// loop-api — GET /api/loop + POST /api/loop/confirm-met for Portal Loop chrome.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  countLoopChildJobs,
  formatLoopEndedSummary,
  getLoopRun,
  maybeEnforceLoopExit,
  resolveLoopMetConfirm,
  toLoopStatusDto,
} from '../core/loop-run.js'
import { sessionManager } from '../core/session.js'
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
