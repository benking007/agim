import { describe, expect, it } from 'vitest'
import {
  isLoopGateDenialPreview,
  isParentOrchestrationDenial,
  listSubagentSteps,
} from './activity-subagent'
import type { ChatActivity, ChatActivityStep } from '@/hooks/use-chat'

function step(over: Partial<ChatActivityStep>): ChatActivityStep {
  return {
    id: 's1',
    kind: 'agent',
    label: 'agim',
    status: 'running',
    startedAt: 1,
    ...over,
  }
}

describe('activity-subagent helpers', () => {
  it('detects loop gate denial previews', () => {
    expect(isLoopGateDenialPreview('loop-parent-wait: after dispatch')).toBe(true)
    expect(isLoopGateDenialPreview('loop-dispatch-gate: 0 dispatches')).toBe(true)
    expect(isLoopGateDenialPreview('Objective: research')).toBe(false)
  })

  it('hides parent orchestration denials from Subagent card list', () => {
    const activity: ChatActivity = {
      runId: 'r',
      status: 'running',
      startedAt: 1,
      steps: [
        step({
          id: 'gate',
          label: 'mcp__agim__call_agents',
          status: 'denied',
          preview: 'loop-parent-wait: after dispatch this round, parent must ONLY wait',
        }),
        step({
          id: 'a2a-9',
          label: 'agim/cheap',
          status: 'running',
          jobId: 9,
          preview: 'Objective: ok',
        }),
      ],
    }
    const listed = listSubagentSteps(activity)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe('a2a-9')
    expect(isParentOrchestrationDenial(activity.steps[0]!)).toBe(true)
  })
})
