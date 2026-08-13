import { describe, expect, it } from 'bun:test'
import type { ChatMessage } from '../../src/core/types.js'
import {
  HISTORY_PREPEND_CHUNK,
  HISTORY_PREVIEW_MAX_CHARS,
  HISTORY_TAIL_MAX_BYTES,
  HISTORY_TAIL_MAX_MESSAGES,
  buildHistoryWireFrames,
  capHistoryPreview,
  estimateHistoryMessageBytes,
  historySessionTitle,
  historyTailStart,
  historyUpdatedAt,
  slimHistoryMessage,
  splitHistoryDelivery,
} from '../../src/web/history-payload.js'

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage {
  return {
    timestamp: new Date(0),
    ...over,
  }
}

describe('history-payload', () => {
  it('caps long activity previews and leaves short ones intact', () => {
    const huge = 'x'.repeat(HISTORY_PREVIEW_MAX_CHARS + 80)
    const slim = slimHistoryMessage(msg({
      role: 'assistant',
      content: 'ok',
      activity: {
        runId: 'r1',
        status: 'success',
        startedAt: 1,
        steps: [
          {
            id: 's1', kind: 'tool', label: 'read', status: 'success',
            startedAt: 1, preview: huge,
          },
          {
            id: 's2', kind: 'tool', label: 'short', status: 'success',
            startedAt: 2, preview: 'tiny',
          },
        ],
      },
    }))
    expect(slim.activity?.steps[0]?.preview?.length).toBe(HISTORY_PREVIEW_MAX_CHARS + 1) // + ellipsis
    expect(slim.activity?.steps[0]?.preview?.endsWith('…')).toBe(true)
    expect(slim.activity?.steps[1]?.preview).toBe('tiny')
    expect(capHistoryPreview('abc')).toBe('abc')
  })

  it('does not clone messages that need no preview cap', () => {
    const original = msg({ role: 'user', content: 'hi' })
    expect(slimHistoryMessage(original)).toBe(original)
  })

  it('keeps a short transcript as a single complete tail', () => {
    const messages = Array.from({ length: 6 }, (_, i) => msg({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }))
    const d = splitHistoryDelivery(messages)
    expect(d.tailStart).toBe(0)
    expect(d.olderCount).toBe(0)
    expect(d.tail).toHaveLength(6)
    expect(d.prepend).toEqual([])
  })

  it('windows a long transcript and prepends nearest-to-tail first', () => {
    const messages = Array.from({ length: 100 }, (_, i) => msg({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }))
    const d = splitHistoryDelivery(messages)
    expect(d.tailStart).toBeGreaterThan(0)
    expect(d.olderCount).toBe(d.tailStart)
    expect(d.tail[0]?.id).toBe(`m${d.tailStart}`)
    expect(d.tail.at(-1)?.id).toBe('m99')
    expect(d.prepend.length).toBeGreaterThan(0)
    // First prepend chunk sits immediately before the tail (no gap).
    expect(d.prepend[0]?.messages.at(-1)?.id).toBe(`m${d.tailStart - 1}`)
    expect(d.prepend[0]?.remaining).toBe(d.prepend[0]?.startIndex)
    const restored = [...d.prepend].reverse().flatMap((c) => c.messages).concat(d.tail)
    expect(restored.map((m) => m.id)).toEqual(messages.map((m) => m.id))
    expect(d.prepend[0]?.messages.length).toBeLessThanOrEqual(HISTORY_PREPEND_CHUNK)
  })

  it('still sends a huge latest reply in the tail (byte budget does not drop it)', () => {
    const huge = '报告'.repeat(HISTORY_TAIL_MAX_BYTES)
    const messages = [
      msg({ id: 'old-u', role: 'user', content: `older prompt ${'x'.repeat(8_000)}` }),
      msg({ id: 'old-a', role: 'assistant', content: `older reply ${'y'.repeat(8_000)}` }),
      msg({ id: 'new-u', role: 'user', content: 'write the report' }),
      msg({ id: 'new-a', role: 'assistant', content: huge }),
    ]
    const start = historyTailStart(messages)
    expect(start).toBeGreaterThan(0)
    const tail = messages.slice(start)
    expect(tail.some((m) => m.id === 'new-a')).toBe(true)
    expect(estimateHistoryMessageBytes(messages[3]!)).toBeGreaterThan(HISTORY_TAIL_MAX_BYTES)
  })

  it('caps tail length even when each message is tiny', () => {
    const messages = Array.from({ length: HISTORY_TAIL_MAX_MESSAGES + 15 }, (_, i) => msg({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'ok',
    }))
    const start = historyTailStart(messages)
    expect(messages.length - start).toBe(HISTORY_TAIL_MAX_MESSAGES)
  })

  it('session title comes from the first user in the full log', () => {
    expect(historySessionTitle([
      msg({ role: 'assistant', content: 'hello' }),
      msg({ role: 'user', content: '  Plan the launch \n next week  ' }),
      msg({ role: 'user', content: 'follow up' }),
    ])).toBe('Plan the launch next week')
  })

  it('wire frames send a tail history then nearest-to-tail prepends', () => {
    const messages = Array.from({ length: 90 }, (_, i) => msg({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }))
    const frames = buildHistoryWireFrames(messages, { agent: 'agim', threadId: 'web-abc' }, (m, abs) => ({
      id: m.id,
      serverIndex: abs,
    }))
    expect(frames[0]?.type).toBe('history')
    expect(frames[0]?.threadId).toBe('web-abc')
    expect(frames[0]?.historyComplete).toBe(false)
    expect(frames[0]?.sessionTitle).toBe('turn 0')
    expect((frames[0]?.olderCount as number) > 0).toBe(true)
    const prepend = frames.filter((f) => f.type === 'history-prepend')
    expect(prepend.length).toBeGreaterThan(0)
    expect(prepend.every((f) => f.threadId === 'web-abc')).toBe(true)
    expect(prepend.at(-1)?.remaining).toBe(0)
  })

  it('historyUpdatedAt is max(lastActivity, last message time)', () => {
    expect(historyUpdatedAt({
      lastActivity: new Date(1_000),
      messages: [
        msg({ role: 'user', content: 'a', timestamp: new Date(500) }),
        msg({ role: 'assistant', content: 'b', timestamp: new Date(2_500) }),
      ],
    })).toBe(2_500)
    expect(historyUpdatedAt({
      lastActivity: 9_000,
      messages: [msg({ role: 'user', content: 'a', timestamp: new Date(100) })],
    })).toBe(9_000)
    expect(historyUpdatedAt({ lastActivity: '1970-01-01T00:00:03.000Z', messages: [] })).toBe(3_000)
  })
})
