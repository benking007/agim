/**
 * PortalRunStatus — single in-thread run affordance for Agent Portal.
 *
 * Merges the ChatGPT-style "RUNNING…" + dots look with expandable tool
 * records (from ChatActivityBlock). One surface for live + completed turns.
 */

import { lazy, Suspense, useState, type ComponentType } from 'react'
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
  type LucideIcon,
} from 'lucide-react'

import type { ChatActivity, ChatActivityStep } from '@/hooks/use-chat'
import { isTodoActivityStep } from '@/lib/activity-todo'
import { cn } from '@/lib/utils'

const ChatTodoList = lazy(async () => {
  const module = await import('@/components/chat/chat-todo-list')
  return { default: module.ChatTodoList }
})

export interface PortalRunStatusProps {
  dark: boolean
  agentName: string
  agentColor: string
  AgentIcon: LucideIcon | ComponentType<{ className?: string }>
  /** Present once RUN_START / activity-step has attached. */
  activity?: ChatActivity
  /** True while this reply is still the live streaming target. */
  streaming?: boolean
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

const COMPACTING_CONTEXT_LABEL = 'Compacting context'

function countKinds(activity: ChatActivity): {
  tools: number
  skills: number
  asks: number
  total: number
} {
  let tools = 0
  let skills = 0
  let asks = 0
  for (const step of activity.steps) {
    if (step.kind === 'skill') skills += 1
    else if (step.kind === 'ask') asks += 1
    else if (step.kind === 'status') {
      // Status rows (e.g. compaction) are not tool calls.
    } else if (step.kind === 'tool') tools += 1
    else if (step.kind !== 'agent' && step.kind !== 'approval') tools += 1
  }
  return { tools, skills, asks, total: activity.steps.length }
}

function StepIcon({ step, dark }: { step: ChatActivityStep; dark: boolean }): JSX.Element {
  const cls = 'h-3.5 w-3.5 shrink-0'
  if (step.status === 'running' || step.status === 'pending') {
    return <Loader2 className={cn(cls, 'animate-spin text-teal-500')} />
  }
  if (step.status === 'denied' || step.status === 'error') {
    return <X className={cn(cls, 'text-red-400')} />
  }
  if (step.kind === 'approval') return <ShieldAlert className={cn(cls, 'text-amber-400')} />
  if (step.kind === 'ask') return <MessageCircleQuestion className={cn(cls, 'text-sky-400')} />
  if (step.kind === 'agent') return <Bot className={cn(cls, 'text-teal-400')} />
  if (step.status === 'success') return <Check className={cn(cls, 'text-emerald-400')} />
  return <Wrench className={cn(cls, dark ? 'text-zinc-500' : 'text-zinc-400')} />
}

function stepLabel(
  step: ChatActivityStep,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (step.kind === 'agent') {
    return t('chat.activityAgentLabel', {
      agent: step.label,
      defaultValue: '→ {{agent}}',
    })
  }
  if (step.kind === 'status' && step.label === COMPACTING_CONTEXT_LABEL) {
    return t('chat.activityCompacting', { defaultValue: 'Compacting context' })
  }
  if (isTodoActivityStep(step)) {
    return t('chat.todoActivityLabel', { defaultValue: 'Plan updated' })
  }
  return step.label
}

export function PortalRunStatus({
  dark,
  agentName,
  agentColor,
  AgentIcon,
  activity,
  streaming = false,
  className,
}: PortalRunStatusProps): JSX.Element {
  const { t } = useTranslation()
  const running = streaming || activity?.status === 'running'
  const failed = activity?.status === 'error'
  const hasSteps = (activity?.steps.length ?? 0) > 0
  // Auto-hint expand when there are steps to inspect; default collapsed.
  const [open, setOpen] = useState(false)

  // Prefer the real work tool under RUNNING… — Plan has its own card.
  const liveStep = activity
    ? [...activity.steps].reverse().find((s) => (
        (s.status === 'running' || s.status === 'pending') && !isTodoActivityStep(s)
      ))
    : undefined
  const waitingAgent = activity
    ? [...activity.steps].reverse().find((s) => (
        s.kind === 'agent' && (s.status === 'running' || s.status === 'pending')
      ))
    : undefined

  const duration = formatDuration(activity?.durationMs)
  const counts = activity ? countKinds(activity) : { tools: 0, skills: 0, asks: 0, total: 0 }

  let doneSummary = t('chat.activityWorked', { defaultValue: 'Worked' })
  if (failed) doneSummary = t('chat.activityFailed', { defaultValue: 'Failed' })
  else if (counts.total > 0) {
    const parts = [t('chat.activityWorked', { defaultValue: 'Worked' })]
    if (counts.tools > 0) {
      parts.push(t('chat.activityToolCount', { count: counts.tools, defaultValue: '{{count}} tools' }))
    }
    if (counts.skills > 0) {
      parts.push(t('chat.activitySkillCount', { count: counts.skills, defaultValue: '{{count}} skills' }))
    }
    if (counts.asks > 0) {
      parts.push(t('chat.activityAskCount', { count: counts.asks, defaultValue: '{{count}} asks' }))
    }
    if (counts.tools === 0 && counts.skills === 0 && counts.asks === 0) {
      parts.push(t('chat.activityStepCount', { count: counts.total, defaultValue: '{{count}} steps' }))
    }
    if (duration) parts.push(duration)
    doneSummary = parts.join(' · ')
  } else if (duration) {
    doneSummary = `${t('chat.activityWorked', { defaultValue: 'Worked' })} · ${duration}`
  }

  const canExpandWhileRunning = running && hasSteps
  const showDoneSummary = !running && !!activity && (hasSteps || failed)
  const runningLabel = `${t('chat.activityRunning', { defaultValue: 'Running' })}...`

  return (
    <div className={cn('w-full space-y-2', className)}>
      <div className="flex items-center gap-2">
        <div className={cn('rounded-md bg-gradient-to-tr p-1 text-white', agentColor)}>
          <AgentIcon className="h-3.5 w-3.5" />
        </div>
        {canExpandWhileRunning ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left transition hover:opacity-80"
          >
            <span className="truncate text-[9px] font-bold uppercase tracking-wider text-zinc-400 animate-pulse">
              {runningLabel}
            </span>
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 text-zinc-500 transition-transform duration-150',
                open && 'rotate-90',
              )}
            />
          </button>
        ) : (
          <span className={cn(
            'text-[9px] font-bold uppercase tracking-wider text-zinc-400',
            running && 'animate-pulse',
          )}>
            {running ? runningLabel : agentName}
          </span>
        )}
      </div>

      {/* Live tool / subagent status under RUNNING… */}
      {running && (liveStep || waitingAgent) && (
        <p className={cn(
          'truncate pl-1 text-[11px] leading-snug',
          dark ? 'text-zinc-500' : 'text-zinc-400',
        )}>
          {waitingAgent
            ? t('chat.activityWaitingSubagent', {
                agent: waitingAgent.label,
                defaultValue: 'Waiting for subagent',
              })
            : liveStep
              ? t('chat.activityRunningStep', {
                  step: stepLabel(liveStep, t),
                  defaultValue: 'Running · {{step}}',
                })
              : null}
        </p>
      )}

      {/* Plan card sits between run status and the assistant body (observer UX). */}
      {activity && (
        <Suspense fallback={null}>
          <ChatTodoList activity={activity} dark={dark} className="max-w-full" />
        </Suspense>
      )}

      {/* Completed: compact expandable tool record */}
      {showDoneSummary && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-lg px-1 py-0.5 text-left text-[11px] font-medium transition',
            dark ? 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800',
            failed && (dark ? 'text-red-400' : 'text-red-600'),
          )}
        >
          {failed
            ? <CircleAlert className="h-3 w-3 shrink-0" />
            : <Check className="h-3 w-3 shrink-0 text-emerald-500" />}
          <span className="truncate">{doneSummary}</span>
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 opacity-60 transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
        </button>
      )}

      {running && !liveStep && !waitingAgent && (
        <div className="flex items-center gap-1 py-0.5 pl-1.5">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-500" style={{ animationDelay: '0ms' }} />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-500" style={{ animationDelay: '150ms' }} />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-500" style={{ animationDelay: '300ms' }} />
        </div>
      )}

      {open && activity && (
        <div className={cn(
          'ml-1 space-y-1.5 border-l pl-3',
          dark ? 'border-zinc-800' : 'border-zinc-200',
        )}>
          {activity.steps.length === 0 && (
            <p className="text-[11px] text-zinc-500">
              {running
                ? t('chat.portal.waitingSteps')
                : t('chat.portal.noSteps')}
            </p>
          )}
          {activity.steps.map((step) => (
            <div key={step.id} className="min-w-0">
              <div className={cn(
                'flex items-center gap-1.5 text-[12px]',
                dark ? 'text-zinc-300' : 'text-zinc-700',
              )}>
                <StepIcon step={step} dark={dark} />
                <span className={cn(
                  'truncate',
                  step.kind === 'agent' || step.kind === 'status'
                    ? 'font-medium'
                    : 'agim-mono text-[11px]',
                )}>
                  {stepLabel(step, t)}
                </span>
                {step.kind === 'approval' && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-500">
                    {t('chat.activityApproval')}
                  </span>
                )}
                {step.kind === 'ask' && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-500">
                    {t('chat.activityAsk')}
                  </span>
                )}
                {step.kind === 'skill' && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-500">
                    {t('chat.activitySkill')}
                  </span>
                )}
              </div>
              {step.preview && !isTodoActivityStep(step) && (
                <pre className={cn(
                  'agim-mono mt-0.5 max-h-20 overflow-auto whitespace-pre-wrap break-all rounded-md px-2 py-1 text-[11px] leading-snug',
                  dark ? 'bg-zinc-900 text-zinc-500' : 'bg-zinc-100 text-zinc-500',
                )}>
                  {step.preview.length > 280 ? `${step.preview.slice(0, 280)}…` : step.preview}
                </pre>
              )}
            </div>
          ))}
          {activity.error && (
            <p className="text-[11px] text-red-400">{activity.error}</p>
          )}
        </div>
      )}
    </div>
  )
}
