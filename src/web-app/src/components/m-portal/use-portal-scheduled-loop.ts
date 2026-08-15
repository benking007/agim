/**
 * Pending scheduled-Loop draft (bottom dock).
 * SSOT: GET /api/loop-schedule/pending. Refresh on WS `loop-schedule-changed`.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  cancelLoopSchedule,
  confirmLoopSchedule,
  getLoopSchedulePending,
  type LoopSchedulePending,
} from '@/lib/api/loop-schedule'
import { openChatWs } from '@/lib/api/ws'

export function usePortalScheduledLoop(threadId: string | null | undefined): {
  pending: LoopSchedulePending | null
  busy: boolean
  error: string | null
  confirm: (draft: {
    timeText: string
    objective: string
    exitDescription: string
    headless: boolean
  }) => Promise<boolean>
  cancel: () => Promise<void>
} {
  const [pending, setPending] = useState<LoopSchedulePending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!threadId) {
      setPending(null)
      return
    }
    try {
      const next = await getLoopSchedulePending(threadId)
      setPending(next)
    } catch {
      // Keep last snapshot on a blip — same as usePortalLoop.
    }
  }, [threadId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!threadId) return
    const ws = openChatWs()
    const offMsg = ws.subscribe({
      type: 'message',
      fn: (msg) => {
        if (msg.type !== 'loop-schedule-changed') return
        if (msg.threadId && msg.threadId !== threadId) return
        void refresh()
      },
    })
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      offMsg()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [threadId, refresh])

  const confirm = useCallback(async (draft: {
    timeText: string
    objective: string
    exitDescription: string
    headless: boolean
  }): Promise<boolean> => {
    if (!threadId) return false
    setBusy(true)
    setError(null)
    try {
      await confirmLoopSchedule({ threadId, ...draft })
      await refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [refresh, threadId])

  const cancel = useCallback(async () => {
    if (!threadId) return
    setBusy(true)
    setError(null)
    try {
      await cancelLoopSchedule(threadId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [refresh, threadId])

  return { pending, busy, error, confirm, cancel }
}
