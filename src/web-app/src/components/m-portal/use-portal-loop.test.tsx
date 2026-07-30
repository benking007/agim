/**
 * usePortalLoop — resync on WS open / loop-changed; keep last snapshot on error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

import type { LoopStatusDto } from '@/lib/api/loop'
import type { WsStatus } from '@/lib/api/ws'
import type { ChatIncoming } from '@/types/ws'

const getLoop = vi.fn()
const statusListeners = new Set<(s: WsStatus) => void>()
const messageListeners = new Set<(m: ChatIncoming) => void>()

vi.mock('@/lib/api/loop', () => ({
  getLoop: (...args: unknown[]) => getLoop(...args),
}))

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({
    send: () => true,
    status: () => 'open' as const,
    close: () => {},
    subscribe: (l: { type: string; fn: (x: never) => void }) => {
      if (l.type === 'status') {
        statusListeners.add(l.fn as (s: WsStatus) => void)
        // Match real openChatWs: replay current status
        ;(l.fn as (s: WsStatus) => void)('open')
        return () => { statusListeners.delete(l.fn as (s: WsStatus) => void) }
      }
      if (l.type === 'message') {
        messageListeners.add(l.fn as (m: ChatIncoming) => void)
        return () => { messageListeners.delete(l.fn as (m: ChatIncoming) => void) }
      }
      return () => {}
    },
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'zh' } }),
}))

import { usePortalLoop } from './use-portal-loop'

function activeLoop(id = 'loop-1'): LoopStatusDto {
  return {
    id,
    status: 'dispatching',
    bucket: 'dispatch',
    bucketLabel: '待派工',
    active: true,
    round: 1,
    minRounds: 1,
    maxRounds: 5,
    objective: 'ship',
    exitDescription: 'done',
    dispatchesThisRound: 0,
    liveSubagents: 0,
    canVerify: false,
    updatedAt: Date.now(),
  }
}

describe('usePortalLoop', () => {
  beforeEach(() => {
    getLoop.mockReset()
    statusListeners.clear()
    messageListeners.clear()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps last snapshot when a later poll fails (network blip)', async () => {
    getLoop
      .mockResolvedValueOnce({ ok: true, loop: activeLoop() })
      .mockRejectedValueOnce(new Error('network'))

    const { result } = renderHook(() => usePortalLoop('thread-1', 0))
    await waitFor(() => expect(result.current.loop?.id).toBe('loop-1'))

    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.loop?.id).toBe('loop-1')
  })

  it('reloads on loop-changed for this thread', async () => {
    getLoop
      .mockResolvedValueOnce({ ok: true, loop: null })
      .mockResolvedValueOnce({ ok: true, loop: activeLoop('loop-new') })

    const { result } = renderHook(() => usePortalLoop('thread-1', 0))
    await waitFor(() => expect(getLoop).toHaveBeenCalled())

    await act(async () => {
      for (const fn of messageListeners) {
        fn({ type: 'loop-changed', threadId: 'thread-1' })
      }
    })
    await waitFor(() => expect(result.current.loop?.id).toBe('loop-new'))
  })

  it('ignores loop-changed for other threads', async () => {
    getLoop.mockResolvedValue({ ok: true, loop: activeLoop('loop-1') })
    const { result } = renderHook(() => usePortalLoop('thread-1', 0))
    await waitFor(() => expect(result.current.loop?.id).toBe('loop-1'))
    const calls = getLoop.mock.calls.length

    await act(async () => {
      for (const fn of messageListeners) {
        fn({ type: 'loop-changed', threadId: 'other' })
      }
    })
    expect(getLoop.mock.calls.length).toBe(calls)
    expect(result.current.loop?.id).toBe('loop-1')
  })
})
