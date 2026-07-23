// approvals-api — HITL approval REST surface.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET  /api/approvals                    → list pending approvals — admin only
//   POST /api/approvals/:reqId/resolve     → resolve by reqId       — admin only

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson } from './http-utils.js'
import { requireAdmin } from './auth.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleApprovalsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/approvals' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleListApprovals(req, res); return true
  }
  const approvalResolveMatch = p.match(/^\/api\/approvals\/([^/]+)\/resolve$/)
  if (approvalResolveMatch && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleResolveApproval(req, res, approvalResolveMatch[1]); return true
  }
  return false
}

async function handleListApprovals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { approvalBus } = await import('../core/approval-bus.js')
    const pending = approvalBus.listPending()
    const metrics = approvalBus.getMetrics()
    sendJson(res, 200, { pending, metrics })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleResolveApproval(req: IncomingMessage, res: ServerResponse, reqId: string): Promise<void> {
  try {
    const body = await readBody(req, res)
    let parsed: { behavior?: string; autoAllowFurther?: boolean; message?: string }
    try { parsed = JSON.parse(body) as typeof parsed } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      return
    }
    if (parsed.behavior !== 'allow' && parsed.behavior !== 'deny') {
      sendJson(res, 400, { ok: false, error: 'behavior must be "allow" or "deny"' })
      return
    }
    const { approvalBus } = await import('../core/approval-bus.js')
    const decision = parsed.behavior === 'allow'
      ? { behavior: 'allow' as const, autoAllowFurther: parsed.autoAllowFurther === true }
      : { behavior: 'deny' as const, message: parsed.message || 'denied via dashboard' }
    const resolved = approvalBus.resolvePendingByReqId(reqId, decision)
    if (!resolved) {
      sendJson(res, 404, { ok: false, error: 'Approval not pending (may have already resolved or timed out)' })
      return
    }
    sendJson(res, 200, { ok: true, resolved })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
