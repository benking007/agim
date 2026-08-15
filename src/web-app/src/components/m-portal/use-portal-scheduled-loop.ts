/**
 * Pending scheduled-Loop draft (bottom dock).
 * SSOT: GET /api/loop-schedule/pending. Refresh on WS `loop-schedule-changed`.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  cancelLoopSchedule,
  confirmLoopSchedule,
  getLoopSchedulePending,
  type LoopSchedulePending,
} from '@/lib/api/loop-schedule'
import { openChatWs } from '@/lib/api/ws'

const POLL_MS = 3000

export function usePortalScheduledLoop(
  threadId: string | null | undefined,
  refreshKey?: number | string,
): {
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
  const { i18n } = useTranslation()
  const zh = i18n.language?.startsWith('zh') ?? true
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
    void refreshKey
    void refresh()
  }, [refresh, refreshKey])

  useEffect(() => {
    if (!threadId) return
    const id = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => window.clearInterval(id)
  }, [threadId, refresh])

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
      const created = await confirmLoopSchedule({ threadId, ...draft })
      toast.success(zh
        ? `已创建定时 Loop #${created.id}${created.nextIso ? `，下次 ${created.nextIso}` : ''}`
        : `Scheduled Loop #${created.id} created${created.nextIso ? `. Next ${created.nextIso}` : ''}`)
      openChatWs().send({ type: 'get-history', threadId })
      await refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [refresh, threadId, zh])

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
