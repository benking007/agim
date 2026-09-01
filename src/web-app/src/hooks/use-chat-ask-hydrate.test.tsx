/**
 * AskDock HTTP catch-up: when mcp__agim__ask_user is running but
 * choice-card never arrived (half-open WS), hydrate from GET /api/asks/pending.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatIncoming, ChatOutgoing } from '@/types/ws'
import type { WsStatus } from '@/lib/api/ws'
import { TAB_THREAD_KEY, THREAD_ID_KEY } from '@/lib/web-sessions'

const THREAD = 'web-aaa1111'
const CARD = {
  reqId: 'req-1',
  platform: 'web',
  threadId: THREAD,
  messageId: 'ask-pending-req-1',
  prompt: {
    body: '已用管理员执行 SQL，请继续验证？',
    choices: [
      { label: '继续验证', data: 'ask:req-1:1' },
      { label: '我来处理，稍等', data: 'ask:req-1:2' },
    ],
    meta: { kind: 'ask-user' as const, reqId: 'req-1', selectionMode: 'single' as const },
  },
}

const mocks = vi.hoisted(() => ({
  sent: [] as ChatOutgoing[],
  statusListeners: new Set<(s: WsStatus) => void>(),
  messageListeners: new Set<(msg: ChatIncoming) => void>(),
  get: vi.fn(async () => ({ pending: [], count: 0, cards: [] as typeof CARD[] })),
}))

function emitIncoming(msg: ChatIncoming): void {
  for (const fn of mocks.messageListeners) fn(msg)
}

vi.mock('@/lib/api/client', () => ({
  client: { get: (...args: unknown[]) => mocks.get(...args) },
}))

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({
    send: (msg: ChatOutgoing) => {
      mocks.sent.push(msg)
      return true
    },
    status: () => 'open' as const,
    close: () => {},
    reconnect: () => {},
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
  pullAccountSessions: vi.fn(async () => false),
  pushAccountSession: vi.fn(async () => true),
}))

import { useChat } from './use-chat'
import { useAuth } from '@/stores/auth'

describe('useChat ask_user HTTP hydrate', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem(THREAD_ID_KEY, THREAD)
    sessionStorage.setItem(TAB_THREAD_KEY, THREAD)
    useAuth.setState({
      token: null, user: null, role: null, signedIn: false, ready: false,
    })
    mocks.sent.length = 0
    mocks.statusListeners.clear()
    mocks.messageListeners.clear()
    mocks.get.mockReset()
    mocks.get.mockResolvedValue({ pending: [], count: 0, cards: [] })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    useAuth.setState({
      token: null, user: null, role: null, signedIn: false, ready: false,
    })
  })

  it('fills pendingAsks from HTTP after ask_user starts spinning without choice-card', async () => {
    const { result, unmount } = renderHook(() => useChat())
    mocks.get.mockResolvedValue({ pending: [], count: 1, cards: [CARD] })

    act(() => {
      emitIncoming({
        type: 'activity-step',
        runId: 'run-ask',
        threadId: THREAD,
        step: {
          id: 'tc-1',
          kind: 'tool',
          label: 'mcp__agim__ask_user',
          status: 'running',
          startedAt: Date.now(),
          preview: '{"choices":["继续验证"]}',
        },
      })
    })
    expect(result.current.state.pendingAsks).toEqual([])

    await act(async () => {
      vi.advanceTimersByTime(400)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.get).toHaveBeenCalledWith('/api/asks/pending')
    expect(result.current.state.pendingAsks).toHaveLength(1)
    expect(result.current.state.pendingAsks[0]?.messageId).toBe(CARD.messageId)
    expect(result.current.state.pendingAsks[0]?.prompt.body).toContain('已用管理员执行 SQL')
    unmount()
  })
})
