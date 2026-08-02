import { describe, expect, it } from 'vitest'
import { chatReducer, initialChatState } from './chat-reducer'
import type { ChatActivity, ChatMessage } from './chat-types'

function assistantWithActivity(activity: ChatActivity): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    activity,
  }
}

describe('chatReducer RUN_FINISH + Subagent steps', () => {
  it('does not auto-success agent steps that still have jobId', () => {
    const activity: ChatActivity = {
      runId: 'run-1',
      status: 'running',
      startedAt: Date.now() - 1_000,
      steps: [
        {
          id: 'tool-1',
          kind: 'tool',
          label: 'agim_now',
          status: 'running',
          startedAt: Date.now() - 500,
        },
        {
          id: 'agent-1',
          kind: 'agent',
          label: 'codex',
          status: 'running',
          startedAt: Date.now() - 800,
          jobId: 42,
        },
      ],
    }
    const state = {
      ...initialChatState,
      messages: [assistantWithActivity(activity)],
      currentReplyId: 'a1',
      activeRunId: 'run-1',
      runActivities: [{
        runId: 'run-1',
        agent: 'agim',
        status: 'running' as const,
        startedAt: activity.startedAt,
      }],
    }
    const next = chatReducer(state, {
      kind: 'RUN_FINISH',
      runId: 'run-1',
      status: 'success',
      finishedAt: Date.now(),
      durationMs: 1_000,
    })
    const steps = next.messages[0]?.activity?.steps ?? []
    expect(steps.find((s) => s.id === 'tool-1')?.status).toBe('success')
    expect(steps.find((s) => s.id === 'agent-1')?.status).toBe('running')
    expect(steps.find((s) => s.id === 'agent-1')?.jobId).toBe(42)
  })
})
