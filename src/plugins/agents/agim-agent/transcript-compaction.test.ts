import { describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  resolveContextBudgetSettings,
  type ContextBudgetSettings,
} from './context-budget.js'
import {
  contextExceedsReserve,
  shouldRunMidTurnCompaction,
} from './transcript-compaction.js'

function toolResult(name: string, text: string, id: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  }
}

function big(n: number): string {
  return 'x'.repeat(n)
}

describe('shouldRunMidTurnCompaction', () => {
  it('is false when under the emergency line', () => {
    const budget = resolveContextBudgetSettings(200_000)
    const messages = [toolResult('r', 'hi', '1')]
    expect(shouldRunMidTurnCompaction(messages, budget, 200_000)).toBe(false)
  })

  it('is true when emergency clearing still leaves the view over the line', () => {
    const budget: ContextBudgetSettings = resolveContextBudgetSettings(40_000)
    budget.compaction.reserveTokens = 8_000
    budget.clearing.triggerTokens = 10_000_000
    budget.clearing.keepToolUses = 8
    // Even keep≤2 leaves ~200k chars → estimate stays above 40k-8k.
    const messages: AgentMessage[] = []
    for (let i = 0; i < 6; i++) {
      messages.push(toolResult(`r${i}`, big(120_000), `id-${i}`))
    }
    expect(shouldRunMidTurnCompaction(messages, budget, 40_000)).toBe(true)
  })

  it('is true when clearing is off and raw estimate exceeds the line', () => {
    const budget = resolveContextBudgetSettings(40_000)
    budget.compaction.reserveTokens = 8_000
    budget.clearing.enabled = false
    const messages = [toolResult('r', big(200_000), '1')]
    expect(shouldRunMidTurnCompaction(messages, budget, 40_000)).toBe(true)
  })

  it('is false when compaction is disabled', () => {
    const budget = resolveContextBudgetSettings(40_000)
    budget.compaction.enabled = false
    budget.compaction.reserveTokens = 8_000
    const messages = [toolResult('r', big(50_000), '1')]
    expect(shouldRunMidTurnCompaction(messages, budget, 40_000)).toBe(false)
  })

  it('fires earlier with lookahead when current is under hard line but projected is over', () => {
    const budget = resolveContextBudgetSettings(40_000)
    budget.compaction.reserveTokens = 8_000
    budget.lookaheadTokens = 16_000
    budget.clearing.enabled = false
    // hard line = 32k; with lookahead, project = current+16k > 32k when current > 16k.
    // ~20k-char tool ≈ ~5k tokens — too small. Use ~100k chars ≈ 25k tokens.
    const messages = [toolResult('r', big(100_000), '1')]
    // Without lookahead would be: 25k > 32k? false. With pad: 25k+16k > 32k → true.
    budget.lookaheadTokens = 0
    expect(shouldRunMidTurnCompaction(messages, budget, 40_000)).toBe(false)
    budget.lookaheadTokens = 16_000
    expect(shouldRunMidTurnCompaction(messages, budget, 40_000)).toBe(true)
  })
})

describe('contextExceedsReserve', () => {
  it('trips at absolute compactAtTokens on a 1M window', () => {
    const budget = resolveContextBudgetSettings(1_000_000)
    expect(budget.compactAtTokens).toBe(200_000)
    expect(contextExceedsReserve(199_000, 1_000_000, budget.compaction, budget.compactAtTokens)).toBe(false)
    expect(contextExceedsReserve(201_000, 1_000_000, budget.compaction, budget.compactAtTokens)).toBe(true)
  })

  it('falls back to late-only when compactAtTokens is 0', () => {
    const budget = resolveContextBudgetSettings(1_000_000)
    budget.compaction.reserveTokens = 48_000
    expect(contextExceedsReserve(300_000, 1_000_000, budget.compaction, 0)).toBe(false)
    expect(contextExceedsReserve(960_000, 1_000_000, budget.compaction, 0)).toBe(true)
  })
})
