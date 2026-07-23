// workspaces-api — Workspace CRUD REST surface.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET    /api/workspaces       → list workspaces (summary or full)   — admin only
//   POST   /api/workspaces       → create or upsert workspace           — admin only
//   PATCH  /api/workspaces/:id   → update workspace by id               — admin only
//   DELETE /api/workspaces/:id   → delete workspace by id               — admin only

import type { IncomingMessage, ServerResponse } from 'node:http'
import { updateConfigObject } from '../core/config-store.js'
import { readBody, sendJson } from './http-utils.js'
import { requireAdmin, getRequestActor } from './auth.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleWorkspacesApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/workspaces' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleListWorkspaces(req, res, url); return true
  }
  if (p === '/api/workspaces' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleCreateOrUpdateWorkspace(req, res); return true
  }
  const workspaceIdMatch = p.match(/^\/api\/workspaces\/([^/]+)$/)
  if (workspaceIdMatch && m === 'PATCH') {
    if (!requireAdmin(req, res)) return true
    await handleCreateOrUpdateWorkspace(req, res, workspaceIdMatch[1]); return true
  }
  if (workspaceIdMatch && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    await handleDeleteWorkspace(req, res, workspaceIdMatch[1]); return true
  }
  return false
}

async function handleListWorkspaces(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { workspaceRegistry } = await import('../core/workspace.js')
    const wantFull = url.searchParams.get('full') === '1'
    sendJson(res, 200, {
      workspaces: wantFull ? workspaceRegistry.listFull() : workspaceRegistry.list(),
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Validate + sanitize an incoming WorkspaceConfig from the settings
 * editor. Returns a clean object on success or a string error message
 * on failure. Reused by POST and PATCH so behavior is identical.
 */
export function validateWorkspacePayload(
  raw: unknown,
  expectedId?: string,
): { ok: true; cfg: import('../core/workspace.js').WorkspaceConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' }
  const o = raw as Record<string, unknown>
  const id = String(o.id || '').trim()
  if (!id) return { ok: false, error: 'id is required' }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, error: 'id must match [a-zA-Z0-9_-]+' }
  if (id === 'default' && expectedId !== 'default') {
    return { ok: false, error: '"default" workspace is reserved (use PATCH to edit)' }
  }
  if (expectedId && expectedId !== id) {
    return { ok: false, error: `id mismatch: URL is ${expectedId}, body is ${id}` }
  }
  const name = String(o.name || id)
  const agents = Array.isArray(o.agents) ? o.agents.filter((a): a is string => typeof a === 'string') : []
  const members = Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === 'string') : undefined
  let rateLimit: { rate: number; intervalSec: number; burst: number } | undefined
  if (o.rateLimit && typeof o.rateLimit === 'object') {
    const r = o.rateLimit as Record<string, unknown>
    const rate = Number(r.rate)
    const intervalSec = Number(r.intervalSec)
    const burst = Number(r.burst)
    if (!Number.isFinite(rate) || rate <= 0
      || !Number.isFinite(intervalSec) || intervalSec <= 0
      || !Number.isFinite(burst) || burst <= 0) {
      return { ok: false, error: 'rateLimit.rate / intervalSec / burst must be positive numbers' }
    }
    rateLimit = { rate, intervalSec, burst }
  }
  return { ok: true, cfg: { id, name, agents, members, rateLimit } }
}

/**
 * Persist the workspaces array back to ~/.agim/config.json so changes
 * survive a restart. Best-effort: a write failure is logged but the
 * in-memory registry has already been updated, so the change is live
 * until the next process boot.
 */
export async function persistWorkspacesToConfig(
  workspaces: import('../core/workspace.js').WorkspaceConfig[],
): Promise<void> {
  await updateConfigObject((current) => {
    const next = { ...current, tenants: workspaces } as Record<string, unknown>
    next.workspaces = workspaces
    return { config: next, result: undefined }
  }, {
    fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
  })
}

async function handleCreateOrUpdateWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  expectedId?: string,
): Promise<void> {
  try {
    const body = await readBody(req, res)
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      return
    }
    const v = validateWorkspacePayload(parsed, expectedId)
    if (!v.ok) {
      sendJson(res, 400, { ok: false, error: v.error })
      return
    }
    const { workspaceRegistry } = await import('../core/workspace.js')
    workspaceRegistry.add(v.cfg)
    await persistWorkspacesToConfig(
      workspaceRegistry.listFull().filter((w) => w.id !== 'default')
    )
    try {
      const { logAuditEvent } = await import('../core/audit-log.js')
      logAuditEvent({
        eventType: 'workspace.add',
        actor: getRequestActor(req),
        target: v.cfg.id,
        outcome: 'ok',
        details: { agents: v.cfg.agents.length, members: v.cfg.members?.length ?? 0 },
      })
    } catch { /* best-effort */ }
    sendJson(res, 200, { ok: true, workspace: v.cfg })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleDeleteWorkspace(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  try {
    const { workspaceRegistry } = await import('../core/workspace.js')
    if (id === 'default') {
      sendJson(res, 400, { ok: false, error: 'cannot delete the default workspace' })
      return
    }
    const removed = workspaceRegistry.remove(id)
    if (!removed) {
      sendJson(res, 404, { ok: false, error: `workspace "${id}" not found` })
      return
    }
    await persistWorkspacesToConfig(
      workspaceRegistry.listFull().filter((w) => w.id !== 'default')
    )
    try {
      const { logAuditEvent } = await import('../core/audit-log.js')
      logAuditEvent({
        eventType: 'workspace.delete',
        actor: getRequestActor(req),
        target: id,
        outcome: 'ok',
      })
    } catch { /* best-effort */ }
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
