import { afterEach, describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  CLEARED_TOOL_RESULT_PREFIX,
  applyClearingToPreparation,
  clearToolResultsInMessages,
  estimateMessagesTokens,
  isExcludedToolName,
  resolveContextBudgetSettings,
  type ToolClearingSettings,
} from './context-budget.js'

function toolResult(name: string, text: string, id = `c-${name}`): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  }
}

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function big(n: number): string {
  return 'x'.repeat(n)
}

const BASE_CLEAR: ToolClearingSettings = {
  enabled: true,
  triggerTokens: 100, // low so tests trip easily
  keepToolUses: 2,
  clearAtLeastChars: 100,
  excludeTools: ['memory', 'save_memo', 'long_task', 'ask_user'],
}

describe('isExcludedToolName', () => {
  it('matches exact, suffix, and mcp-style names', () => {
    expect(isExcludedToolName('save_memo', ['save_memo'])).toBe(true)
    expect(isExcludedToolName('mcp__agim__save_memo', ['save_memo'])).toBe(true)
    expect(isExcludedToolName('memory_query', ['memory'])).toBe(true)
    expect(isExcludedToolName('agim_read_file', ['memory', 'save_memo'])).toBe(false)
  })
})

describe('clearToolResultsInMessages', () => {
  afterEach(() => {
    delete process.env.AGIM_CTX_CLEAR
    delete process.env.AGIM_CTX_CLEAR_TRIGGER_TOKENS
    delete process.env.AGIM_CTX_COMPACT_RESERVE_TOKENS
  })

  it('keeps the most recent N tool results and clears older bulky ones', () => {
    const messages: AgentMessage[] = [
      user('go'),
      toolResult('agim_read_file', big(5_000), 't1'),
      toolResult('agim_read_file', big(5_000), 't2'),
      toolResult('agim_read_file', big(5_000), 't3'),
      toolResult('agim_read_file', big(5_000), 't4'),
    ]
    const r = clearToolResultsInMessages(messages, BASE_CLEAR)
    expect(r.applied).toBe(true)
    expect(r.clearedCount).toBe(2)
    expect(r.charsFreed).toBeGreaterThanOrEqual(10_000)
    // oldest two cleared
    const t1 = r.messages[1]
    const t2 = r.messages[2]
    const t3 = r.messages[3]
    const t4 = r.messages[4]
    expect(t1?.role).toBe('toolResult')
    expect(t2?.role).toBe('toolResult')
    expect(t3?.role).toBe('toolResult')
    expect(t4?.role).toBe('toolResult')
    if (t1?.role === 'toolResult') {
      expect(t1.content[0] && 'text' in t1.content[0] ? t1.content[0].text : '').toContain(CLEARED_TOOL_RESULT_PREFIX)
    }
    if (t2?.role === 'toolResult') {
      expect(t2.content[0] && 'text' in t2.content[0] ? t2.content[0].text : '').toContain(CLEARED_TOOL_RESULT_PREFIX)
    }
    // newest two kept verbatim
    if (t3?.role === 'toolResult') {
      expect(t3.content[0] && 'text' in t3.content[0] ? t3.content[0].text : '').toBe(big(5_000))
    }
    if (t4?.role === 'toolResult') {
      expect(t4.content[0] && 'text' in t4.content[0] ? t4.content[0].text : '').toBe(big(5_000))
    }
  })

  it('does not clear excluded memory / goal tools', () => {
    const messages: AgentMessage[] = [
      user('go'),
      toolResult('mcp__agim__save_memo', big(5_000), 'm1'),
      toolResult('long_task', big(5_000), 'g1'),
      toolResult('agim_read_file', big(5_000), 'r1'),
      toolResult('agim_read_file', big(5_000), 'r2'),
      toolResult('agim_read_file', big(5_000), 'r3'),
    ]
    const r = clearToolResultsInMessages(messages, { ...BASE_CLEAR, keepToolUses: 1 })
    expect(r.applied).toBe(true)
    // save_memo + long_task intact; older read_file cleared; last read kept
    const memo = r.messages[1]
    const goal = r.messages[2]
    const oldRead = r.messages[3]
    if (memo?.role === 'toolResult') {
      expect(memo.content[0] && 'text' in memo.content[0] ? memo.content[0].text : '').toBe(big(5_000))
    }
    if (goal?.role === 'toolResult') {
      expect(goal.content[0] && 'text' in goal.content[0] ? goal.content[0].text : '').toBe(big(5_000))
    }
    if (oldRead?.role === 'toolResult') {
      expect(oldRead.content[0] && 'text' in oldRead.content[0] ? oldRead.content[0].text : '')
        .toContain(CLEARED_TOOL_RESULT_PREFIX)
    }
  })

  it('is a no-op below the trigger threshold', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      toolResult('agim_read_file', big(500), 't1'),
    ]
    const r = clearToolResultsInMessages(messages, {
      ...BASE_CLEAR,
      triggerTokens: 1_000_000,
    })
    expect(r.applied).toBe(false)
    expect(r.messages).toBe(messages)
  })

  it('does not double-clear already cleared results', () => {
    const messages: AgentMessage[] = [
      user('go'),
      toolResult('agim_read_file', `${CLEARED_TOOL_RESULT_PREFIX} agim_read_file; originalChars=5000; re-call]`, 't1'),
      toolResult('agim_read_file', big(5_000), 't2'),
      toolResult('agim_read_file', big(5_000), 't3'),
    ]
    const r = clearToolResultsInMessages(messages, { ...BASE_CLEAR, keepToolUses: 1, clearAtLeastChars: 100 })
    // only t2 is eligible (t1 already cleared, t3 kept)
    expect(r.clearedCount).toBe(1)
  })

  it('applyClearingToPreparation clears summarizer inputs aggressively', () => {
    const prep = {
      firstKeptEntryId: 'keep',
      messagesToSummarize: [
        user('q'),
        toolResult('agim_read_file', big(3_000), 'a'),
        toolResult('agim_read_file', big(3_000), 'b'),
      ] as AgentMessage[],
      turnPrefixMessages: [] as AgentMessage[],
      isSplitTurn: false,
      tokensBefore: 9_000,
      fileOps: { reads: new Map(), writes: new Map(), edits: new Map() },
      settings: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 20_000 },
    }
    // fileOps shape may not match exactly — cast through unknown for the test
    const out = applyClearingToPreparation(prep as never, BASE_CLEAR)
    expect(out.messagesToSummarize).not.toBe(prep.messagesToSummarize)
    const first = out.messagesToSummarize[1]
    if (first?.role === 'toolResult') {
      expect(first.content[0] && 'text' in first.content[0] ? first.content[0].text : '')
        .toContain(CLEARED_TOOL_RESULT_PREFIX)
    }
  })
})

describe('resolveContextBudgetSettings', () => {
  afterEach(() => {
    delete process.env.AGIM_CTX_CLEAR
    delete process.env.AGIM_NATIVE_COMPACTION
    delete process.env.AGIM_CTX_COMPACT_RESERVE_TOKENS
    delete process.env.AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS
    delete process.env.AGIM_CTX_CLEAR_TRIGGER_TOKENS
    delete process.env.AGIM_CTX_CLEAR_KEEP_TOOL_USES
  })

  it('honours env overrides for compact reserve / keep', () => {
    process.env.AGIM_CTX_COMPACT_RESERVE_TOKENS = '12000'
    process.env.AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS = '30000'
    const s = resolveContextBudgetSettings(200_000)
    expect(s.compaction.reserveTokens).toBe(12_000)
    expect(s.compaction.keepRecentTokens).toBe(30_000)
    expect(s.compactInstructions).toContain('bgjob')
  })

  it('applies late-compaction defaults on a 1M window', () => {
    const s = resolveContextBudgetSettings(1_000_000)
    expect(s.compaction.reserveTokens).toBe(48_000)
    expect(s.compaction.keepRecentTokens).toBe(32_000)
    expect(s.clearing.triggerTokens).toBe(150_000)
    expect(s.clearing.keepToolUses).toBe(8)
  })

  it('clamps reserve/keep on small windows so compact is not always-on', () => {
    const s = resolveContextBudgetSettings(32_000)
    expect(s.compaction.reserveTokens).toBe(8_192)
    expect(s.compaction.keepRecentTokens).toBe(8_192)
    // Threshold stays positive: window - reserve > 0
    expect(32_000 - s.compaction.reserveTokens).toBeGreaterThan(0)
  })

  it('disables clearing when AGIM_CTX_CLEAR=off', () => {
    process.env.AGIM_CTX_CLEAR = 'off'
    const s = resolveContextBudgetSettings(128_000)
    expect(s.clearing.enabled).toBe(false)
  })
})

describe('estimateMessagesTokens', () => {
  it('grows with payload size', () => {
    const small = estimateMessagesTokens([toolResult('t', 'hi')])
    const large = estimateMessagesTokens([toolResult('t', big(8_000))])
    expect(large).toBeGreaterThan(small)
  })
})
