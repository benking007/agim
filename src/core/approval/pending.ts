// Pending-approval data structure + pure map helpers.
//
// These helpers operate only on Maps/Sets passed as arguments. They carry no
// global side-effects and are independently testable. ApprovalBus calls them
// directly with its own private maps rather than wrapping them in methods.

import type { Socket } from 'node:net'
import type { Decision } from './types.js'
import { autoAllowRuleKey } from './fingerprint.js'
import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ component: 'approval-bus' })

export interface PendingApproval {
  runId: string
  reqId: string
  toolName: string
  threadId: string
  /** `platform:channelId:threadId` — used as the Map key for pendingByThread
   *  and autoAllowByThread so different platforms/channels don't collide. */
  compositeKey: string
  /** Cached at registration so cancelPending can fire ResolutionListener with
   *  a valid platform even when the underlying runContext has already been
   *  cleared (e.g. unregisterRun deletes the context BEFORE cancelling). */
  platform: string
  /** Only this user may resolve an explicit-decision request. */
  approverUserId: string
  /** Truncated input fingerprint used for auto-allow lookups + revocation. */
  fingerprint: string
  /** Original tool input — kept verbatim so dashboard / `listPending` can
   *  surface a useful preview to operators. Never sent over the wire by
   *  the bus itself; sidecar already has the original. */
  input: Record<string, unknown>
  /** Wall-clock ms when the pending was registered. Used by listPending
   *  to compute age; zero in pre-existing rehydrated state (impossible
   *  in practice — bus is process-local). */
  registeredAt: number
  /** Set when the pending was created from a unix-socket sidecar (Claude
   *  path). cancelPending writes the decision back over this socket. Either
   *  `socket` or `dispatch` must be set, never both. */
  socket?: Socket
  /** Set when the pending was created via {@link ApprovalBus.registerSyntheticPending}
   *  (opencode HTTP path, P2). cancelPending invokes this callback instead
   *  of writing to a socket — the caller is responsible for delivering the
   *  decision to its own backend (e.g. POST /permission/:id/reply). Errors
   *  thrown from dispatch are logged, never propagated. */
  dispatch?: (decision: Decision) => void
  timer: ReturnType<typeof setTimeout>
  resolved: boolean
  /** When true, this pending was created in auto-allow mode: timer expiry
   *  resolves to allow rather than deny, and an explicit deny revokes the
   *  matching auto-allow rule. */
  autoAllow: boolean
  /** True for approval-only state transitions that must be decided by a
   *  human for this exact request. */
  requiresExplicitDecision: boolean
  /** See {@link ApprovalNotification.allowSessionPin}. */
  allowSessionPin: boolean
}

/** Remove a resolved pending from both index maps. */
export function removePending(
  p: PendingApproval,
  pendingById: Map<string, PendingApproval>,
  pendingByThread: Map<string, PendingApproval[]>,
): void {
  pendingById.delete(p.reqId)
  const q = pendingByThread.get(p.compositeKey)
  if (!q) return
  const idx = q.indexOf(p)
  if (idx >= 0) q.splice(idx, 1)
  if (q.length === 0) pendingByThread.delete(p.compositeKey)
}

/** Register a new auto-allow rule for the given composite key. */
export function addAutoAllowRule(
  autoAllowByThread: Map<string, Set<string>>,
  compositeKey: string,
  toolName: string,
  fingerprint: string,
): void {
  const key = autoAllowRuleKey(toolName, fingerprint)
  let set = autoAllowByThread.get(compositeKey)
  if (!set) { set = new Set(); autoAllowByThread.set(compositeKey, set) }
  set.add(key)
  log.info({ event: 'approval.bus.autoallow_added', compositeKey, toolName, fingerprint })
}

/** Remove an auto-allow rule; deletes the thread entry when the set empties. */
export function removeAutoAllowRule(
  autoAllowByThread: Map<string, Set<string>>,
  compositeKey: string,
  toolName: string,
  fingerprint: string,
): void {
  const key = autoAllowRuleKey(toolName, fingerprint)
  const set = autoAllowByThread.get(compositeKey)
  if (!set) return
  if (set.delete(key) && set.size === 0) autoAllowByThread.delete(compositeKey)
  log.info({ event: 'approval.bus.autoallow_removed', compositeKey, toolName, fingerprint })
}

/**
 * v1.3.7 (F8) — deny + drop the oldest unresolved pending approval so the
 * maps stay under `cap`. Insertion order of a Map is iteration order, and
 * pendingById is inserted in registration order, so the first unresolved
 * entry is the oldest.
 *
 * `onEvict` is called once with the pending that should be cancelled. The
 * caller (ApprovalBus.cancelPending) owns the actual resolution side-effects.
 */
export function evictOldestPending(
  pendingById: Map<string, PendingApproval>,
  cap: number,
  onEvict: (p: PendingApproval) => void,
): void {
  for (const p of pendingById.values()) {
    if (p.resolved) continue
    log.warn({
      event: 'approval.bus.pending_cap_evict',
      reqId: p.reqId, runId: p.runId, toolName: p.toolName,
      pending: pendingById.size, cap,
    }, `pending-approval cap (${cap}) reached — denying oldest request ${p.reqId}`)
    onEvict(p)
    return
  }
}
