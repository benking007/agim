// Builds the Agim Agent policy approval gate: read-only / allow-list /
// deny-all modes + plan-mode deny + IM approval-card escalation. The adapter calls
// this gate from its beforeToolCall hook.

import type { ApprovalGate } from '../../../core/llm/agent-loop.js'
import { isPlanExitToolName, PLAN_EXIT_TOOL_NAME } from '../../../core/llm/plan-exit-dispatcher.js'
import { buildPolicyApprovalGate } from '../../../core/llm/policy-approval-gate.js'
import { canonicalizeToolName, expandToolNameList } from '../../../core/llm/tool-names.js'
import { approvalBus, threadKey as makeThreadKey } from '../../../core/approval-bus.js'
import {
  isDetachedGoalCommand,
  isGoalExecContainmentAvailable,
} from '../../../core/goal-evidence.js'
import { getActiveGoalState } from '../../../core/goals.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { buildNativeAskUser, resolvePolicy } from '../agim-agent-shared/index.js'

/** True when this thread has an active /goal and the tool is agim_exec. */
function isGoalScopedExec(
  toolName: string,
  platform: string | undefined,
  channelId: string | undefined,
  threadId: string | undefined,
): boolean {
  if (!platform || !threadId) return false
  if (canonicalizeToolName(toolName) !== 'agim_exec') return false
  const { goal } = getActiveGoalState(platform, channelId ?? 'default', threadId)
  return !!goal
}

/** Soft risk notes for the approval card (not a hard block). */
function goalExecRiskNotes(args: Record<string, unknown>): string[] {
  const notes: string[] = []
  if (!isGoalExecContainmentAvailable()) {
    notes.push('bwrap containment unavailable — exec will not run inside a process sandbox')
  }
  if (isDetachedGoalCommand(args)) {
    notes.push('detached/background command form detected (nohup / trailing & / …)')
  }
  return notes
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
          requiresExplicitDecision: (call) =>
            isGoalScopedExec(call.name, o.platform, o.channelId, o.threadId),
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

    // Active /goal + agim_exec: do not hard-block. Force one explicit HITL
    // approval (bypasses AGIM_AUTO_APPROVE / allow-all / autoAllow) so the
    // operator can green-light the script without completing the goal.
    if (isGoalScopedExec(call.name, o.platform, o.channelId, o.threadId)) {
      if (policy.mode === 'deny-all'
        || denyExpanded.has(call.name)
        || denyExpanded.has(canonicalizeToolName(call.name))) {
        return 'deny'
      }
      if (!askUser) {
        // No IM notifier (CI / headless) — allow so tests do not hang.
        // Runtime sandbox still applies via exec-dispatcher when bwrap exists.
        return 'allow'
      }
      const args = (call.arguments ?? {}) as Record<string, unknown>
      const notes = goalExecRiskNotes(args)
      const enriched = notes.length > 0
        ? { ...call, arguments: { ...args, _goalExecNotes: notes } }
        : call
      try {
        return await askUser(enriched, signal)
      } catch {
        return 'deny'
      }
    }

    return await gate(call, attempt, signal)
  }
}
