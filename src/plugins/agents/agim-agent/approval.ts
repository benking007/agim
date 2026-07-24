// Builds the Agim Agent policy approval gate: read-only / allow-list /
// deny-all modes + plan-mode deny + IM approval-card escalation. The adapter calls
// this gate from its beforeToolCall hook.

import type { ApprovalGate } from '../../../core/llm/agent-loop.js'
import { isPlanExitToolName, PLAN_EXIT_TOOL_NAME } from '../../../core/llm/plan-exit-dispatcher.js'
import { buildPolicyApprovalGate } from '../../../core/llm/policy-approval-gate.js'
import { isTodoActivityLabel } from '../../../core/llm/todo-items.js'
import { canonicalizeToolName, expandToolNameList } from '../../../core/llm/tool-names.js'
import { approvalBus, threadKey as makeThreadKey } from '../../../core/approval-bus.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { buildNativeAskUser, resolvePolicy } from '../agim-agent-shared/index.js'
import { NATIVE_HITL_EXEMPT } from '../agim-agent-shared/tool-registry.js'

function isCallAgentToolName(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'call_agent' || n.endsWith('__call_agent')
}

export function buildPiApprovalGate(opts: AgentSendOpts | undefined, sessionId: string): ApprovalGate {
  const o = opts ?? {}
  const planThreadKey =
    o.platform && o.threadId ? makeThreadKey(o.platform, o.channelId ?? '', o.threadId) : undefined
  const policy = resolvePolicy(planThreadKey)
  // Escalate would-be denials to an IM approval card when we have a live
  // thread + notifier; otherwise the gate silently denies (CI / smoke safe).
  const askUser =
    o.platform && o.threadId && approvalBus.hasNotifier()
      ? buildNativeAskUser({
          runId: sessionId,
          platform: o.platform,
          channelId: o.channelId ?? 'default',
          threadId: o.threadId,
          userId: o.userId ?? 'unknown',
          // Same-family / A2A Subagents inherit the parent thread; stamp
          // depth + agent so AGIM_AUTO_APPROVE and the web dock treat
          // parent and child through one ApprovalBus.
          callerAgent: 'agim',
          ...(typeof o.callDepth === 'number' ? { callDepth: o.callDepth } : {}),
          ...(typeof o.parentJobId === 'number' ? { parentJobId: o.parentJobId } : {}),
        })
      : undefined
  const gate = buildPolicyApprovalGate({ ...policy, askUser })
  const denyExpanded = expandToolNameList(policy.denyList ?? [])
  return async (call, attempt, signal) => {
    if (isPlanExitToolName(call.name) || canonicalizeToolName(call.name) === PLAN_EXIT_TOOL_NAME) {
      // The plan-exit dispatcher owns the mandatory one-time human prompt.
      // Avoid a duplicate generic card, while still honoring operator-level
      // deny-all / explicit deny-list controls.
      if (policy.mode === 'deny-all'
        || denyExpanded.has(call.name)
        || denyExpanded.has(canonicalizeToolName(call.name))) {
        return 'deny'
      }
      return 'allow'
    }
    // Checklist writes only update observer UI / todo store — never mutate
    // the workspace. Auto-allow so the Plan card can appear mid-turn even
    // when AGIM_AUTO_APPROVE is off (otherwise every todo_write blocks HITL
    // and the checklist looks "stuck until the end").
    if (isTodoActivityLabel(call.name)
      && !denyExpanded.has(call.name)
      && !denyExpanded.has(canonicalizeToolName(call.name))
      && policy.mode !== 'deny-all') {
      return 'allow'
    }
    // Observer / read-class natives: builtins (agim_now…), FS reads, and web
    // search/fetch. Under default allow-list these used to spam HITL cards
    // (often empty `agim_now({})` first). web_fetch still has dispatcher SSRF
    // blocking; skipping the card does not open private URLs. Deny-all and
    // explicit deny-list still win.
    const canon = canonicalizeToolName(call.name)
    if (NATIVE_HITL_EXEMPT.has(canon)
      && !denyExpanded.has(call.name)
      && !denyExpanded.has(canon)
      && policy.mode !== 'deny-all') {
      return 'allow'
    }
    // Subagent spawn is the product surface — under allow-list, don't block
    // mcp__agim__call_agent behind HITL or the Subagent panel never appears
    // (activity is owned by A2A, which only runs after the tool is allowed).
    // Depth / ACL / per-turn caps inside call_agent still apply. Deny-all and
    // explicit deny-list still win.
    if (isCallAgentToolName(call.name)
      && !denyExpanded.has(call.name)
      && !denyExpanded.has(canon)
      && policy.mode !== 'deny-all') {
      return 'allow'
    }
    return await gate(call, attempt, signal)
  }
}
