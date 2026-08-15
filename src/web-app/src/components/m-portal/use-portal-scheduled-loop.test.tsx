import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import type { ChatIncoming } from '@/types/ws'

const getPending = vi.fn()
const messageListeners = new Set<(m: ChatIncoming) => void>()

vi.mock('@/lib/api/loop-schedule', () => ({
  getLoopSchedulePending: (...args: unknown[]) => getPending(...args),
  confirmLoopSchedule: vi.fn(),
  cancelLoopSchedule: vi.fn(),
}))

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({
    send: () => true,
    status: () => 'open' as const,
    close: () => {},
    subscribe: (l: { type: string; fn: (x: never) => void }) => {
      if (l.type === 'message') {
        messageListeners.add(l.fn as (m: ChatIncoming) => void)
        return () => { messageListeners.delete(l.fn as (m: ChatIncoming) => void) }
      }
      return () => {}
    },
  }),
}))

import { usePortalScheduledLoop } from './use-portal-scheduled-loop'

describe('usePortalScheduledLoop', () => {
  beforeEach(() => {
    getPending.mockReset()
    messageListeners.clear()
  })

  it('loads the pending draft', async () => {
    getPending.mockResolvedValue({
      cron: '0 2 * * *',
      timeText: '每天凌晨2点',
      objective: '修登录',
      exitDescription: '验收通过',
      headless: false,
      createdAt: 1,
    })
    const { result } = renderHook(() => usePortalScheduledLoop('thread-1'))
    await waitFor(() => {
      expect(result.current.pending?.objective).toBe('修登录')
    })
  })

  it('refetches on loop-schedule-changed for this thread', async () => {
    getPending
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        cron: '0 2 * * *',
        timeText: '每天凌晨2点',
        objective: '修登录',
        exitDescription: '验收通过',
        headless: false,
        createdAt: 2,
      })
    const { result } = renderHook(() => usePortalScheduledLoop('thread-1'))
    await waitFor(() => {
      expect(result.current.pending).toBeNull()
    })
    for (const fn of messageListeners) {
      fn({ type: 'loop-schedule-changed', threadId: 'thread-1' })
    }
    await waitFor(() => {
      expect(result.current.pending?.cron).toBe('0 2 * * *')
    })
  })
})
