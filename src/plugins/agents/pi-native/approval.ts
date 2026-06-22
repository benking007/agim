// Builds the Agim Agent policy approval gate: read-only / allow-list /
// deny-all modes + plan-mode deny + IM approval-card escalation. The adapter calls
// this gate from its beforeToolCall hook.

import type { ApprovalGate } from '../../../core/llm/agent-loop.js'
import { buildPolicyApprovalGate } from '../../../core/llm/policy-approval-gate.js'
import { approvalBus, threadKey as makeThreadKey } from '../../../core/approval-bus.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { buildNativeAskUser, resolvePolicy } from '../native/index.js'

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
        })
      : undefined
  return buildPolicyApprovalGate({ ...policy, askUser })
}
