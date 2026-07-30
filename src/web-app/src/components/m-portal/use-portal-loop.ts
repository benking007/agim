/**
 * Portal Loop status poll — docks (and any future chrome).
 *
 * SSOT remains GET /api/loop. We also:
 *   - keep polling while a thread is mounted (not only when active), so
 *     a new Loop after 结案 is noticed mid-turn;
 *   - re-fetch on WS open / visibility / online (network jitter);
 *   - react to server `loop-changed` nudges after writeRun;
 *   - keep the last good snapshot when a poll fails (do not blank UI).
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getLoop, type LoopStatusDto } from '@/lib/api/loop'
import { openChatWs } from '@/lib/api/ws'

const ENDED_SHOW_MS = 10 * 60_000
const POLL_MS = 4000

export function usePortalLoop(
  threadId: string | null | undefined,
  refreshKey?: number | string,
): {
  loop: LoopStatusDto | null
  reload: () => Promise<void>
  dismissEnded: () => void
} {
  const { i18n } = useTranslation()
  const zh = i18n.language?.startsWith('zh')
  const [loop, setLoop] = useState<LoopStatusDto | null>(null)
  const [dismissedId, setDismissedId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!threadId) {
      setLoop(null)
      return
    }
    try {
      const res = await getLoop({ threadId, lang: zh ? 'zh' : 'en' })
      setLoop(res.loop ?? null)
    } catch {
      // Network blip / tab resume: keep last known Loop chrome instead of
      // wiping docks to "no loop".
    }
  }, [threadId, zh])

  useEffect(() => {
    // refreshKey bumps after send / history / WS status so we re-poll ASAP
    void refreshKey
    void reload()
  }, [reload, refreshKey])

  // Always poll while the Portal thread is mounted — after 结案,
  // loop.active is false and a follow-up may start a new Loop mid-turn
  // without changing messages.length.
  useEffect(() => {
    if (!threadId) return
    const id = window.setInterval(() => { void reload() }, POLL_MS)
    return () => window.clearInterval(id)
  }, [threadId, reload])

  // Reconnect / tab focus / back online → pull SSOT again.
  useEffect(() => {
    if (!threadId) return
    const ws = openChatWs()
    const offStatus = ws.subscribe({
      type: 'status',
      fn: (s) => {
        if (s === 'open') void reload()
      },
    })
    const offMsg = ws.subscribe({
      type: 'message',
      fn: (msg) => {
        if (msg.type !== 'loop-changed') return
        if (msg.threadId && msg.threadId !== threadId) return
        void reload()
      },
    })
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void reload()
    }
    const onOnline = (): void => { void reload() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      offStatus()
      offMsg()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [threadId, reload])

  let visible = loop
  if (visible && dismissedId === visible.id) visible = null
  if (visible && !visible.active) {
    const age = Date.now() - (visible.updatedAt || 0)
    if (age > ENDED_SHOW_MS) visible = null
  }

  return {
    loop: visible,
    reload,
    dismissEnded: () => {
      if (loop) setDismissedId(loop.id)
    },
  }
}

export type { LoopStatusDto }
