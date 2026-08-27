/**
 * useChat send: once the frame is handed to the socket, missing server
 * ack must not paint「发送失败」. No delivery watchdog.
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
  sendOk: true,
  reconnect: vi.fn(),
  toastError: vi.fn(),
}))

function emitIncoming(msg: ChatIncoming): void {
  for (const fn of mocks.messageListeners) fn(msg)
}

vi.mock('sonner', () => ({
  toast: {
    message: vi.fn(),
    info: vi.fn(),
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: vi.fn(),
  },
}))

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({
    send: (msg: ChatOutgoing) => {
      mocks.sent.push(msg)
      return mocks.sendOk
    },
    status: () => 'open' as const,
    close: () => {},
    reconnect: () => mocks.reconnect(),
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
  reconnectChatWs: () => { mocks.reconnect() },
}))

vi.mock('@/lib/web-session-sync', () => ({
  pullAccountSessions: vi.fn(async () => false),
  pushAccountSession: vi.fn(async () => true),
}))

import { useChat } from './use-chat'
import { useAuth } from '@/stores/auth'

describe('useChat send (no ack watchdog)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    useAuth.setState({
      token: null, user: null, role: null, signedIn: false, ready: false,
    })
    mocks.sent.length = 0
    mocks.statusListeners.clear()
    mocks.messageListeners.clear()
    mocks.sendOk = true
    mocks.reconnect.mockClear()
    mocks.toastError.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    useAuth.setState({
      token: null, user: null, role: null, signedIn: false, ready: false,
    })
  })

  it('marks the bubble sent as soon as the frame is handed to the socket', () => {
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('盯住兴业银锡的股价') })
    const user = result.current.state.messages.find((m) => m.role === 'user')
    expect(user?.sendStatus).toBe('sent')
    expect(mocks.sent.some((m) => m.type === 'message')).toBe(true)
    unmount()
  })

  it('does not paint 发送失败 when the server never acks', () => {
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('hello') })
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('sent')
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.reconnect).not.toHaveBeenCalled()
    unmount()
  })

  it('keeps the bubble sent when run-start arrives later', () => {
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('盘点当前逻辑') })
    act(() => {
      emitIncoming({
        type: 'run-start',
        runId: 'run-2',
        agent: 'agim',
        startedAt: new Date().toISOString(),
      })
    })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('sent')
    expect(result.current.state.activeRunId).toBe('run-2')
    unmount()
  })

  it('toasts not-connected without painting 发送失败 when the socket is closed', () => {
    mocks.sendOk = false
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('hello') })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('sent')
    expect(mocks.toastError).toHaveBeenCalled()
    unmount()
  })
})
