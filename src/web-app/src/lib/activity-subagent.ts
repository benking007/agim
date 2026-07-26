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

/** Parent Loop orchestration gate refusal (not a Subagent runtime failure). */
export function isLoopGateDenialPreview(preview: string | undefined): boolean {
  const p = (preview || '').trim()
  return (
    p.startsWith('loop-parent-wait:')
    || p.startsWith('loop-dispatch-gate:')
    || p.startsWith('loop-verify')
  )
}

/**
 * True when an activity step is a parent tool/gate denial mislabeled as
 * `kind:agent` (legacy wire) — must not appear in the Subagents card.
 */
export function isParentOrchestrationDenial(step: ChatActivityStep): boolean {
  if (step.status !== 'denied' && step.status !== 'error') return false
  if (isLoopGateDenialPreview(step.preview)) return true
  const label = (step.label || '').trim()
  if (/^mcp__agim__call_agents?$/i.test(label)) return true
  if (/^call_agents?$/i.test(label)) return true
  return false
}

/** All Subagent / A2A agent steps in activity order (excludes gate denials). */
export function listSubagentSteps(activity: ChatActivity): ChatActivityStep[] {
  return activity.steps.filter((s) => s.kind === 'agent' && !isParentOrchestrationDenial(s))
}

export function countLiveSubagents(steps: ChatActivityStep[]): number {
  return steps.filter((s) => s.status === 'running' || s.status === 'pending').length
}

export function isSubagentLive(step: ChatActivityStep): boolean {
  return step.status === 'running' || step.status === 'pending'
}
