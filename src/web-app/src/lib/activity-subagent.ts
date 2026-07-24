/**
 * Helpers for inline Subagent cards (message-list surface, sibling of Plan).
 */

import type { ChatActivity, ChatActivityStep } from '@/hooks/use-chat'

/** Parse `a2a-123` → 123 when jobId was not forwarded on the wire. */
export function resolveSubagentJobId(step: ChatActivityStep): number | undefined {
  if (typeof step.jobId === 'number' && Number.isFinite(step.jobId)) return step.jobId
  const m = /^a2a-(\d+)$/.exec(step.id)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/** All Subagent / A2A agent steps in activity order. */
export function listSubagentSteps(activity: ChatActivity): ChatActivityStep[] {
  return activity.steps.filter((s) => s.kind === 'agent')
}

export function countLiveSubagents(steps: ChatActivityStep[]): number {
  return steps.filter((s) => s.status === 'running' || s.status === 'pending').length
}

export function isSubagentLive(step: ChatActivityStep): boolean {
  return step.status === 'running' || step.status === 'pending'
}
