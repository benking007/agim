/**
 * useChat send ack: a late timeout must not paint "发送失败" after the
 * server already accepted the turn (or started running it).
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatIncoming, ChatOutgoing } from '@/types/ws'
import type { WsStatus } from '@/lib/api/ws'
import { SEND_ACK_TIMEOUT_MS } from './chat/chat-types'

const mocks = vi.hoisted(() => ({
  sent: [] as ChatOutgoing[],
  statusListeners: new Set<(s: WsStatus) => void>(),
  messageListeners: new Set<(msg: ChatIncoming) => void>(),
  ackOnSend: false,
  reconnect: vi.fn(),
  toastError: vi.fn(),
}))

function emitIncoming(msg: ChatIncoming): void {
  for (const fn of mocks.messageListeners) fn(msg)
}

function lastClientMsgId(): string {
  const last = [...mocks.sent].reverse().find((m) => m.type === 'message' && m.clientMsgId)
  if (!last || last.type !== 'message' || !last.clientMsgId) {
    throw new Error('no chat message with clientMsgId')
  }
  return last.clientMsgId
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
      if (mocks.ackOnSend && msg.type === 'message' && msg.clientMsgId) {
        emitIncoming({ type: 'message-accepted', clientMsgId: msg.clientMsgId })
        emitIncoming({
          type: 'run-start',
          runId: 'run-1',
          agent: 'agim',
          startedAt: new Date().toISOString(),
        })
      }
      return true
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

describe('useChat send ack', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    useAuth.setState({
      token: null, user: null, role: null, signedIn: false, ready: false,
    })
    mocks.sent.length = 0
    mocks.statusListeners.clear()
    mocks.messageListeners.clear()
    mocks.ackOnSend = false
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

  it('does not mark failed when ack arrives in the same tick as send', () => {
    mocks.ackOnSend = true
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('我们讨论下自动化任务的触发逻辑') })
    const user = result.current.state.messages.find((m) => m.role === 'user')
    expect(user?.sendStatus).toBe('sent')

    act(() => { vi.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 50) })
    const again = result.current.state.messages.find((m) => m.role === 'user')
    expect(again?.sendStatus).toBe('sent')
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.reconnect).not.toHaveBeenCalled()
    unmount()
  })

  it('does not mark failed after a late run-start once the watchdog is armed', () => {
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('盘点当前逻辑') })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('pending')

    act(() => {
      emitIncoming({
        type: 'run-start',
        runId: 'run-2',
        agent: 'agim',
        startedAt: new Date().toISOString(),
      })
    })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('sent')

    act(() => { vi.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 50) })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('sent')
    expect(mocks.toastError).not.toHaveBeenCalled()
    unmount()
  })

  it('rolls back only when the server never acks', () => {
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('hello') })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('pending')

    act(() => { vi.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 50) })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('failed')
    expect(mocks.toastError).toHaveBeenCalled()
    expect(mocks.reconnect).toHaveBeenCalled()
    unmount()
  })

  it('normal ack after send clears the watchdog', () => {
    const { result, unmount } = renderHook(() => useChat())
    act(() => { result.current.send('hello') })
    act(() => {
      emitIncoming({ type: 'message-accepted', clientMsgId: lastClientMsgId() })
    })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('sent')

    act(() => { vi.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 50) })
    expect(result.current.state.messages.find((m) => m.role === 'user')?.sendStatus).toBe('sent')
    expect(mocks.reconnect).not.toHaveBeenCalled()
    unmount()
  })
})
