/**
 * Portal Loop status poll — shared by docks + pet.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getLoop, type LoopStatusDto } from '@/lib/api/loop'

const ENDED_SHOW_MS = 10 * 60_000

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
      setLoop(null)
    }
  }, [threadId, zh])

  useEffect(() => {
    void reload()
  }, [reload, refreshKey])

  useEffect(() => {
    if (!loop?.active || !threadId) return
    const id = window.setInterval(() => { void reload() }, 4000)
    return () => window.clearInterval(id)
  }, [loop?.active, threadId, reload])

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
