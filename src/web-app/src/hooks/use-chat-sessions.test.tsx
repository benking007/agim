/**
 * useChat multi-session: New conversation forks a web-* thread instead of
 * wiping the current log; switch reloads via get-history.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatOutgoing } from '@/types/ws'
import type { WsStatus } from '@/lib/api/ws'

const mocks = vi.hoisted(() => ({
  sent: [] as ChatOutgoing[],
  statusListeners: new Set<(s: WsStatus) => void>(),
}))

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({
    send: (msg: ChatOutgoing) => {
      mocks.sent.push(msg)
      return true
    },
    status: () => 'open' as const,
    close: () => {},
    subscribe: (l: { type: string; fn: (x: never) => void }) => {
      if (l.type === 'status') {
        mocks.statusListeners.add(l.fn as (s: WsStatus) => void)
        ;(l.fn as (s: WsStatus) => void)('open')
        return () => { mocks.statusListeners.delete(l.fn as (s: WsStatus) => void) }
      }
      return () => {}
    },
  }),
}))

import { useChat } from './use-chat'
import { THREAD_ID_KEY, SESSIONS_KEY, findSession, listSessions } from '@/lib/web-sessions'
import { writeCachedHistory } from '@/lib/web-history-cache'

describe('useChat multi-session', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mocks.sent.length = 0
    mocks.statusListeners.clear()
  })

  it('does not mint a second empty thread on New conversation', () => {
    const { result, unmount } = renderHook(() => useChat())
    const firstId = result.current.activeSessionId
    act(() => { result.current.newConversation() })
    expect(result.current.sessions).toHaveLength(1)
    expect(result.current.activeSessionId).toBe(firstId)
    expect(mocks.sent.some((m) => m.type === 'new-conversation')).toBe(false)
    unmount()
  })

  it('forks a new thread after a user turn and keeps the previous id', () => {
    const { result, unmount } = renderHook(() => useChat())
    const firstId = result.current.activeSessionId

    act(() => { result.current.send('hello from first') })
    act(() => { result.current.newConversation() })

    expect(mocks.sent.some((m) => m.type === 'new-conversation')).toBe(false)
    expect(result.current.sessions.length).toBe(2)
    expect(result.current.sessions.some((s) => s.id === firstId)).toBe(true)
    const nextId = result.current.activeSessionId
    expect(nextId).not.toBe(firstId)
    expect(localStorage.getItem(THREAD_ID_KEY)).toBe(nextId)
    expect(result.current.state.messages).toEqual([])

    const historyCalls = mocks.sent.filter((m) => m.type === 'get-history')
    expect(historyCalls.at(-1)).toEqual({ type: 'get-history', threadId: nextId })
    unmount()
  })

  it('switchSession reloads the previous thread via get-history', () => {
    const { result, unmount } = renderHook(() => useChat())
    const firstId = result.current.activeSessionId

    act(() => { result.current.send('hello from first') })
    act(() => { result.current.newConversation() })
    const secondId = result.current.activeSessionId

    act(() => { result.current.switchSession(firstId) })
    expect(result.current.activeSessionId).toBe(firstId)
    expect(localStorage.getItem(THREAD_ID_KEY)).toBe(firstId)
    expect(listSessions().some((s) => s.id === secondId)).toBe(true)

    const historyCalls = mocks.sent.filter((m) => m.type === 'get-history')
    expect(historyCalls.at(-1)).toEqual({ type: 'get-history', threadId: firstId })
    unmount()
  })

  it('switchSession does not refresh the previous thread updatedAt', () => {
    const { result, unmount } = renderHook(() => useChat())
    const firstId = result.current.activeSessionId
    act(() => { result.current.send('hello from first') })
    const stamped = findSession(firstId)?.updatedAt
    expect(stamped).toBeGreaterThan(0)

    act(() => { result.current.newConversation() })
    act(() => { result.current.switchSession(firstId) })
    expect(findSession(firstId)?.updatedAt).toBe(stamped)
    unmount()
  })

  it('switchSession paints the cached transcript immediately', () => {
    const { result, unmount } = renderHook(() => useChat())
    const firstId = result.current.activeSessionId
    act(() => { result.current.send('hello from first') })
    act(() => { result.current.newConversation() })
    expect(result.current.state.messages).toEqual([])

    act(() => { result.current.switchSession(firstId) })
    expect(result.current.activeSessionId).toBe(firstId)
    expect(result.current.state.messages.some((m) => m.content === 'hello from first')).toBe(true)
    unmount()
  })

  it('reconnect bootstrap uses the active thread, not the first-mount id', () => {
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('stay') })
    act(() => { result.current.newConversation() })
    const nextId = result.current.activeSessionId

    act(() => {
      for (const fn of mocks.statusListeners) fn('open')
    })
    const historyCalls = mocks.sent.filter((m) => m.type === 'get-history')
    expect(historyCalls.at(-1)).toEqual({ type: 'get-history', threadId: nextId })
    unmount()
  })

  it('refresh hydrates this tab thread even if localStorage activeId moved', () => {
    const { result, unmount } = renderHook(() => useChat())
    const tabId = result.current.activeSessionId
    act(() => { result.current.send('only in this tab') })
    writeCachedHistory(tabId, { messages: result.current.state.messages })
    unmount()

    const other = `web-othertab${'x'.repeat(4)}`
    localStorage.setItem(THREAD_ID_KEY, other)
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({
      activeId: other,
      sessions: [
        { id: other, updatedAt: 2, title: 'other' },
        { id: tabId, updatedAt: 1, title: 'this' },
      ],
    }))

    const { result: again, unmount: unmount2 } = renderHook(() => useChat())
    expect(again.current.activeSessionId).toBe(tabId)
    expect(again.current.state.messages.some((m) => m.content === 'only in this tab')).toBe(true)
    unmount2()
  })
})
