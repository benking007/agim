/**
 * Map a nested Subagent's own activity onto the parent Subagent card.
 *
 * Child tool rows stay off the parent accordion. Thinking may arrive as
 * `step.reflects` (callDepth>0) or as `kind: 'reflect'` (parent-style).
 * Either way the parent card needs a live inner line instead of “Thinking…”.
 */

import type { ToolActivityStep } from './types.js'

export type SubagentLastTool = NonNullable<ToolActivityStep['lastTool']>

const CALL_AGENT_RE = /(?:^|__)call_agents?$/i

export function isChildInnerToolStep(step: Pick<ToolActivityStep, 'kind' | 'label'>): boolean {
  if (step.kind === 'agent' || step.kind === 'reflect' || step.kind === 'status') return false
  const label = (step.label || '').trim()
  if (!label || CALL_AGENT_RE.test(label)) return false
  return step.kind === 'tool' || step.kind === 'skill' || step.kind == null
}

export function reflectsFromChildStep(
  step: Pick<ToolActivityStep, 'kind' | 'label' | 'startedAt' | 'reflects'>,
): ToolActivityStep['reflects'] | undefined {
  if (step.reflects?.length) return step.reflects
  const next = (step.label || '').trim()
  if (step.kind === 'reflect' && next) {
    return [{ stance: 'keep', next, at: step.startedAt }]
  }
  return undefined
}

export function lastToolFromChildStep(
  step: Pick<ToolActivityStep, 'kind' | 'label' | 'status' | 'startedAt' | 'finishedAt'>,
): SubagentLastTool | undefined {
  if (!isChildInnerToolStep(step)) return undefined
  const label = (step.label || '').trim()
  if (!label) return undefined
  return {
    label,
    status: step.status,
    at: step.finishedAt ?? step.startedAt,
  }
}
