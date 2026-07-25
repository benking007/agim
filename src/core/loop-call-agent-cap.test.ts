import { describe, expect, it } from 'bun:test'

import { shouldClearCallAgentHistoryForLoopRound } from './loop-call-agent-cap.js'

describe('shouldClearCallAgentHistoryForLoopRound', () => {
  it('clears on planning/reflecting with 0 dispatches (R2 ready)', () => {
    expect(shouldClearCallAgentHistoryForLoopRound({
      status: 'planning',
      dispatchesThisRound: 0,
    })).toBe(true)
    expect(shouldClearCallAgentHistoryForLoopRound({
      status: 'reflecting',
      dispatchesThisRound: 0,
    })).toBe(true)
  })

  it('does not clear after this round already dispatched', () => {
    expect(shouldClearCallAgentHistoryForLoopRound({
      status: 'dispatching',
      dispatchesThisRound: 3,
    })).toBe(false)
    expect(shouldClearCallAgentHistoryForLoopRound({
      status: 'verifying',
      dispatchesThisRound: 1,
    })).toBe(false)
    expect(shouldClearCallAgentHistoryForLoopRound({
      status: 'planning',
      dispatchesThisRound: 1,
    })).toBe(false)
  })

  it('does not clear aligning / ended / pending_user_confirm / missing run', () => {
    expect(shouldClearCallAgentHistoryForLoopRound(null)).toBe(false)
    expect(shouldClearCallAgentHistoryForLoopRound({
      status: 'aligning',
      dispatchesThisRound: 0,
    })).toBe(false)
    expect(shouldClearCallAgentHistoryForLoopRound({
      status: 'ended',
      dispatchesThisRound: 0,
    })).toBe(false)
    expect(shouldClearCallAgentHistoryForLoopRound({
      status: 'pending_user_confirm',
      dispatchesThisRound: 0,
    })).toBe(false)
  })
})
