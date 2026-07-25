/**
 * Portal Loop docks (replaces the blocking status strip):
 * - Aligning: bottom sheet to fill objective + exit, then confirm
 * - Ready (dispatch/verify): "Act now" sheet like ApprovalDock
 *
 * Status chrome lives on the pet — these only ask for user action.
 * Polling + pet-task formatting stay in this lazy chunk (entry budget).
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Compass, Play, Target } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { LoopStatusDto } from '@/lib/api/loop'
import { usePortalLoop } from './use-portal-loop'
import type { PetTaskItem } from './portal-pet'

export interface PortalLoopDockProps {
  threadId: string | null | undefined
  refreshKey?: number | string
  /** Compact Loop row for the pet panel / bubble. */
  onLoopPetTask?: (task: PetTaskItem | null) => void
  dark?: boolean
  /** True while an agent turn is in flight — hide Act Now. */
  busy?: boolean
  /** Approval/Ask dock already open — don't stack Act Now on top. */
  hasBlockingDock?: boolean
  flush?: boolean
  /** Send a chat/slash message on the user's behalf. */
  onSend: (text: string) => void
  className?: string
}

function buildAlignPayload(objective: string, exit: string): string {
  const o = objective.trim()
  const e = exit.trim()
  return `/loop ${o}；退出条件为${e}`
}

function actNowPrompt(loop: LoopStatusDto, zh: boolean): string {
  if (loop.bucket === 'verify') {
    return zh
      ? '请对照目标调用 loop_verdict 完成本轮验收（给出 met / summary；未达标则 gaps + nextDirection）。'
      : 'Call loop_verdict against the objective (met / summary; if unmet: gaps + nextDirection).'
  }
  return zh
    ? '开始：请拆解任务并用 call_agents 派子代理推进本轮，不要自己做调研。'
    : 'Start: decompose and call_agents to dispatch Subagents this round — do not research alone.'
}

function toPetTask(loop: LoopStatusDto, zh: boolean): PetTaskItem {
  const obj = (loop.objective || '').trim()
  const shortObj = obj.length > 36 ? `${obj.slice(0, 36)}…` : obj
  const min = loop.minRounds && loop.minRounds > 1 ? `≥${loop.minRounds}` : ''
  const round = zh
    ? `第 ${loop.round}/${loop.maxRounds} 轮${min ? `（最少 ${loop.minRounds}）` : ''}`
    : `R${loop.round}/${loop.maxRounds}${min ? ` (min ${loop.minRounds})` : ''}`
  const live = (loop.liveSubagents ?? 0) > 0
    ? (zh ? `子代理进行中 ${loop.liveSubagents}` : `${loop.liveSubagents} subagent(s) live`)
    : ''
  const usage = loop.usage
    ? (zh
      ? `派工 ${loop.usage.dispatchCount} · 独立验收 ${loop.usage.evaluatorCount}`
      : `${loop.usage.dispatchCount} dispatch · ${loop.usage.evaluatorCount} indep. eval`)
    : ''
  const label = live
    ? (zh ? '子代理进行中' : 'Subagents running')
    : loop.bucketLabel
  return {
    id: `loop-${loop.id}`,
    kind: 'loop',
    label,
    detail: [shortObj || undefined, round, live || undefined, usage].filter(Boolean).join(' · ') || undefined,
  }
}

export function PortalLoopDock({
  threadId,
  refreshKey,
  onLoopPetTask,
  dark,
  busy,
  hasBlockingDock,
  flush,
  onSend,
  className,
}: PortalLoopDockProps): JSX.Element | null {
  const { i18n } = useTranslation()
  const zh = Boolean(i18n.language?.startsWith('zh'))
  const { loop } = usePortalLoop(threadId, refreshKey)

  useEffect(() => {
    onLoopPetTask?.(loop?.active ? toPetTask(loop, zh) : null)
  }, [loop, onLoopPetTask, zh])

  useEffect(() => () => {
    onLoopPetTask?.(null)
  }, [onLoopPetTask])

  if (!loop?.active) return null
  if (loop.bucket === 'aligning') {
    return (
      <AligningDock
        loop={loop}
        dark={dark}
        flush={flush}
        zh={zh}
        onSend={onSend}
        className={className}
      />
    )
  }
  if (busy || hasBlockingDock) return null
  // HARD: while Subagents are live, do not nudge verify (or re-dispatch).
  // Main loop polls status; evaluation starts only when liveSubagents=0.
  if ((loop.liveSubagents ?? 0) > 0) return null
  if (loop.bucket === 'dispatch' || loop.bucket === 'verify') {
    return (
      <ActNowDock
        loop={loop}
        dark={dark}
        flush={flush}
        zh={zh}
        onSend={onSend}
        className={className}
      />
    )
  }
  return null
}

function AligningDock({
  loop,
  dark,
  flush,
  zh,
  onSend,
  className,
}: {
  loop: LoopStatusDto
  dark?: boolean
  flush?: boolean
  zh: boolean
  onSend: (text: string) => void
  className?: string
}): JSX.Element {
  const [objective, setObjective] = useState(loop.objective || '')
  const [exit, setExit] = useState(loop.exitDescription || '')

  useEffect(() => {
    setObjective(loop.objective || '')
    setExit(loop.exitDescription || '')
  }, [loop.objective, loop.exitDescription])

  const canConfirm = objective.trim().length > 0 && exit.trim().length > 0

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
        aria-label={zh ? 'Loop 对焦' : 'Loop aligning'}
      >
        <div className={cn(
          'flex shrink-0 items-center gap-2 border-b px-3 py-2',
          dark ? 'border-amber-500/20 bg-amber-500/10' : 'border-amber-200 bg-amber-50',
        )}>
          <span className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            dark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700',
          )}>
            <Target className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">
              {zh ? '待对焦 — 补充目标与退出条件' : 'Aligning — set objective & exit'}
            </p>
            <p className={cn('truncate text-[11px]', dark ? 'text-zinc-400' : 'text-zinc-500')}>
              {zh ? '确认后才会派子代理' : 'Subagents stay blocked until confirmed'}
            </p>
          </div>
        </div>

        <div className="space-y-2.5 px-3 py-3">
          <label className="block space-y-1">
            <span className={cn('text-[11px] font-medium', dark ? 'text-zinc-300' : 'text-zinc-600')}>
              {zh ? '目标' : 'Objective'}
            </span>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={2}
              placeholder={zh ? '例如：修好登录超时并通过回归' : 'e.g. Fix login timeout and pass regression'}
              className={cn(
                'w-full resize-none rounded-lg border px-2.5 py-2 text-sm outline-none focus:border-teal-500',
                dark
                  ? 'border-zinc-700 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-800 placeholder:text-zinc-400',
              )}
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
              placeholder={zh ? '例如：验收通过或最多3轮' : 'e.g. Acceptance pass or max 3 rounds'}
              className={cn(
                'w-full resize-none rounded-lg border px-2.5 py-2 text-sm outline-none focus:border-teal-500',
                dark
                  ? 'border-zinc-700 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-800 placeholder:text-zinc-400',
              )}
            />
          </label>
          <div className="flex justify-end pt-0.5">
            <Button
              type="button"
              size="sm"
              disabled={!canConfirm}
              onClick={() => onSend(buildAlignPayload(objective, exit))}
              className="gap-1.5"
            >
              <Compass className="h-3.5 w-3.5" />
              {zh ? '确定并开始' : 'Confirm & start'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function ActNowDock({
  loop,
  dark,
  flush,
  zh,
  onSend,
  className,
}: {
  loop: LoopStatusDto
  dark?: boolean
  flush?: boolean
  zh: boolean
  onSend: (text: string) => void
  className?: string
}): JSX.Element {
  const waitingVerify = loop.bucket === 'verify'
  const title = waitingVerify
    ? (zh ? '待验收 — 立即推进' : 'Awaiting verify — act now')
    : (zh ? '待派工 — 立即行动' : 'Awaiting dispatch — act now')
  const subtitle = waitingVerify
    ? (zh ? '让 Agent 调用 loop_verdict 对照目标验收' : 'Ask the agent to call loop_verdict')
    : (zh ? '让 Agent 拆解并用 call_agents 派子代理' : 'Ask the agent to decompose and call_agents')
  const cta = zh ? '立即行动' : 'Act now'
  const obj = (loop.objective || '').trim()
  const short = obj.length > 48 ? `${obj.slice(0, 48)}…` : obj

  return (
    <div className={cn('relative z-20 pb-1 pt-0', flush ? 'px-0' : 'px-3 sm:px-4', className)}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-2xl items-center gap-2 rounded-xl border px-3 py-2.5',
          'shadow-[0_-6px_22px_rgba(15,23,42,0.10)] ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
          waitingVerify
            ? (dark ? 'border-sky-500/30 bg-zinc-950' : 'border-sky-300/70 bg-white')
            : (dark ? 'border-emerald-500/30 bg-zinc-950' : 'border-emerald-300/70 bg-white'),
        )}
        aria-label={title}
      >
        <span className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          waitingVerify
            ? (dark ? 'bg-sky-500/20 text-sky-300' : 'bg-sky-100 text-sky-700')
            : (dark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700'),
        )}>
          <Play className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-semibold', dark ? 'text-zinc-100' : 'text-zinc-800')}>
            {title}
          </p>
          <p className={cn('truncate text-[11px]', dark ? 'text-zinc-400' : 'text-zinc-500')}>
            {short || subtitle}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => onSend(actNowPrompt(loop, zh))}
          className="shrink-0 gap-1"
        >
          <Play className="h-3.5 w-3.5" />
          {cta}
        </Button>
      </section>
    </div>
  )
}
