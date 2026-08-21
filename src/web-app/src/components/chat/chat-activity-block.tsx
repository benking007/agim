/**
 * ChatActivityBlock — Cursor-style in-thread run accordion.
 *
 * Default collapsed. Header: "Running ›" / "Worked · 2 tools · 1 skill · 4.2s ›"
 * When waiting on A2A: subtitle "Waiting for subagent"
 * Expanded: ordered tool / approval / ask / agent steps with status + preview.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  CircleAlert,
  Loader2,
} from 'lucide-react'

import { ActivityStepIcon } from '@/components/chat/activity-step-icon'
import { InjectedContextDetails } from '@/components/chat/injected-context-details'
import type { ChatActivity, ChatActivityStep } from '@/hooks/use-chat'
import { formatCollapsedRunSummary } from '@/lib/collapsed-run-summary'
import { isTodoActivityStep } from '@/lib/activity-todo'
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

interface KindCounts {
  tools: number
  skills: number
  agents: number
  approvals: number
  asks: number
  total: number
}

/** Stable wire label from Agim Agent compaction activity (see COMPACTION_ACTIVITY_LABEL). */
const COMPACTING_CONTEXT_LABEL = 'Compacting context'

function localizeStepLabel(
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

function countStepKinds(activity: ChatActivity): KindCounts {
  let tools = 0
  let skills = 0
  let agents = 0
  let approvals = 0
  let asks = 0
  for (const step of activity.steps) {
    switch (step.kind) {
      case 'skill':
        skills += 1
        break
      case 'agent':
        agents += 1
        break
      case 'approval':
        approvals += 1
        break
      case 'ask':
        asks += 1
        break
      case 'status':
      case 'reflect':
        // Status / reflect rows are not tool calls.
        break
      default:
        tools += 1
        break
    }
  }
  return { tools, skills, agents, approvals, asks, total: activity.steps.length }
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
  if (step.status === 'denied') {
    return (
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
        {t('chat.activityAgentBlocked', { defaultValue: 'blocked' })}
      </span>
    )
  }
  if (step.status === 'error') {
    return (
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-danger">
        {t('chat.activityAgentFailed', { defaultValue: 'failed' })}
      </span>
    )
  }
  return null
}

function kindSummaryParts(
  counts: KindCounts,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string[] {
  const parts: string[] = []
  if (counts.tools > 0) {
    parts.push(t('chat.activityToolCount', {
      count: counts.tools,
      defaultValue: '{{count}} tools',
    }))
  }
  if (counts.skills > 0) {
    parts.push(t('chat.activitySkillCount', {
      count: counts.skills,
      defaultValue: '{{count}} skills',
    }))
  }
  if (counts.agents > 0) {
    parts.push(t('chat.activityAgentCount', {
      count: counts.agents,
      defaultValue: '{{count}} agents',
    }))
  }
  if (counts.approvals > 0) {
    parts.push(t('chat.activityApprovalCount', {
      count: counts.approvals,
      defaultValue: '{{count}} approvals',
    }))
  }
  if (counts.asks > 0) {
    parts.push(t('chat.activityAskCount', {
      count: counts.asks,
      defaultValue: '{{count}} asks',
    }))
  }
  if (parts.length === 0 && counts.total > 0) {
    parts.push(t('chat.activityStepCount', {
      count: counts.total,
      defaultValue: '{{count}} steps',
    }))
  }
  return parts
}

export function ChatActivityBlock({ activity, className }: ChatActivityBlockProps): JSX.Element {
  const { t } = useTranslation()
  // Default collapsed — title carries live step / kind tallies; expand on demand.
  const [open, setOpen] = useState(false)

  const stepCount = activity.steps.length
  const kindCounts = countStepKinds(activity)
  const liveStep = [...activity.steps].reverse().find((s) => (
    s.status === 'running' || s.status === 'pending'
  ))
  // Prefer live Subagent step(s) for the Cursor-style subtitle even when an
  // approval/ask is also pending further down the same turn.
  const waitingAgents = activity.steps.filter((s) => (
    s.kind === 'agent' && (s.status === 'running' || s.status === 'pending')
  ))
  const waitingAgent = waitingAgents.length > 0
    ? waitingAgents[waitingAgents.length - 1]
    : undefined
  const duration = formatDuration(activity.durationMs)
  const running = activity.status === 'running'

  let title: string
  if (running) {
    // Prefer showing the delegated agent in the Running title while waiting.
    if (waitingAgents.length > 1) {
      title = t('chat.activityRunningSubagents', {
        count: waitingAgents.length,
        defaultValue: 'Running · {{count}} subagents',
      })
    } else {
      const hasThinkOrTool = activity.steps.some((s) => (
        s.kind === 'reflect' || s.kind === 'tool' || s.kind === 'skill'
      ))
      const collapsed = hasThinkOrTool ? formatCollapsedRunSummary(activity) : ''
      const titleStep = waitingAgent ?? liveStep
      title = collapsed
        || (titleStep
          ? t('chat.activityRunningStep', {
              step: localizeStepLabel(titleStep, t),
              defaultValue: 'Running · {{step}}',
            })
          : t('chat.activityRunning', { defaultValue: 'Running' }))
    }
  } else if (activity.status === 'error') {
    title = t('chat.activityFailed', { defaultValue: 'Failed' })
  } else {
    const parts = [t('chat.activityWorked', { defaultValue: 'Worked' })]
    parts.push(...kindSummaryParts(kindCounts, t))
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

      {open && (
        <div className="mt-1.5 space-y-1 border-l border-border/80 pl-3">
          {activity.status === 'running' && activity.injectedContext?.trim() ? (
            <InjectedContextDetails text={activity.injectedContext} />
          ) : null}
          {stepCount === 0 && !(activity.status === 'running' && activity.injectedContext?.trim()) && (
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
                <ActivityStepIcon step={step} />
                <span className={cn(
                  'truncate text-[12px] text-text',
                  step.kind === 'agent' || step.kind === 'status' ? 'font-medium' : 'font-mono',
                )}
                >
                  {localizeStepLabel(step, t)}
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
                {step.kind === 'agent' && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
                    {t('chat.activitySubagentBadge', { defaultValue: 'subagent' })}
                  </span>
                )}
                <AgentStatusBadge step={step} />
              </div>
              {step.preview && !isTodoActivityStep(step) && (
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
