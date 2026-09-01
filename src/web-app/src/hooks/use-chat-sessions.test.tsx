/**
 * useChat multi-session: New conversation forks a web-* thread instead of
 * wiping the current log; switch reloads via get-history.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatIncoming, ChatOutgoing } from '@/types/ws'
import type { WsStatus } from '@/lib/api/ws'

const mocks = vi.hoisted(() => ({
  sent: [] as ChatOutgoing[],
  statusListeners: new Set<(s: WsStatus) => void>(),
  messageListeners: new Set<(msg: ChatIncoming) => void>(),
  pullAccountSessions: vi.fn(async () => false),
  pushAccountSession: vi.fn(async () => true),
}))

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({
    send: (msg: ChatOutgoing) => {
      mocks.sent.push(msg)
      return true
    },
    status: () => 'open' as const,
    close: () => {},
    reconnect: () => {
      for (const fn of mocks.statusListeners) fn('connecting')
      for (const fn of mocks.statusListeners) fn('open')
    },
    subscribe: (l: { type: string; fn: (x: never) => void }) => {
      if (l.type === 'status') {
        mocks.statusListeners.add(l.fn as (s: WsStatus) => void)
        ;(l.fn as (s: WsStatus) => void)('open')
        return () => { mocks.statusListeners.delete(l.fn as (s: WsStatus) => void) }
      }
      if (l.type === 'message') {
        mocks.messageListeners.add(l.fn as (msg: ChatIncoming) => void)
        return () => { mocks.messageListeners.delete(l.fn as (msg: ChatIncoming) => void) }
      }
      return () => {}
    },
  }),
}))

vi.mock('@/lib/web-session-sync', () => ({
  pullAccountSessions: (...args: unknown[]) => mocks.pullAccountSessions(...args),
  pushAccountSession: (...args: unknown[]) => mocks.pushAccountSession(...args),
}))

import { useChat } from './use-chat'
import { clearChatIslands } from './chat/chat-session-islands'
import { THREAD_ID_KEY, SESSIONS_KEY, findSession, listSessions } from '@/lib/web-sessions'
import { addLocalWorkspace, listWorkspaces } from '@/lib/web-workspaces'
import { writeCachedHistory } from '@/lib/web-history-cache'
import { useAuth } from '@/stores/auth'

describe('useChat multi-session', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    useAuth.setState({
      token: null, user: null, role: null, signedIn: false, ready: false,
    })
    mocks.sent.length = 0
    mocks.statusListeners.clear()
    mocks.messageListeners.clear()
    mocks.pullAccountSessions.mockClear()
    mocks.pushAccountSession.mockClear()
    clearChatIslands()
  })

  afterEach(() => {
    clearChatIslands()
    useAuth.setState({
      token: null, user: null, role: null, signedIn: false, ready: false,
    })
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

  it('send attaches the active local workspace path', () => {
    addLocalWorkspace({ name: 'agim', path: '/tmp/agim-portal-ws' })
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('list this workspace') })
    expect(mocks.sent.some((m) => (
      m.type === 'message'
      && m.text === 'list this workspace'
      && m.workspacePath === '/tmp/agim-portal-ws'
    ))).toBe(true)
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

  it('keeps a background run on the previous island and restores it', () => {
    const { result, unmount } = renderHook(() => useChat())
    const firstId = result.current.activeSessionId
    act(() => { result.current.send('hello from first') })
    const replyId = result.current.state.currentReplyId
    expect(replyId).toBeTruthy()

    act(() => { result.current.newConversation() })
    expect(result.current.activeSessionId).not.toBe(firstId)
    expect(result.current.busyThreadIds).toContain(firstId)
    expect(result.current.state.messages).toEqual([])

    act(() => {
      for (const fn of mocks.messageListeners) {
        fn({ type: 'chunk', text: '后台流式', threadId: firstId })
      }
    })
    expect(result.current.state.messages).toEqual([])

    act(() => { result.current.switchSession(firstId) })
    expect(result.current.state.currentReplyId).toBe(replyId)
    expect(result.current.state.messages.some((m) => m.content.includes('后台流式'))).toBe(true)
    unmount()
  })

  it('archiveSession drops the thread from the rail and switches away', () => {
    const { result, unmount } = renderHook(() => useChat())
    const firstId = result.current.activeSessionId
    act(() => { result.current.send('keep this') })
    act(() => { result.current.newConversation() })
    const secondId = result.current.activeSessionId
    act(() => { result.current.send('archive this') })
    act(() => { result.current.archiveSession(secondId) })
    expect(result.current.sessions.some((s) => s.id === secondId)).toBe(false)
    expect(result.current.sessions.some((s) => s.id === firstId)).toBe(true)
    expect(result.current.activeSessionId).toBe(firstId)
    unmount()
  })

  it('renameSession updates the rail title and pushes to the account', () => {
    const { result, unmount } = renderHook(() => useChat())
    const id = result.current.activeSessionId
    act(() => { result.current.send('first prompt becomes title') })
    act(() => { result.current.renameSession(id, 'My custom name') })
    expect(findSession(id)?.title).toBe('My custom name')
    expect(mocks.pushAccountSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: id, title: 'My custom name' }),
    )
    unmount()
  })

  it('archiveWorkspace hides the folder and its sessions', () => {
    const ws = addLocalWorkspace({ name: 'proj', path: '/tmp/proj-archive' })
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('seed') })
    act(() => { result.current.newConversation() })
    expect(findSession(result.current.activeSessionId)?.workspaceId).toBe(ws.id)
    act(() => { result.current.send('in proj') })
    act(() => { result.current.archiveWorkspace(ws.id) })
    expect(result.current.sessions.every((s) => s.workspaceId !== ws.id)).toBe(true)
    expect(listSessions().every((s) => s.workspaceId !== ws.id)).toBe(true)
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

  it('createWorkspace mints a session under a newly added folder', () => {
    const { result, unmount } = renderHook(() => useChat())
    const previousId = result.current.activeSessionId
    act(() => { result.current.send('stay on cloud') })
    act(() => {
      result.current.createWorkspace({ name: 'other-proj', path: '/tmp/other-proj' })
    })
    const nextId = result.current.activeSessionId
    expect(nextId).not.toBe(previousId)
    expect(findSession(nextId)?.workspaceId).not.toBe('cloud')
    expect(findSession(previousId)?.workspaceId).toBe('cloud')
    expect(result.current.state.messages).toEqual([])
    expect(listWorkspaces().some((w) => w.path === '/tmp/other-proj')).toBe(true)
    expect(mocks.sent.some((m) => (
      m.type === 'set-workspace' && m.workspacePath === '/tmp/other-proj'
    ))).toBe(true)
    unmount()
  })

  it('createWorkspace does not mint again when the folder already exists', () => {
    addLocalWorkspace({ name: 'other-proj', path: '/tmp/other-proj' })
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('already here') })
    const previousId = result.current.activeSessionId
    const before = result.current.sessions.length
    act(() => {
      result.current.createWorkspace({ name: 'other-proj', path: '/tmp/other-proj' })
    })
    expect(result.current.activeSessionId).toBe(previousId)
    expect(result.current.sessions).toHaveLength(before)
    unmount()
  })

  it('send and archive push the session to the account API', () => {
    const { result, unmount } = renderHook(() => useChat())
    const firstId = result.current.activeSessionId
    act(() => { result.current.send('hello sync') })
    expect(mocks.pushAccountSession).toHaveBeenCalledWith(expect.objectContaining({
      threadId: firstId,
      title: 'hello sync',
    }))

    act(() => { result.current.newConversation() })
    const secondId = result.current.activeSessionId
    act(() => { result.current.send('archive me') })
    mocks.pushAccountSession.mockClear()
    act(() => { result.current.archiveSession(secondId) })
    expect(mocks.pushAccountSession).toHaveBeenCalledWith(expect.objectContaining({
      threadId: secondId,
      archivedAt: expect.any(Number),
    }))
    unmount()
  })

  it('switching the signed-in user drops the previous transcript', () => {
    act(() => {
      useAuth.getState().setUser({
        id: 'usr_aaaaaa', username: 'alice', displayName: 'alice', role: 'user',
      })
    })
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('copy files for Alice') })
    const oldId = result.current.activeSessionId
    expect(result.current.state.messages.some((m) => m.content === 'copy files for Alice')).toBe(true)

    act(() => {
      useAuth.getState().setUser({
        id: 'usr_bbbbbb', username: 'bob', displayName: 'bob', role: 'user',
      })
    })

    expect(result.current.state.messages.some((m) => m.content === 'copy files for Alice')).toBe(false)
    expect(result.current.activeSessionId).not.toBe(oldId)
    expect(listSessions().some((s) => s.title === 'copy files for Alice')).toBe(false)
    unmount()
  })
})
