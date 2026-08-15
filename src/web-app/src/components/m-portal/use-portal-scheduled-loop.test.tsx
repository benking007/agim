import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import type { ChatIncoming } from '@/types/ws'

const getPending = vi.fn()
const confirmSchedule = vi.fn()
const wsSend = vi.fn()
const toastSuccess = vi.fn()
const messageListeners = new Set<(m: ChatIncoming) => void>()

vi.mock('@/lib/api/loop-schedule', () => ({
  getLoopSchedulePending: (...args: unknown[]) => getPending(...args),
  confirmLoopSchedule: (...args: unknown[]) => confirmSchedule(...args),
  cancelLoopSchedule: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args) },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'zh' } }),
}))

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({
    send: (...args: unknown[]) => wsSend(...args),
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
    confirmSchedule.mockReset()
    wsSend.mockReset()
    toastSuccess.mockReset()
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

  it('refetches when refreshKey changes (after the assistant reply)', async () => {
    getPending
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        cron: '0 2 * * *',
        timeText: '每天凌晨2点',
        objective: '修登录',
        exitDescription: '验收通过',
        headless: false,
        createdAt: 3,
      })
    const { result, rerender } = renderHook(
      ({ key }) => usePortalScheduledLoop('thread-1', key),
      { initialProps: { key: '0' } },
    )
    await waitFor(() => {
      expect(result.current.pending).toBeNull()
    })
    rerender({ key: '1' })
    await waitFor(() => {
      expect(result.current.pending?.objective).toBe('修登录')
    })
  })

  it('toasts success and reloads history after confirm', async () => {
    getPending.mockResolvedValue(null)
    confirmSchedule.mockResolvedValue({
      ok: true,
      id: 5,
      nextIso: '2026-08-16T02:00:00.000Z',
    })
    const { result } = renderHook(() => usePortalScheduledLoop('thread-1'))
    await waitFor(() => {
      expect(result.current.confirm).toBeTypeOf('function')
    })
    await result.current.confirm({
      timeText: '每天凌晨2点',
      objective: '修登录',
      exitDescription: '验收通过',
      headless: false,
    })
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('已创建定时 Loop #5'),
    )
    expect(wsSend).toHaveBeenCalledWith({ type: 'get-history', threadId: 'thread-1' })
  })
})
