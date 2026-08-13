/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeOnIncoming } from './chat-ws-handlers'
import type { ChatAction } from './chat-reducer'
import { upsertSession } from '@/lib/web-sessions'

vi.mock('sonner', () => ({
  toast: {
    message: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

describe('thread-reassigned', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
  })

  it('persists the new threadId and dispatches SET_CLIENT_ID (no ERROR)', () => {
    localStorage.setItem('agim-web-thread-id', 'web-oldthreadxxxx')
    const actions: ChatAction[] = []
    const threadIdRef = { current: 'web-oldthreadxxxx' }
    const onIncoming = makeOnIncoming(
      (a) => { actions.push(a) },
      { current: null },
      () => {},
      () => {},
      { threadIdRef },
    )

    onIncoming({
      type: 'thread-reassigned',
      threadId: 'web-abc123-fresh',
      reason: 'ownership_mismatch',
    })

    expect(localStorage.getItem('agim-web-thread-id')).toBe('web-abc123-fresh')
    expect(JSON.parse(localStorage.getItem('agim-web-sessions') ?? '{}').activeId).toBe('web-abc123-fresh')
    expect(threadIdRef.current).toBe('web-abc123-fresh')
    const ids = (JSON.parse(localStorage.getItem('agim-web-sessions') ?? '{}').sessions as Array<{ id: string }>)
      .map((s) => s.id)
    expect(ids).toContain('web-abc123-fresh')
    expect(ids).not.toContain('web-oldthreadxxxx')
    expect(actions).toEqual([{ kind: 'SET_CLIENT_ID', clientId: 'web-abc123-fresh' }])
    expect(actions.some((a) => a.kind === 'ERROR')).toBe(false)
  })

  it('HISTORY first user line becomes the session title', () => {
    const threadIdRef = { current: 'web-titlethread1' }
    localStorage.setItem('agim-web-thread-id', threadIdRef.current)
    const onIncoming = makeOnIncoming(
      () => {},
      { current: null },
      () => {},
      () => {},
      { threadIdRef },
    )
    onIncoming({
      type: 'history',
      agent: 'agim',
      messages: [
        { id: 'u1', role: 'user', content: 'Plan the launch', timestamp: new Date().toISOString() },
        { id: 'a1', role: 'assistant', content: 'ok', timestamp: new Date().toISOString() },
      ],
    })
    const sessions = JSON.parse(localStorage.getItem('agim-web-sessions') ?? '{}').sessions as Array<{ id: string; title?: string }>
    expect(sessions.find((s) => s.id === 'web-titlethread1')?.title).toBe('Plan the launch')
  })

  it('HISTORY sessionTitle wins over the tail first user', () => {
    const threadIdRef = { current: 'web-titlethread2x' }
    localStorage.setItem('agim-web-thread-id', threadIdRef.current)
    const onIncoming = makeOnIncoming(
      () => {},
      { current: null },
      () => {},
      () => {},
      { threadIdRef },
    )
    onIncoming({
      type: 'history',
      agent: 'agim',
      historyComplete: false,
      olderCount: 20,
      sessionTitle: 'Original prompt',
      messages: [
        { id: 'u9', role: 'user', content: 'follow up only', timestamp: new Date().toISOString(), serverIndex: 20 },
      ],
    })
    const sessions = JSON.parse(localStorage.getItem('agim-web-sessions') ?? '{}').sessions as Array<{ id: string; title?: string }>
    expect(sessions.find((s) => s.id === 'web-titlethread2x')?.title).toBe('Original prompt')
  })

  it('incomplete HISTORY without sessionTitle does not retitle from the tail', () => {
    const threadIdRef = { current: 'web-titlethread3x' }
    localStorage.setItem('agim-web-thread-id', threadIdRef.current)
    upsertSession({ id: threadIdRef.current, title: 'Kept title', updatedAt: 1 })
    const onIncoming = makeOnIncoming(
      () => {},
      { current: null },
      () => {},
      () => {},
      { threadIdRef },
    )
    onIncoming({
      type: 'history',
      agent: 'agim',
      historyComplete: false,
      olderCount: 8,
      messages: [
        { id: 'u9', role: 'user', content: 'not the original', timestamp: new Date().toISOString() },
      ],
    })
    const sessions = JSON.parse(localStorage.getItem('agim-web-sessions') ?? '{}').sessions as Array<{ id: string; title?: string }>
    expect(sessions.find((s) => s.id === 'web-titlethread3x')?.title).toBe('Kept title')
  })

  it('history-prepend dispatches HISTORY_PREPEND', () => {
    const actions: ChatAction[] = []
    const onIncoming = makeOnIncoming(
      (a) => { actions.push(a) },
      { current: null },
      () => {},
      () => {},
    )
    onIncoming({
      type: 'history-prepend',
      remaining: 0,
      messages: [
        { id: 'u0', role: 'user', content: 'oldest', timestamp: new Date().toISOString(), serverIndex: 0 },
      ],
    })
    expect(actions).toEqual([{
      kind: 'HISTORY_PREPEND',
      messages: [expect.objectContaining({ id: 'u0', serverIndex: 0, content: 'oldest' })],
    }])
  })

  it('drops history frames that belong to another thread', () => {
    const threadIdRef = { current: 'web-currentthrd' }
    localStorage.setItem('agim-web-thread-id', threadIdRef.current)
    const actions: ChatAction[] = []
    const onIncoming = makeOnIncoming(
      (a) => { actions.push(a) },
      { current: null },
      () => {},
      () => {},
      { threadIdRef },
    )
    onIncoming({
      type: 'history',
      agent: 'agim',
      threadId: 'web-stalehistxxx',
      messages: [
        { id: 'u9', role: 'user', content: 'from other session', timestamp: new Date().toISOString() },
      ],
    })
    onIncoming({
      type: 'history-prepend',
      threadId: 'web-stalehistxxx',
      remaining: 0,
      messages: [
        { id: 'u0', role: 'user', content: 'old other', timestamp: new Date().toISOString() },
      ],
    })
    expect(actions).toEqual([])
    expect(localStorage.getItem('agim-web-sessions')).toBeNull()
  })
})
