import { describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  resolveContextBudgetSettings,
  type ContextBudgetSettings,
} from './context-budget.js'
import { shouldRunMidTurnCompaction } from './transcript-compaction.js'

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
})
