/**
 * Portal Loop status strip (R5) — one-line chrome above composer docks.
 * Shows where the Loop is stuck: 对焦 / 派工 / 验收, or a compact end summary.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, X } from 'lucide-react'

import { api } from '@/lib/api/endpoints'
import { cn } from '@/lib/utils'

export type LoopStatusDto = {
  id: string
  status: string
  bucket: 'aligning' | 'dispatch' | 'verify' | 'ended'
  bucketLabel: string
  active: boolean
  round: number
  maxRounds: number
  objective: string
  exitDescription: string
  acceptance?: string
  dispatchesThisRound: number
  endReason?: string
  lastVerification?: {
    met: boolean
    summary: string
    gaps?: string[]
    nextDirection?: string
  }
  updatedAt: number
}

export interface PortalLoopStatusProps {
  threadId: string | null | undefined
  dark?: boolean
  /** Bump to force refresh (e.g. after send / history). */
  refreshKey?: number | string
  onFillStatus?: () => void
  className?: string
}

const ENDED_SHOW_MS = 10 * 60_000

function bucketTone(bucket: LoopStatusDto['bucket'], dark?: boolean): string {
  switch (bucket) {
    case 'aligning':
      return dark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-100 text-amber-800'
    case 'dispatch':
      return dark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-800'
    case 'verify':
      return dark ? 'bg-sky-500/15 text-sky-300' : 'bg-sky-100 text-sky-800'
    case 'ended':
      return dark ? 'bg-zinc-500/20 text-zinc-300' : 'bg-zinc-200 text-zinc-700'
  }
}

export function PortalLoopStatus({
  threadId,
  dark,
  refreshKey,
  onFillStatus,
  className,
}: PortalLoopStatusProps): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [loop, setLoop] = useState<LoopStatusDto | null>(null)
  const [dismissedId, setDismissedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!threadId) {
      setLoop(null)
      return
    }
    try {
      const lang = i18n.language?.startsWith('zh') ? 'zh' : 'en'
      const res = await api.getLoop({ threadId, lang })
      setLoop(res.loop ?? null)
    } catch {
      // fail-soft — strip just hides
      setLoop(null)
    }
  }, [threadId, i18n.language])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  // Light poll while active so phase advances across agent turns
  useEffect(() => {
    if (!loop?.active || !threadId) return
    const id = window.setInterval(() => { void load() }, 4000)
    return () => window.clearInterval(id)
  }, [loop?.active, threadId, load])

  if (!loop) return null
  if (dismissedId === loop.id) return null
  if (!loop.active) {
    const age = Date.now() - (loop.updatedAt || 0)
    if (age > ENDED_SHOW_MS) return null
  }

  const objective = (loop.objective || '').trim()
  const shortObj = objective.length > 42 ? `${objective.slice(0, 42)}…` : objective

  return (
    <div
      className={cn(
        'mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs',
        dark
          ? 'border-zinc-700/80 bg-zinc-900/90 text-zinc-200'
          : 'border-zinc-200 bg-white/90 text-zinc-800 shadow-sm',
        className,
      )}
      role="status"
      aria-label={t('chat.portal.loop.stripAria')}
    >
      <RefreshCw className={cn(
        'mt-0.5 h-3.5 w-3.5 shrink-0',
        loop.active && loop.bucket !== 'aligning' ? 'text-emerald-500' : 'text-zinc-400',
      )} />
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => onFillStatus?.()}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn(
            'inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            bucketTone(loop.bucket, dark),
          )}>
            {loop.bucketLabel || t(`chat.portal.loop.bucket.${loop.bucket}`)}
          </span>
          {loop.active ? (
            <span className={dark ? 'text-zinc-400' : 'text-zinc-500'}>
              {t('chat.portal.loop.round', { round: loop.round, max: loop.maxRounds })}
            </span>
          ) : (
            <span className={dark ? 'text-zinc-400' : 'text-zinc-500'}>
              {loop.endReason === 'objective_met'
                ? t('chat.portal.loop.endedMet')
                : t('chat.portal.loop.ended')}
            </span>
          )}
        </div>
        {shortObj ? (
          <div className={cn(
            'mt-0.5 truncate',
            dark ? 'text-zinc-300' : 'text-zinc-700',
          )}>
            {shortObj}
          </div>
        ) : null}
        {!loop.active && loop.lastVerification?.summary ? (
          <div className={cn(
            'mt-0.5 line-clamp-2',
            dark ? 'text-zinc-400' : 'text-zinc-600',
          )}>
            {loop.lastVerification.summary}
          </div>
        ) : null}
        {loop.active && loop.bucket === 'aligning' ? (
          <div className={cn('mt-0.5', dark ? 'text-amber-200/80' : 'text-amber-800/80')}>
            {t('chat.portal.loop.hintAlign')}
          </div>
        ) : null}
        {loop.active && loop.bucket === 'dispatch' ? (
          <div className={cn('mt-0.5', dark ? 'text-emerald-200/80' : 'text-emerald-800/80')}>
            {t('chat.portal.loop.hintDispatch')}
          </div>
        ) : null}
        {loop.active && loop.bucket === 'verify' ? (
          <div className={cn('mt-0.5', dark ? 'text-sky-200/80' : 'text-sky-800/80')}>
            {t('chat.portal.loop.hintVerify')}
          </div>
        ) : null}
      </button>
      {!loop.active ? (
        <button
          type="button"
          className={cn(
            'shrink-0 rounded-md p-1',
            dark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100',
          )}
          aria-label={t('chat.portal.loop.dismiss')}
          onClick={() => setDismissedId(loop.id)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}
