import { describe, expect, it } from 'vitest'
import { chatReducer, initialChatState } from './chat-reducer'
import type { ChatMessage } from './chat-types'

describe('STEP_REFLECT_MODE', () => {
  it('toggles the session flag', () => {
    const on = chatReducer(initialChatState, { kind: 'STEP_REFLECT_MODE', enabled: true })
    expect(on.stepReflect).toBe(true)
    const off = chatReducer(on, { kind: 'STEP_REFLECT_MODE', enabled: false })
    expect(off.stepReflect).toBe(false)
  })

  it('records the ops kill switch', () => {
    const next = chatReducer(initialChatState, {
      kind: 'STEP_REFLECT_MODE',
      enabled: false,
      disabled: true,
    })
    expect(next.stepReflectDisabled).toBe(true)
  })
})

describe('ACTIVITY_STEP Subagent inner state', () => {
  it('merges reflects and lastTool onto an existing agent card', () => {
    const reply: ChatMessage = {
      id: 'asst-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      activity: {
        runId: 'run-1',
        status: 'running',
        startedAt: 1,
        steps: [{
          id: 'lane-0',
          kind: 'agent',
          label: 'agim:deepseek-v4-pro',
          status: 'running',
          startedAt: 1,
          jobId: 9,
          preview: 'Objective: filings',
        }],
      },
    }
    const seeded = {
      ...initialChatState,
      currentReplyId: 'asst-1',
      messages: [reply],
    }
    const next = chatReducer(seeded, {
      kind: 'ACTIVITY_STEP',
      runId: 'run-1',
      step: {
        id: 'lane-0',
        kind: 'agent',
        label: 'agim:deepseek-v4-pro',
        status: 'running',
        startedAt: 1,
        reflects: [{ stance: 'keep', next: 'Query capital flows', at: 2 }],
        lastTool: { label: 'agim_web_search', status: 'running', at: 3 },
      },
    })
    const step = next.messages[0]?.activity?.steps[0]
    expect(step?.preview).toBe('Objective: filings')
    expect(step?.jobId).toBe(9)
    expect(step?.reflects).toEqual([{ stance: 'keep', next: 'Query capital flows', at: 2 }])
    expect(step?.lastTool).toEqual({ label: 'agim_web_search', status: 'running', at: 3 })
  })
})

