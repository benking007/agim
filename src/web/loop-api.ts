// loop-api — GET /api/loop?threadId=… for Portal Loop status chrome (R5).
// Auth: any authenticated token (server /api/* gate). Scoped by threadId.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getLoopRun, toLoopStatusDto } from '../core/loop-run.js'
import { sendJson } from './http-utils.js'

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

  const run = getLoopRun(platform, channelId, threadId)
  if (!run) {
    sendJson(res, 200, { ok: true, loop: null })
    return
  }
  sendJson(res, 200, { ok: true, loop: toLoopStatusDto(run, lang) })
}
