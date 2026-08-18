/**
 * ACTIVE_RUN_GONE — server has no ActiveRun snapshot; clear ghost Running.
 */
import { describe, expect, it } from 'vitest'
import { chatReducer, initialChatState, type ChatMessage } from '../use-chat'

function runningMsg(id: string, runId: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    agent: 'agim',
    timestamp: Date.now(),
    activity: {
      runId,
      status: 'running',
      startedAt: Date.now() - 1000,
      steps: [{
        id: 's1',
        kind: 'tool',
        label: 'web_fetch',
        status: 'running',
        startedAt: Date.now() - 500,
      }],
    },
  }
}

describe('ACTIVE_RUN_GONE', () => {
  it('clears currentReplyId / activeRunId and finalizes running activity', () => {
    const seeded = {
      ...initialChatState,
      clientId: 'web-t1',
      currentReplyId: 'reply-1',
      activeRunId: 'run-1',
      messages: [runningMsg('reply-1', 'run-1')],
    }
    const after = chatReducer(seeded, { kind: 'ACTIVE_RUN_GONE', threadId: 'web-t1' })
    expect(after.currentReplyId).toBeNull()
    expect(after.activeRunId).toBeNull()
    expect(after.messages[0]?.activity?.status).toBe('error')
  })

  it('ignores frames for a different thread', () => {
    const seeded = {
      ...initialChatState,
      clientId: 'web-t1',
      currentReplyId: 'reply-1',
      activeRunId: 'run-1',
      messages: [runningMsg('reply-1', 'run-1')],
    }
    const after = chatReducer(seeded, { kind: 'ACTIVE_RUN_GONE', threadId: 'web-other' })
    expect(after.currentReplyId).toBe('reply-1')
    expect(after.activeRunId).toBe('run-1')
  })
})
