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
  MessageCircle,
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
const ChatSubagentCard = lazy(async () => {
  const module = await import('@/components/chat/chat-subagent-card')
  return { default: module.ChatSubagentCard }
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
  /** Cancel one live Subagent job from the inline card. */
  onStopSubagent?: (jobId: number) => boolean | undefined
  /** Reserve the 1-line Step Reflect slot on same-family Agim workers. */
  stepReflectEnabled?: boolean
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
  agents: number
  total: number
} {
  let tools = 0
  let skills = 0
  let asks = 0
  let agents = 0
  for (const step of activity.steps) {
    if (step.kind === 'skill') skills += 1
    else if (step.kind === 'ask') asks += 1
    else if (step.kind === 'agent') agents += 1
    else if (step.kind === 'status' || step.kind === 'reflect') {
      // Status / reflect rows are not tool calls.
    } else if (step.kind === 'tool') tools += 1
    else if (step.kind !== 'approval') tools += 1
  }
  return { tools, skills, asks, agents, total: activity.steps.length }
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
  if (step.kind === 'reflect') return <MessageCircle className={cn(cls, 'text-teal-400')} />
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
  if (step.kind === 'reflect') {
    return step.label
      ? t('chat.activityReflectNext', {
          next: step.label,
          defaultValue: 'Step reflect · {{next}}',
        })
      : t('chat.activityReflect', { defaultValue: 'Step reflect' })
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
  onStopSubagent,
  stepReflectEnabled = false,
}: PortalRunStatusProps): JSX.Element {
  const { t } = useTranslation()
  const running = streaming || activity?.status === 'running'
  const failed = activity?.status === 'error'
  const hasSteps = (activity?.steps.length ?? 0) > 0
  // Auto-hint expand when there are steps to inspect; default collapsed.
  const [open, setOpen] = useState(false)

  const waitingAgents = activity
    ? activity.steps.filter((s) => (
        s.kind === 'agent' && (s.status === 'running' || s.status === 'pending')
      ))
    : []

  const duration = formatDuration(activity?.durationMs)
  const counts = activity
    ? countKinds(activity)
    : { tools: 0, skills: 0, asks: 0, agents: 0, total: 0 }

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
    if (counts.agents > 0) {
      parts.push(t('chat.activityAgentCount', { count: counts.agents, defaultValue: '{{count}} agents' }))
    }
    if (counts.asks > 0) {
      parts.push(t('chat.activityAskCount', { count: counts.asks, defaultValue: '{{count}} asks' }))
    }
    if (counts.tools === 0 && counts.skills === 0 && counts.asks === 0 && counts.agents === 0) {
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

      {/* Plan first, then Subagents — both sit between run status and body. */}
      {activity && (
        <Suspense fallback={null}>
          <ChatTodoList activity={activity} dark={dark} className="max-w-full" />
        </Suspense>
      )}
      {activity && (
        <Suspense fallback={null}>
          <ChatSubagentCard
            activity={activity}
            dark={dark}
            className="max-w-full"
            onStopSubagent={onStopSubagent}
            stepReflectEnabled={stepReflectEnabled}
          />
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

      {/* Live run: bouncing dots only (no duplicate "Running · tool" line). */}
      {running && waitingAgents.length === 0 && (
        <div className="flex items-center gap-1 py-0.5 pl-1.5" aria-hidden="true">
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
                {step.kind === 'agent' && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-500">
                    {t('chat.activitySubagentBadge', { defaultValue: 'subagent' })}
                  </span>
                )}
                {step.kind === 'reflect' && (
                  <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-500">
                    {t('chat.activityReflectBadge', { defaultValue: 'reflect' })}
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
