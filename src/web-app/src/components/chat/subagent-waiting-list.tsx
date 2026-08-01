/**
 * Live Subagent waiting banner — shows one or many nested agent steps
 * without requiring the activity accordion to expand (Phase A2).
 */

import { Bot, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ChatActivityStep } from '@/hooks/use-chat'
import { cn } from '@/lib/utils'

export interface SubagentWaitingListProps {
  steps: ChatActivityStep[]
  className?: string
  /** Portal uses slightly dimmer zinc tokens. */
  variant?: 'desktop' | 'portal'
  dark?: boolean
}

export function listWaitingAgentStepsFrom(
  steps: ChatActivityStep[],
): ChatActivityStep[] {
  return steps.filter((s) => (
    s.kind === 'agent' && (s.status === 'running' || s.status === 'pending')
  ))
}

export function SubagentWaitingList({
  steps,
  className,
  variant = 'desktop',
  dark = false,
}: SubagentWaitingListProps): JSX.Element | null {
  const { t } = useTranslation()
  const waiting = listWaitingAgentStepsFrom(steps)
  if (waiting.length === 0) return null

  const portal = variant === 'portal'
  const muted = portal
    ? (dark ? 'text-zinc-500' : 'text-zinc-400')
    : 'text-text-muted'
  const rowText = portal
    ? (dark ? 'text-zinc-300' : 'text-zinc-700')
    : 'text-text-dim'

  const first = waiting[0]
  const headline = waiting.length === 1 && first
    ? t('chat.activityWaitingSubagent', {
        agent: first.label,
        defaultValue: 'Waiting for subagent',
      })
    : t('chat.activityWaitingSubagents', {
        count: waiting.length,
        defaultValue: 'Waiting for {{count}} subagents',
      })

  return (
    <div className={cn('space-y-1', className)}>
      <p className={cn(
        portal ? 'truncate pl-1 text-[11px] leading-snug' : 'pl-1.5 text-xs',
        muted,
      )}>
        {headline}
        {waiting.length === 1 && first ? (
          <span className={cn('ml-1 font-medium', rowText)}>
            → {first.label}
          </span>
        ) : null}
      </p>
      {waiting.length > 1 && (
        <ul className={cn(
          'space-y-0.5',
          portal ? 'pl-1' : 'pl-1.5',
        )}>
          {waiting.map((step) => (
            <li
              key={step.id}
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                portal ? 'text-[11px]' : 'text-xs',
                rowText,
              )}
            >
              <Loader2 className={cn(
                'h-3 w-3 shrink-0 animate-spin',
                portal ? 'text-teal-500' : 'text-text-muted',
              )}
              />
              <Bot className={cn(
                'h-3 w-3 shrink-0',
                portal ? 'text-teal-400' : 'text-accent',
              )}
              />
              <span className="truncate font-medium">→ {step.label}</span>
              <span className={cn(
                'shrink-0 text-[10px] uppercase tracking-wide',
                muted,
              )}>
                {t('chat.activitySubagentBadge', { defaultValue: 'subagent' })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
