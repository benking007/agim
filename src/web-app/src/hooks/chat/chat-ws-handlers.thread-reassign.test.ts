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
    const actions: ChatAction[] = []
    const onIncoming = makeOnIncoming(
      (a) => { actions.push(a) },
      { current: null },
      () => {},
      () => {},
    )

    onIncoming({
      type: 'thread-reassigned',
      threadId: 'web-abc123-fresh',
      reason: 'ownership_mismatch',
    })

    expect(localStorage.getItem('agim-web-thread-id')).toBe('web-abc123-fresh')
    expect(actions).toEqual([{ kind: 'SET_CLIENT_ID', clientId: 'web-abc123-fresh' }])
    expect(actions.some((a) => a.kind === 'ERROR')).toBe(false)
  })
})
