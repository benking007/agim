/**
 * POST /api/workspace-resolve — map a Portal folder name / path to a
 * subdirectory under this agent's host workspace
 * (`~/.agim-workspaces/<agent>/`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { readBody, sendJson } from './http-utils.js'
import { getRequestUserId } from './auth.js'
import { resolvePortalWorkspacePath } from '../core/workspace-path.js'

export async function handleWorkspaceCwdApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'
  if (p === '/api/workspace-resolve' && m === 'POST') {
    let parsed: { path?: unknown; agent?: unknown } = {}
    try {
      const raw = await readBody(req)
      parsed = raw ? JSON.parse(raw) as typeof parsed : {}
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' })
      return true
    }
    const agent = typeof parsed.agent === 'string' ? parsed.agent.trim() : ''
    const rawPath = typeof parsed.path === 'string' ? parsed.path : ''
    if (!agent) {
      sendJson(res, 400, { error: 'Missing agent' })
      return true
    }
    const path = resolvePortalWorkspacePath(rawPath, agent, getRequestUserId(req))
    if (!path) {
      sendJson(res, 200, { ok: false, path: null })
      return true
    }
    sendJson(res, 200, { ok: true, path, name: basename(path) })
    return true
  }
  return false
}
