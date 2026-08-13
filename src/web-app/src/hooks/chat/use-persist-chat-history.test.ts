/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/hooks/chat/chat-types'
import { persistIdleHistory } from './use-persist-chat-history'
import { readCachedHistory, writeCachedHistory } from '@/lib/web-history-cache'

function msg(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 1 }
}

describe('persistIdleHistory', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('does not write the new transcript into the previous thread cache', () => {
    const a = 'web-threadaxxxx'
    const b = 'web-threadbxxxx'
    writeCachedHistory(a, { messages: [msg('u1', 'old')] })
    persistIdleHistory(a, b, { messages: [msg('u2', 'new')] })
    expect(readCachedHistory(a)?.messages[0]?.content).toBe('old')
    expect(readCachedHistory(b)).toBeNull()
  })

  it('writes when the tab is still on the same thread', () => {
    const id = 'web-threadsamex'
    persistIdleHistory(id, id, { messages: [msg('u1', 'keep')] })
    expect(readCachedHistory(id)?.messages[0]?.content).toBe('keep')
  })
})
