/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeOnIncoming } from './chat-ws-handlers'
import type { ChatAction } from './chat-reducer'

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
})
