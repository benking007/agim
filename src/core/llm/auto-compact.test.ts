// auto-compact — focused unit tests. We can't easily integration-test
// with a real provider, so the tests use a stub summarizer that records
// the prompt it sees and returns a canned summary.

import { describe, it, expect } from 'bun:test'
import { maybeCompactHistory } from './auto-compact.js'
import type { LlmProvider, LlmMessage } from './provider-base.js'

function stubProvider(summary: string, opts: { failing?: boolean } = {}): LlmProvider {
  return {
    name: 'stub-summarizer',
    providerType: 'openai-compat',
    capabilities: { tools: false, streaming: false },
    chat: async () => {
      if (opts.failing) throw new Error('stub: summarizer down')
      return {
        text: summary,
        finishReason: 'stop',
        usage: { totalTokens: 10 },
      }
    },
    chatStream: async function* () { /* unused */ },
  } as unknown as LlmProvider
}

function bigMsg(role: 'user' | 'assistant', i: number, chars: number): LlmMessage {
  return { role, content: `[${role} #${i}] ` + 'x'.repeat(chars) }
}

describe('maybeCompactHistory', () => {
  it('is a no-op when total chars under trigger', async () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const r = await maybeCompactHistory(messages, {
      triggerChars: 1000,
      summarizer: stubProvider('SUMMARY'),
    })
    expect(r.compacted).toBe(false)
    expect(r.messages).toBe(messages) // same reference
  })

  it('compacts older turns when over trigger, preserving last keepTurns pairs', async () => {
    const messages: LlmMessage[] = []
    // 10 user/assistant pairs, each ~1100 chars → total ~22_000 chars
    for (let i = 0; i < 10; i++) {
      messages.push(bigMsg('user', i, 1000))
      messages.push(bigMsg('assistant', i, 100))
    }
    const r = await maybeCompactHistory(messages, {
      triggerChars: 5_000,
      keepTurns: 3,
      summarizer: stubProvider('FRESH SUMMARY HERE'),
    })
    expect(r.compacted).toBe(true)
    expect(r.collapsedCount).toBeGreaterThan(0)
    // First message should be the synthetic summary entry.
    expect(r.messages[0].role).toBe('user')
    expect(r.messages[0].content).toContain('earlier conversation summary')
    expect(r.messages[0].content).toContain('FRESH SUMMARY HERE')
    // The 3 most recent user/assistant pairs must remain verbatim.
    const tail = r.messages.slice(-6)
    expect(tail.filter((m) => m.role === 'user')).toHaveLength(3)
  })

  it('falls back to no-op when summarizer throws', async () => {
    const messages: LlmMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push(bigMsg('user', i, 1000))
      messages.push(bigMsg('assistant', i, 100))
    }
    const r = await maybeCompactHistory(messages, {
      triggerChars: 5_000,
      summarizer: stubProvider('', { failing: true }),
    })
    expect(r.compacted).toBe(false)
    expect(r.messages).toBe(messages)
  })

  it('triggerChars=0 disables compaction entirely', async () => {
    const messages: LlmMessage[] = []
    for (let i = 0; i < 20; i++) messages.push(bigMsg('user', i, 5000))
    const r = await maybeCompactHistory(messages, {
      triggerChars: 0,
      summarizer: stubProvider('SHOULD-NOT-RUN'),
    })
    expect(r.compacted).toBe(false)
  })

  it('never leaves orphan role:tool at head of recent slice (regression CR-2026-05)', async () => {
    // History where the most-recent assistant turns are tool-call round
    // trips. The naive bump-forward implementation accepted a tool
    // message at the head of the tail, causing the provider to reject
    // the request with HTTP 400.
    const messages: LlmMessage[] = []
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'user', content: `[user #${i}] ` + 'x'.repeat(1200) })
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `call_${i}`, name: 'foo', arguments: {} }],
      })
      messages.push({ role: 'tool', toolCallId: `call_${i}`, content: 'result ' + i })
      messages.push({ role: 'assistant', content: `[ans #${i}]` })
    }
    const r = await maybeCompactHistory(messages, {
      triggerChars: 5_000,
      keepTurns: 3,
      summarizer: stubProvider('SUMMARY'),
    })
    expect(r.compacted).toBe(true)
    // First message must be the synthetic user summary; second must be
    // a real user message (never role:'tool' or assistant w/ toolCalls).
    expect(r.messages[0].role).toBe('user')
    expect(r.messages[1].role).toBe('user')
  })
})
