/**
 * ChatActivityBlock — Cursor-style in-thread run accordion.
 *
 * Collapsed: "Running ›" / "Worked · 3 steps · 4.2s ›"
 * When waiting on A2A: subtitle "Waiting for subagent"
 * Expanded: ordered tool / approval / ask / agent steps with status + preview.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  MessageCircleQuestion,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-react'

import type { ChatActivity, ChatActivityStep } from '@/hooks/use-chat'
import { cn } from '@/lib/utils'

export interface ChatActivityBlockProps {
  activity: ChatActivity
  className?: string
}

function formatDuration(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

function StepIcon({ step }: { step: ChatActivityStep }): JSX.Element {
  const cls = 'h-3.5 w-3.5 shrink-0'
  if (step.status === 'running' || step.status === 'pending') {
    return <Loader2 className={cn(cls, 'animate-spin text-text-muted')} />
  }
  if (step.status === 'denied' || step.status === 'error') {
    return <X className={cn(cls, 'text-danger')} />
  }
  if (step.kind === 'approval') return <ShieldAlert className={cn(cls, 'text-warning')} />
  if (step.kind === 'ask') return <MessageCircleQuestion className={cn(cls, 'text-info')} />
  if (step.kind === 'agent') return <Bot className={cn(cls, 'text-accent')} />
  if (step.kind === 'skill') return <Wrench className={cn(cls, 'text-accent')} />
  if (step.status === 'success') return <Check className={cn(cls, 'text-success')} />
  return <Wrench className={cn(cls, 'text-text-muted')} />
}

function AgentStatusBadge({ step }: { step: ChatActivityStep }): JSX.Element | null {
  const { t } = useTranslation()
  if (step.kind !== 'agent') return null
  if (step.status === 'running' || step.status === 'pending') {
    return (
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
        {t('chat.activityAgentRunning', { defaultValue: 'running' })}
      </span>
    )
  }
  if (step.status === 'success') {
    return (
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
        {t('chat.activityAgentDone', { defaultValue: 'completed' })}
      </span>
    )
  }
  if (step.status === 'error' || step.status === 'denied') {
    return (
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-danger">
        {t('chat.activityAgentFailed', { defaultValue: 'failed' })}
      </span>
    )
  }
  return null
}

export function ChatActivityBlock({ activity, className }: ChatActivityBlockProps): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(activity.status === 'running')

  useEffect(() => {
    if (activity.status === 'running') setOpen(true)
  }, [activity.status])

  const stepCount = activity.steps.length
  const liveStep = [...activity.steps].reverse().find((s) => (
    s.status === 'running' || s.status === 'pending'
  ))
  const waitingAgent = liveStep?.kind === 'agent' ? liveStep : undefined
  const duration = formatDuration(activity.durationMs)
  const running = activity.status === 'running'

  let title: string
  if (running) {
    title = liveStep
      ? t('chat.activityRunningStep', {
          step: liveStep.label,
          defaultValue: 'Running · {{step}}',
        })
      : t('chat.activityRunning', { defaultValue: 'Running' })
  } else if (activity.status === 'error') {
    title = t('chat.activityFailed', { defaultValue: 'Failed' })
  } else {
    const parts = [t('chat.activityWorked', { defaultValue: 'Worked' })]
    if (stepCount > 0) {
      parts.push(t('chat.activityStepCount', {
        count: stepCount,
        defaultValue: '{{count}} steps',
      }))
    }
    if (duration) parts.push(duration)
    title = parts.join(' · ')
  }

  return (
    <div className={cn('w-full max-w-[85%] sm:max-w-[75%]', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'group inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5',
          'text-[13px] text-text-dim transition hover:bg-surface-2 hover:text-text',
        )}
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted" />
        ) : activity.status === 'error' ? (
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger" />
        ) : null}
        <span className="truncate font-medium tracking-tight">{title}</span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
      </button>

      {waitingAgent && (
        <p className="mt-0.5 pl-1.5 text-xs text-text-muted">
          {t('chat.activityWaitingSubagent', {
            agent: waitingAgent.label,
            defaultValue: 'Waiting for subagent',
          })}
        </p>
      )}

      {open && (
        <div className="mt-1.5 space-y-1 border-l border-border/80 pl-3">
          {stepCount === 0 && (
            <p className="text-xs text-text-muted">
              {running
                ? t('chat.activityWaitingSteps', {
                    defaultValue: 'Waiting for tool activity…',
                  })
                : t('chat.activityNoSteps', {
                    defaultValue: 'No tool steps recorded for this turn.',
                  })}
            </p>
          )}
          {activity.steps.map((step) => (
            <div key={step.id} className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12px] text-text-dim">
                <StepIcon step={step} />
                <span className={cn(
                  'truncate text-[12px] text-text',
                  step.kind === 'agent' ? 'font-medium' : 'font-mono',
                )}
                >
                  {step.kind === 'agent'
                    ? t('chat.activityAgentLabel', {
                        agent: step.label,
                        defaultValue: '→ {{agent}}',
                      })
                    : step.label}
                </span>
                {step.kind === 'approval' && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
                    {t('chat.activityApproval', { defaultValue: 'approval' })}
                  </span>
                )}
                {step.kind === 'ask' && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
                    {t('chat.activityAsk', { defaultValue: 'ask' })}
                  </span>
                )}
                {step.kind === 'skill' && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
                    {t('chat.activitySkill', { defaultValue: 'skill' })}
                  </span>
                )}
                <AgentStatusBadge step={step} />
              </div>
              {step.preview && (
                <pre className="mt-0.5 max-h-20 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-2/80 px-2 py-1 font-mono text-[11px] leading-snug text-text-muted">
                  {step.preview.length > 280 ? `${step.preview.slice(0, 280)}…` : step.preview}
                </pre>
              )}
            </div>
          ))}
          {activity.error && (
            <p className="text-xs text-danger">{activity.error}</p>
          )}
        </div>
      )}
    </div>
  )
}
