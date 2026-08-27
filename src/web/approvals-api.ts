// approvals-api — HITL approval REST surface.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET  /api/approvals                    → pending (members: own web threads)
//   POST /api/approvals/:reqId/resolve     → resolve (members: own pending only)

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson } from './http-utils.js'
import { isRequestAdmin } from './auth.js'
import {
  emptyMemberScope,
  resolveMemberScope,
} from './member-scope.js'

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
    await handleListApprovals(req, res); return true
  }
  const approvalResolveMatch = p.match(/^\/api\/approvals\/([^/]+)\/resolve$/)
  if (approvalResolveMatch && m === 'POST') {
    await handleResolveApproval(req, res, approvalResolveMatch[1]); return true
  }
  return false
}

function approvalVisible(
  row: { threadId: string; platform: string },
  scope: Awaited<ReturnType<typeof resolveMemberScope>>,
): boolean {
  if (scope.kind === 'admin') return true
  if (scope.kind !== 'user') return false
  return row.platform === 'web' && scope.threadIds.includes(row.threadId)
}

async function handleListApprovals(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const scope = await resolveMemberScope(req)
    if (emptyMemberScope(scope)) {
      sendJson(res, 200, { pending: [], metrics: { pending: 0 } })
      return
    }
    const { approvalBus } = await import('../core/approval-bus.js')
    const pending = approvalBus.listPending().filter((row) => approvalVisible(row, scope))
    const metrics = scope.kind === 'admin'
      ? approvalBus.getMetrics()
      : {
          pending: pending.length,
          totalRequests: 0,
          totalResolved: 0,
          totalAllowed: 0,
          totalDenied: 0,
          totalTimedOut: 0,
          totalReadonlyAutoAllowed: 0,
        }
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
    const pending = approvalBus.listPending().find((p) => p.reqId === reqId)
    if (!pending) {
      sendJson(res, 404, { ok: false, error: 'Approval not pending (may have already resolved or timed out)' })
      return
    }
    if (!isRequestAdmin(req)) {
      const scope = await resolveMemberScope(req)
      if (!approvalVisible(pending, scope)) {
        sendJson(res, 404, { ok: false, error: 'Approval not pending (may have already resolved or timed out)' })
        return
      }
    }
    const decision = parsed.behavior === 'allow'
      ? { behavior: 'allow' as const, autoAllowFurther: parsed.autoAllowFurther === true }
      : { behavior: 'deny' as const, message: parsed.message || 'denied via dashboard' }
    // Pass the stored approver: HTTP auth already verified the caller may
    // act. Omitting actorUserId used to no-op requiresExplicitDecision
    // tools (plan-exit) because the bus treats a missing actor as mismatch.
    const resolved = approvalBus.resolvePendingByReqId(
      reqId,
      decision,
      pending.approverUserId,
    )
    if (!resolved) {
      sendJson(res, 404, { ok: false, error: 'Approval not pending (may have already resolved or timed out)' })
      return
    }
    sendJson(res, 200, { ok: true, resolved })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
