import { describe, expect, it } from 'vitest'
import { normalizeActivityStep } from './chat-ws-handlers'

describe('normalizeActivityStep', () => {
  it('keeps kind:reflect (does not collapse it to tool)', () => {
    const step = normalizeActivityStep({
      id: 'r1',
      kind: 'reflect',
      label: 'Fetch filings next',
      status: 'running',
      startedAt: 1,
    })
    expect(step.kind).toBe('reflect')
    expect(step.label).toBe('Fetch filings next')
  })

  it('forwards Subagent reflects and lastTool onto the card', () => {
    const step = normalizeActivityStep({
      id: 'a2a-1',
      kind: 'agent',
      label: 'agim:deepseek-v4-pro',
      status: 'running',
      startedAt: 10,
      reflects: [{ stance: 'keep', next: 'Query capital flows', at: 10 }],
      lastTool: { label: 'agim_web_search', status: 'running', at: 11 },
    })
    expect(step.reflects).toEqual([{ stance: 'keep', next: 'Query capital flows', at: 10 }])
    expect(step.lastTool).toEqual({ label: 'agim_web_search', status: 'running', at: 11 })
  })

  it('forwards heartbeatAt onto the card', () => {
    const step = normalizeActivityStep({
      id: 'a2a-2',
      kind: 'agent',
      label: 'cursor',
      status: 'running',
      startedAt: 10,
      heartbeatAt: 46_000,
      lastTool: { label: 'agim_exec', status: 'running', at: 11 },
    })
    expect(step.heartbeatAt).toBe(46_000)
    expect(step.lastTool?.label).toBe('agim_exec')
  })
})
