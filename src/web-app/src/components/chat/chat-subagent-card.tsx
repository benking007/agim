/**
 * ChatSubagentCard — inline Subagent status card in the message list
 * (sibling of ChatTodoList / Plan). Shows live work state; click a row
 * to open prompt + result modal.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Check,
  ChevronRight,
  Loader2,
  X,
} from 'lucide-react'

import type { ChatActivity, ChatActivityStep } from '@/hooks/use-chat'
import {
  countLiveSubagents,
  isSubagentLive,
  listSubagentSteps,
} from '@/lib/activity-subagent'
import { cn } from '@/lib/utils'
import { SubagentDetailDialog } from './subagent-detail-dialog'

export interface ChatSubagentCardProps {
  activity: ChatActivity
  dark?: boolean
  className?: string
}

function StatusIcon({
  step,
  dark,
}: {
  step: ChatActivityStep
  dark?: boolean
}): JSX.Element {
  const cls = 'h-3.5 w-3.5 shrink-0'
  if (isSubagentLive(step)) {
    return <Loader2 className={cn(cls, 'animate-spin text-teal-500')} />
  }
  if (step.status === 'error' || step.status === 'denied') {
    return <X className={cn(cls, 'text-danger')} />
  }
  if (step.status === 'success') {
    return <Check className={cn(cls, 'text-emerald-500')} strokeWidth={2.5} />
  }
  return <Bot className={cn(cls, dark ? 'text-zinc-500' : 'text-text-muted')} />
}

function statusLabel(
  step: ChatActivityStep,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (isSubagentLive(step)) {
    return t('chat.activityWaitingSubagent', { defaultValue: 'Waiting for subagent' })
  }
  if (step.status === 'success') {
    return t('chat.activityAgentDone', { defaultValue: 'completed' })
  }
  if (step.status === 'error' || step.status === 'denied') {
    return t('chat.activityAgentFailed', { defaultValue: 'failed' })
  }
  return step.status
}

function SubagentRow({
  step,
  dark,
  onOpen,
}: {
  step: ChatActivityStep
  dark?: boolean
  onOpen: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const live = isSubagentLive(step)
  const detail = (step.preview || '').trim()

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition',
          dark ? 'hover:bg-zinc-900/80' : 'hover:bg-surface-2/80',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <StatusIcon step={step} dark={dark} />
          <span className={cn(
            'min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight',
            live
              ? (dark ? 'text-zinc-100' : 'text-text')
              : (dark ? 'text-zinc-300' : 'text-text-dim'),
          )}
          >
            {t('chat.activityAgentLabel', {
              agent: step.label,
              defaultValue: '→ {{agent}}',
            })}
          </span>
          <span className={cn(
            'shrink-0 text-[10px] uppercase tracking-wide',
            dark ? 'text-zinc-500' : 'text-text-muted',
          )}
          >
            {t('chat.activitySubagentBadge', { defaultValue: 'subagent' })}
          </span>
        </div>
        {detail && (
          <p className={cn(
            'truncate pl-5 text-[12px] leading-snug',
            dark ? 'text-zinc-500' : 'text-text-muted',
          )}
          >
            {detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}
          </p>
        )}
        <p className={cn(
          'pl-5 text-[11px] leading-snug',
          live
            ? (dark ? 'text-teal-400/90' : 'text-teal-700')
            : (dark ? 'text-zinc-600' : 'text-text-muted'),
        )}
        >
          {statusLabel(step, t)}
          <span className="ml-1.5 opacity-70">
            · {t('chat.subagentOpenHint', { defaultValue: 'View prompt & result' })}
          </span>
        </p>
      </button>
    </li>
  )
}

export function ChatSubagentCard({
  activity,
  dark,
  className,
}: ChatSubagentCardProps): JSX.Element | null {
  const { t } = useTranslation()
  const steps = listSubagentSteps(activity)
  const liveCount = countLiveSubagents(steps)
  const running = activity.status === 'running'
  const hasSteps = steps.length > 0

  const [open, setOpen] = useState(true)
  const [detailStep, setDetailStep] = useState<ChatActivityStep | null>(null)

  useEffect(() => {
    if (!hasSteps) return
    if (running || liveCount > 0) setOpen(true)
    else setOpen(false)
  }, [running, hasSteps, liveCount])

  if (!hasSteps) return null

  const title = liveCount > 0
    ? t('chat.subagentCardTitleLive', {
        count: liveCount,
        defaultValue: 'Subagents · {{count}} waiting',
      })
    : t('chat.subagentCardTitleDone', {
        count: steps.length,
        defaultValue: 'Subagents · {{count}}',
      })

  return (
    <div className={cn('w-full max-w-[85%] sm:max-w-[75%]', className)}>
      <div
        className={cn(
          'overflow-hidden rounded-xl border',
          dark
            ? 'border-zinc-800 bg-zinc-950/60'
            : 'border-border/70 bg-surface/80',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left transition',
            dark ? 'hover:bg-zinc-900/80' : 'hover:bg-surface-2/80',
          )}
        >
          <Bot
            className={cn(
              'h-4 w-4 shrink-0',
              liveCount > 0 ? 'text-teal-500' : 'text-emerald-500',
            )}
          />
          <span className={cn(
            'min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight',
            dark ? 'text-zinc-200' : 'text-text',
          )}
          >
            {title}
          </span>
          {liveCount > 0 && (
            <span className={cn(
              'shrink-0 text-[10px] uppercase tracking-wide',
              dark ? 'text-teal-400/80' : 'text-teal-600',
            )}
            >
              {t('chat.todoInProgress', { defaultValue: 'in progress' })}
            </span>
          )}
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
              dark ? 'text-zinc-500' : 'text-text-muted',
              open && 'rotate-90',
            )}
          />
        </button>

        {open && (
          <ul
            className={cn(
              'space-y-0.5 border-t px-1 py-1.5',
              dark ? 'border-zinc-800' : 'border-border/60',
            )}
          >
            {steps.map((step) => (
              <SubagentRow
                key={step.id}
                step={step}
                dark={dark}
                onOpen={() => setDetailStep(step)}
              />
            ))}
          </ul>
        )}
      </div>

      <SubagentDetailDialog
        open={detailStep != null}
        onOpenChange={(next) => { if (!next) setDetailStep(null) }}
        step={detailStep}
        dark={dark}
      />
    </div>
  )
}
