import { describe, expect, it } from 'vitest'
import { activityFollowSignal } from './activity-follow-signal'
import type { ChatActivity } from '@/hooks/use-chat'

function activity(over: Partial<ChatActivity> = {}): ChatActivity {
  return {
    runId: 'r1',
    status: 'running',
    startedAt: 1,
    steps: [],
    ...over,
  }
}

describe('activityFollowSignal', () => {
  it('changes when todoItems update on a stable plan step id', () => {
    const base = activity({
      steps: [{
        id: 'agim-plan-checklist',
        kind: 'tool',
        label: 'agim_todo_write',
        status: 'success',
        startedAt: 1,
        todoItems: [
          { content: 'one', status: 'in_progress' },
          { content: 'two', status: 'pending' },
        ],
      }],
    })
    const next = activity({
      steps: [{
        id: 'agim-plan-checklist',
        kind: 'tool',
        label: 'agim_todo_write',
        status: 'success',
        startedAt: 1,
        todoItems: [
          { content: 'one', status: 'completed' },
          { content: 'two', status: 'in_progress' },
        ],
      }],
    })
    expect(activityFollowSignal(base)).not.toEqual(activityFollowSignal(next))
    expect(base.steps.length).toBe(next.steps.length)
  })
})
