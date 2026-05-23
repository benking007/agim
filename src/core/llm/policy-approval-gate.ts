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

import type { ToolCallRequest } from './provider-base.js'
import type { ApprovalGate } from './agent-loop.js'

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
}

/**
 * Heuristic for the 'read-only' mode: tool names that historically
 * mean "look but don't touch". Conservative on purpose — anything not
 * on this list is treated as write-y and requires explicit allow-list
 * approval. The list is shared by every backend (MCP tool naming
 * conventions are loose enough that this works as a starting filter,
 * and the explicit autoAllow always overrides it).
 */
const READ_ONLY_HINTS = [
  'read', 'list', 'get', 'search', 'find', 'fetch', 'show', 'view',
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
  const autoAllow = new Set(cfg.autoAllow ?? [])
  const denyList = new Set(cfg.denyList ?? [])
  return async (call: ToolCallRequest): Promise<'allow' | 'deny'> => {
    if (denyList.has(call.name)) return 'deny'
    if (autoAllow.has(call.name)) return 'allow'
    switch (mode) {
      case 'allow-all':
        return 'allow'
      case 'deny-all':
        return 'deny'
      case 'read-only':
        return looksReadOnly(call.name) ? 'allow' : 'deny'
      case 'allow-list':
        // Outside the allow-list → deny. This is the default mode.
        return 'deny'
      default:
        return 'deny'
    }
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
