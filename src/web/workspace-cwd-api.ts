/**
 * POST /api/workspace-resolve — map a Portal folder name / path to a
 * directory the agent process can open on this host.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { readBody, sendJson } from './http-utils.js'
import { resolvePortalWorkspacePath } from '../core/workspace-path.js'

export async function handleWorkspaceCwdApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'
  if (p === '/api/workspace-resolve' && m === 'POST') {
    const body = await readBody(req) as { path?: unknown }
    const raw = typeof body.path === 'string' ? body.path : ''
    const path = resolvePortalWorkspacePath(raw)
    if (!path) {
      sendJson(res, 200, { ok: false, path: null })
      return true
    }
    sendJson(res, 200, { ok: true, path, name: basename(path) })
    return true
  }
  return false
}
