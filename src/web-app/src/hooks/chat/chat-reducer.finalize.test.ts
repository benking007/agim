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
  it('closes agent steps with jobId on success (match finishActiveRun)', () => {
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
        {
          id: 'agent-pending',
          kind: 'agent',
          label: 'claude-code',
          status: 'pending',
          startedAt: Date.now() - 700,
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
    const finishedAt = Date.now()
    const next = chatReducer(state, {
      kind: 'RUN_FINISH',
      runId: 'run-1',
      status: 'success',
      finishedAt,
      durationMs: 1_000,
    })
    const steps = next.messages[0]?.activity?.steps ?? []
    expect(steps.find((s) => s.id === 'tool-1')?.status).toBe('success')
    expect(steps.find((s) => s.id === 'agent-1')?.status).toBe('success')
    expect(steps.find((s) => s.id === 'agent-1')?.jobId).toBe(42)
    expect(steps.find((s) => s.id === 'agent-1')?.finishedAt).toBe(finishedAt)
    expect(steps.find((s) => s.id === 'agent-pending')?.status).toBe('success')
    expect(next.messages[0]?.activity?.status).toBe('success')
  })

  it('marks open agent steps error when RUN_FINISH is error', () => {
    const activity: ChatActivity = {
      runId: 'run-2',
      status: 'running',
      startedAt: Date.now() - 1_000,
      steps: [
        {
          id: 'agent-1',
          kind: 'agent',
          label: 'codex',
          status: 'running',
          startedAt: Date.now() - 800,
          jobId: 7,
        },
      ],
    }
    const state = {
      ...initialChatState,
      messages: [assistantWithActivity(activity)],
      currentReplyId: 'a1',
      activeRunId: 'run-2',
      runActivities: [{
        runId: 'run-2',
        agent: 'agim',
        status: 'running' as const,
        startedAt: activity.startedAt,
      }],
    }
    const next = chatReducer(state, {
      kind: 'RUN_FINISH',
      runId: 'run-2',
      status: 'error',
      finishedAt: Date.now(),
      durationMs: 500,
      error: 'aborted',
    })
    expect(next.messages[0]?.activity?.steps[0]?.status).toBe('error')
  })
})
