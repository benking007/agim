// policy-approval-gate — declarative approval gate for the native
// agent loop (Stage 2 sub-PR #4).
//
// Stage 2 sub-PR #4 ships a *policy-driven* gate rather than a full
// IM-interactive approval card. Why:
//
//   - The existing approval-router pipeline is wired tightly to the
//     MCP sidecar's Unix-socket bus protocol (one runId per CLI agent
//     subprocess, decisions echoed back through that socket). Reusing
//     it for native calls would require a substantial refactor of
//     approval-bus to support arbitrary in-process awaiters.
//   - For the native agent's initial cut, three operating modes cover
//     the realistic ops surface:
//        1. 'allow-all'    — fully autonomous (CI / monitoring runs).
//        2. 'read-only'    — allow tools whose name suggests pure read
//                            (heuristic + explicit allow list).
//        3. 'allow-list'   — explicit `autoAllow: string[]` from config;
//                            anything else is denied.
//     This is enough to let operators run native safely while we design
//     the cross-platform IM approval gate as a follow-up.
//   - The agent loop ALWAYS calls `approve(call)`; passing our gate
//     here doesn't preclude swapping for a richer gate later. Tests
//     verify the contract.

import { logger as rootLogger } from '../logger.js'
import type { ToolCallRequest } from './provider-base.js'
import type { ApprovalGate } from './agent-loop.js'
import { expandToolNameList, canonicalizeToolName } from './tool-names.js'

const log = rootLogger.child({ component: 'policy-approval-gate' })

/**
 * Approval mode. Defaults to 'allow-list' which is the safest sane
 * default — operators must explicitly enumerate tools the agent may
 * call without an external approver.
 */
export type ApprovalMode = 'allow-all' | 'read-only' | 'allow-list' | 'deny-all'

export interface PolicyApprovalGateConfig {
  /** Selection rule. Default 'allow-list'. */
  mode?: ApprovalMode
  /** Tools that are always allowed regardless of mode (except 'deny-all'
   *  where nothing passes). Names can be either built-in tool names
   *  (`native_echo`) or MCP namespaced names (`mcp_filesystem_read_file`). */
  autoAllow?: string[]
  /** Tools that are always denied regardless of mode (even in
   *  'allow-all'). Use this as the operator's emergency brake. */
  denyList?: string[]
  /**
   * v1.2.60 — optional human-in-the-loop callback. When the policy would
   * otherwise return 'deny' (mode='allow-list' and tool not in autoAllow;
   * or mode='read-only' and tool isn't read-shaped), call this callback
   * to ask the user via IM. The callback should send an IM approval card
   * and await the user's reply, then resolve to 'allow' or 'deny'.
   *
   * If `askUser` is NOT provided, the gate falls back to the legacy
   * silent-deny behavior (preserves the v1.2.59 / earlier contract for
   * tests + callers that haven't wired the bus yet).
   *
   * Tools on `denyList` are NEVER routed through askUser — the denylist
   * is an operator-controlled emergency brake.
   */
  askUser?: (call: ToolCallRequest, signal?: AbortSignal) => Promise<'allow' | 'deny'>
}

/**
 * Heuristic for the 'read-only' mode: tool names that historically
 * mean "look but don't touch". Conservative on purpose — anything not
 * on this list is treated as write-y and requires explicit allow-list
 * approval. The list is shared by every backend (MCP tool naming
 * conventions are loose enough that this works as a starting filter,
 * and the explicit autoAllow always overrides it).
 */
// v1.3.7 (F4) — 'fetch' removed: native_web_fetch / WebFetch are full
// outbound HTTP clients (the largest SSRF surface), NOT read-only. Letting
// any *fetch* tool auto-pass in 'read-only' mode made that mode a misnomer.
// Outbound fetch now requires explicit autoAllow or an approval card.
const READ_ONLY_HINTS = [
  'read', 'list', 'get', 'search', 'find', 'show', 'view',
  'inspect', 'describe', 'status', 'echo', 'now', 'random_uuid',
]

function looksReadOnly(toolName: string): boolean {
  // Strip the mcp_{server}_ prefix so the verb appears at the start.
  const stripped = toolName.replace(/^mcp_[A-Za-z0-9_]+?_/, '').toLowerCase()
  for (const hint of READ_ONLY_HINTS) {
    if (stripped.startsWith(hint) || stripped.endsWith(`_${hint}`) ||
        stripped.includes(`_${hint}_`)) {
      return true
    }
  }
  return false
}

/**
 * Build an ApprovalGate based on the supplied policy. The returned gate
 * is synchronous-fast (no IO) and always resolves — it never throws.
 */
export function buildPolicyApprovalGate(cfg: PolicyApprovalGateConfig = {}): ApprovalGate {
  const mode: ApprovalMode = cfg.mode ?? 'allow-list'
  const autoAllow = expandToolNameList(cfg.autoAllow ?? [])
  const denyList = expandToolNameList(cfg.denyList ?? [])
  const askUser = cfg.askUser
  return async (call: ToolCallRequest, _attempt: number, signal?: AbortSignal): Promise<'allow' | 'deny'> => {
    // denylist is non-negotiable — never escalate to user.
    if (denyList.has(call.name) || denyList.has(canonicalizeToolName(call.name))) return 'deny'
    // autoAllow short-circuit — never bother the user.
    if (autoAllow.has(call.name) || autoAllow.has(canonicalizeToolName(call.name))) return 'allow'
    // Compute the "would-be" decision from the mode rule.
    let modeDecision: 'allow' | 'deny'
    switch (mode) {
      case 'allow-all':
        modeDecision = 'allow'
        break
      case 'deny-all':
        modeDecision = 'deny'
        break
      case 'read-only':
        modeDecision = looksReadOnly(call.name) ? 'allow' : 'deny'
        break
      case 'allow-list':
        // Outside the allow-list → would-be deny.
        modeDecision = 'deny'
        break
      default:
        modeDecision = 'deny'
    }
    // v1.2.60 — escalate "would-be deny" to user via askUser callback
    // (if wired). 'deny-all' is intentional + does NOT escalate. Allow
    // decisions go through unchanged.
    if (modeDecision === 'deny' && askUser && mode !== 'deny-all') {
      try {
        return await askUser(call, signal)
      } catch (err) {
        // If the IM card pipeline throws (no notifier, socket closed,
        // ctx missing), fall back to deny so the agent loop still makes
        // progress. v1.3.7 (F13) — this was a SILENT deny: the operator
        // had no signal that approvals were failing to deliver (looked
        // like the model just "got denied"). Surface it at warn level.
        log.warn({
          event: 'policy.askUser_failed',
          tool: call.name,
          err: err instanceof Error ? err.message : String(err),
        }, 'approval escalation (askUser) threw — denying this call; check the IM approval pipeline')
        return 'deny'
      }
    }
    return modeDecision
  }
}

/**
 * Describe a policy decision for logs / future IM "approval requested"
 * preview cards. Returned as a one-liner; the gate itself doesn't log
 * (logging belongs to the agent loop's `toolCalls` report).
 */
export function describePolicy(cfg: PolicyApprovalGateConfig): string {
  const mode = cfg.mode ?? 'allow-list'
  const allowCount = cfg.autoAllow?.length ?? 0
  const denyCount = cfg.denyList?.length ?? 0
  return `mode=${mode}, autoAllow=${allowCount}, denyList=${denyCount}`
}
