/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/hooks/chat/chat-types'
import {
  HIST_INDEX_KEY,
  HIST_KEY_PREFIX,
  MAX_CACHED_MESSAGES,
  MAX_CACHED_THREADS,
  applyCachedHistory,
  cachedHistoryToAction,
  readCachedHistory,
  slimCachedMessages,
  writeCachedHistory,
} from './web-history-cache'
import { initialChatState } from '@/hooks/chat/chat-reducer'
import { loadIndex } from './web-sessions'

function msg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: 1 }
}

describe('web-history-cache', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('round-trips a snapshot and hydrates reducer init', () => {
    const threadId = loadIndex().activeId
    writeCachedHistory(threadId, {
      messages: [msg('u1', 'user', 'hello'), msg('a1', 'assistant', 'hi')],
      agent: 'agim',
      thinkVariant: 'high',
    })
    const read = readCachedHistory(threadId)
    expect(read?.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(read?.agent).toBe('agim')
    const hydrated = applyCachedHistory(initialChatState, threadId)
    expect(hydrated.messages).toHaveLength(2)
    expect(hydrated.agent).toBe('agim')
    expect(hydrated.thinkVariant).toBe('high')
    expect(hydrated.clientId).toBe(threadId)
  })

  it('persists revisionAt (server clock) separately from savedAt', () => {
    const threadId = loadIndex().activeId
    const before = Date.now()
    writeCachedHistory(threadId, {
      messages: [msg('u1', 'user', 'hello'), msg('a1', 'assistant', 'hi')],
      revisionAt: 1_700_000_000_000,
    })
    const read = readCachedHistory(threadId)
    expect(read?.revisionAt).toBe(1_700_000_000_000)
    expect(read?.savedAt).toBeGreaterThanOrEqual(before)
    expect(read?.savedAt).not.toBe(1_700_000_000_000)
    const hydrated = applyCachedHistory(initialChatState, threadId)
    expect(hydrated.historyRevisionAt).toBe(1_700_000_000_000)
    const action = cachedHistoryToAction(read!)
    expect(action.updatedAt).toBe(1_700_000_000_000)
  })

  it('keeps the last N messages and slims older bodies / previews', () => {
    const many: ChatMessage[] = Array.from({ length: MAX_CACHED_MESSAGES + 10 }, (_, i) => (
      msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `${'x'.repeat(12_000)}-${i}`)
    ))
    const last = many[many.length - 1]
    if (last) {
      many[many.length - 1] = {
        ...last,
        content: 'KEEP-FULL-TAIL',
        activity: {
          runId: 'r',
          status: 'success',
          startedAt: 1,
          steps: [{
            id: 's', kind: 'tool', label: 'read', status: 'success',
            startedAt: 1, preview: 'P'.repeat(800),
          }],
        },
      }
    }
    const slim = slimCachedMessages(many)
    expect(slim).toHaveLength(MAX_CACHED_MESSAGES)
    expect(slim[0]?.id).toBe('m10')
    expect(slim.at(-1)?.content).toBe('KEEP-FULL-TAIL')
    expect(slim[0]?.content.endsWith('…')).toBe(true)
    expect((slim.at(-1)?.activity?.steps[0]?.preview?.length ?? 0) <= 281).toBe(true)
  })

  it('evicts LRU threads beyond MAX_CACHED_THREADS', () => {
    const ids = Array.from({ length: MAX_CACHED_THREADS + 2 }, (_, i) => {
      const id = `web-cachethread${String(i).padStart(2, '0')}`
      writeCachedHistory(id, { messages: [msg(`u${i}`, 'user', `t${i}`)] })
      return id
    })
    const index = JSON.parse(localStorage.getItem(HIST_INDEX_KEY) ?? '[]') as string[]
    expect(index).toHaveLength(MAX_CACHED_THREADS)
    expect(index[0]).toBe(ids[ids.length - 1])
    expect(localStorage.getItem(`${HIST_KEY_PREFIX}${ids[0]}`)).toBeNull()
    const newest = ids[ids.length - 1]
    expect(newest && readCachedHistory(newest)).not.toBeNull()
  })

  it('skips empty transcripts and unknown ids', () => {
    writeCachedHistory('web-emptythreadxx', { messages: [] })
    expect(readCachedHistory('web-emptythreadxx')).toBeNull()
    expect(readCachedHistory('not-a-thread')).toBeNull()
  })

  it('evicts another thread when setItem hits quota', () => {
    const keep = 'web-keepthreadxxxx'
    const other = 'web-otherthreadxx'
    writeCachedHistory(other, { messages: [msg('u0', 'user', 'old')] })
    const realSet = localStorage.setItem.bind(localStorage)
    let threw = false
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (!threw && key === `${HIST_KEY_PREFIX}${keep}`) {
        threw = true
        const err = new DOMException('quota', 'QuotaExceededError')
        throw err
      }
      return realSet(key, value)
    })
    writeCachedHistory(keep, { messages: [msg('u1', 'user', 'new')] })
    expect(readCachedHistory(keep)?.messages[0]?.content).toBe('new')
    vi.restoreAllMocks()
  })
})
