import { describe, expect, it, mock } from 'bun:test'
import {
  callAgentsLaneLabel,
  countCallAgentsTasks,
  failCallAgentPendingLane,
  failCallAgentsPendingLanes,
} from './subagent-activity.js'
import type { ToolActivityStep } from './types.js'

describe('subagent-activity pending-lane cleanup', () => {
  it('counts and labels call_agents tasks', () => {
    const input = {
      tasks: [
        { agent: 'agim:deepseek-v4-pro', prompt: 'Objective: portfolio' },
        { agent: 'agim', prompt: 'Objective: gold', backend: 'cheap' },
      ],
    }
    expect(countCallAgentsTasks(input)).toBe(2)
    expect(callAgentsLaneLabel(input, 0)).toBe('agim:deepseek-v4-pro')
    expect(callAgentsLaneLabel(input, 1)).toBe('agim')
    expect(callAgentsLaneLabel(input, 9)).toBe('agent')
    expect(countCallAgentsTasks(null)).toBe(0)
  })

  it('failCallAgentsPendingLanes closes every `${toolCallId}#i` card', () => {
    const steps: ToolActivityStep[] = []
    failCallAgentsPendingLanes((step) => { steps.push(step) }, {
      toolCallId: 'batch-9',
      input: {
        tasks: [
          { agent: 'agim', prompt: 'a' },
          { agent: 'claude-code', prompt: 'b' },
          { agent: 'agim', prompt: 'c', backend: 'deepseek-v4-pro' },
        ],
      },
      preview: 'call_agent refused: already delegated 5 time(s)',
    })
    expect(steps).toHaveLength(3)
    expect(steps.map((s) => s.id)).toEqual(['batch-9#0', 'batch-9#1', 'batch-9#2'])
    expect(steps.every((s) => s.kind === 'agent')).toBe(true)
    expect(steps.every((s) => s.status === 'error')).toBe(true)
    expect(steps.every((s) => typeof s.finishedAt === 'number')).toBe(true)
    expect(steps[0]!.label).toBe('agim')
    expect(steps[1]!.label).toBe('claude-code')
    expect(steps[0]!.preview).toMatch(/already delegated/)
  })

  it('failCallAgentsPendingLanes is a no-op without emit or tasks', () => {
    const emit = mock(() => {})
    failCallAgentsPendingLanes(undefined, {
      toolCallId: 'x',
      input: { tasks: [{ agent: 'a', prompt: 'p' }] },
      preview: 'nope',
    })
    failCallAgentsPendingLanes(emit, {
      toolCallId: 'x',
      input: { tasks: [] },
      preview: 'nope',
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('failCallAgentPendingLane closes the singular pending card', () => {
    const steps: ToolActivityStep[] = []
    failCallAgentPendingLane((step) => { steps.push(step) }, {
      toolCallId: 'tc-1',
      label: 'agim:deepseek-v4-pro',
      preview: 'cap exceeded',
      status: 'denied',
    })
    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tc-1',
        kind: 'agent',
        label: 'agim:deepseek-v4-pro',
        status: 'denied',
        preview: 'cap exceeded',
      }),
    ])
  })
})
