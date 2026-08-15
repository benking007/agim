/**
 * Bottom sheet to confirm a scheduled Loop (time + objective + exit).
 * Mirrors AligningDock: amber floating card above the composer.
 * Never writes cron until the user taps 创建.
 */

import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { usePortalScheduledLoop } from './use-portal-scheduled-loop'

export interface PortalScheduledLoopDockProps {
  threadId: string | null | undefined
  dark?: boolean
  flush?: boolean
  className?: string
}

export const PortalScheduledLoopDock = memo(function PortalScheduledLoopDock({
  threadId,
  dark,
  flush,
  className,
}: PortalScheduledLoopDockProps): JSX.Element | null {
  const { i18n } = useTranslation()
  const zh = i18n.language?.startsWith('zh') ?? true
  const { pending, busy, error, confirm, cancel } = usePortalScheduledLoop(threadId)
  if (!pending) return null
  return (
    <ScheduledLoopDock
      key={`${pending.createdAt}:${pending.cron}:${pending.objective}`}
      timeText={pending.timeText || pending.cronLabel || pending.cron}
      objective={pending.objective}
      exitDescription={pending.exitDescription}
      headless={pending.headless}
      cronHint={pending.cron}
      dark={dark}
      flush={flush}
      zh={zh}
      busy={busy}
      error={error}
      onConfirm={confirm}
      onCancel={cancel}
      className={className}
    />
  )
})

function ScheduledLoopDock({
  timeText: initialTime,
  objective: initialObjective,
  exitDescription: initialExit,
  headless: initialHeadless,
  cronHint,
  dark,
  flush,
  zh,
  busy,
  error,
  onConfirm,
  onCancel,
  className,
}: {
  timeText: string
  objective: string
  exitDescription: string
  headless: boolean
  cronHint?: string
  dark?: boolean
  flush?: boolean
  zh: boolean
  busy: boolean
  error: string | null
  onConfirm: (draft: {
    timeText: string
    objective: string
    exitDescription: string
    headless: boolean
  }) => Promise<boolean>
  onCancel: () => Promise<void>
  className?: string
}): JSX.Element {
  const [timeText, setTimeText] = useState(initialTime)
  const [objective, setObjective] = useState(initialObjective)
  const [exit, setExit] = useState(initialExit)
  const [headless, setHeadless] = useState(initialHeadless)

  useEffect(() => {
    setTimeText(initialTime)
    setObjective(initialObjective)
    setExit(initialExit)
    setHeadless(initialHeadless)
  }, [initialTime, initialObjective, initialExit, initialHeadless])

  const canConfirm = timeText.trim().length > 0
    && objective.trim().length > 0
    && exit.trim().length > 0
    && !busy

  const fieldClass = cn(
    'w-full resize-none rounded-lg border px-2.5 py-2 text-sm outline-none focus:border-teal-500',
    dark
      ? 'border-zinc-700 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500'
      : 'border-zinc-200 bg-zinc-50 text-zinc-800 placeholder:text-zinc-400',
  )

  return (
    <div className={cn('relative z-20 pb-1 pt-0', flush ? 'px-0' : 'px-3 sm:px-4', className)}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-2xl flex-col',
          'rounded-xl border shadow-[0_-6px_22px_rgba(15,23,42,0.10)] ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
          dark
            ? 'border-amber-500/30 bg-zinc-950 text-zinc-100'
            : 'border-amber-300/60 bg-white text-zinc-800',
        )}
        aria-label={zh ? '定时 Loop 确认' : 'Confirm scheduled Loop'}
        data-testid="scheduled-loop-dock"
      >
        <div className={cn(
          'flex shrink-0 items-center gap-2 border-b px-3 py-2',
          dark ? 'border-amber-500/20 bg-amber-500/10' : 'border-amber-200 bg-amber-50',
        )}>
          <span className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            dark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700',
          )}>
            <Clock className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">
              {zh ? '定时 Loop — 确认后才会写入 cron' : 'Scheduled Loop — confirm to write cron'}
            </p>
            <p className={cn('truncate text-[11px]', dark ? 'text-zinc-400' : 'text-zinc-500')}>
              {zh
                ? '补齐时间、目标、退出条件；到点在专用线程跑一轮，不抢当前对话'
                : 'Fill time, objective, exit. Fires on a dedicated thread.'}
              {cronHint ? ` · ${cronHint}` : ''}
            </p>
          </div>
        </div>

        <div className="space-y-2.5 px-3 py-3">
          <label className="block space-y-1">
            <span className={cn('text-[11px] font-medium', dark ? 'text-zinc-300' : 'text-zinc-600')}>
              {zh ? '定时时间' : 'Schedule'}
            </span>
            <input
              value={timeText}
              onChange={(e) => setTimeText(e.target.value)}
              placeholder={zh ? '例如：每天凌晨2点 或 0 2 * * *' : 'e.g. every day 2am or 0 2 * * *'}
              className={fieldClass}
            />
          </label>
          <label className="block space-y-1">
            <span className={cn('text-[11px] font-medium', dark ? 'text-zinc-300' : 'text-zinc-600')}>
              {zh ? '目标' : 'Objective'}
            </span>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={2}
              placeholder={zh ? '例如：修好登录超时并通过回归' : 'e.g. Fix login timeout and pass regression'}
              className={fieldClass}
            />
          </label>
          <label className="block space-y-1">
            <span className={cn('text-[11px] font-medium', dark ? 'text-zinc-300' : 'text-zinc-600')}>
              {zh ? '退出条件' : 'Exit condition'}
            </span>
            <textarea
              value={exit}
              onChange={(e) => setExit(e.target.value)}
              rows={2}
              placeholder={zh ? '例如：验收通过或最多5轮' : 'e.g. Acceptance pass or max 5 rounds'}
              className={fieldClass}
            />
          </label>
          <label className="flex items-center gap-2 pt-0.5 text-[12px]">
            <input
              type="checkbox"
              checked={headless}
              onChange={(e) => setHeadless(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300"
            />
            <span className={dark ? 'text-zinc-300' : 'text-zinc-600'}>
              {zh ? '无人值守（达标后自动结案）' : 'Headless (auto-end when met)'}
            </span>
          </label>
          {error ? (
            <p className={cn('text-[11px]', dark ? 'text-rose-300' : 'text-rose-700')}>{error}</p>
          ) : null}
          <div className="flex justify-end gap-2 pt-0.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => { void onCancel() }}
            >
              <X className="h-3.5 w-3.5" />
              {zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canConfirm}
              onClick={() => {
                void onConfirm({
                  timeText: timeText.trim(),
                  objective: objective.trim(),
                  exitDescription: exit.trim(),
                  headless,
                })
              }}
              className="gap-1.5"
            >
              <Clock className="h-3.5 w-3.5" />
              {zh ? '创建' : 'Create'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
