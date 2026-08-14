/**
 * Leading icon for one activity step. Kind wins over success-check so
 * thinking / tools / skills stay visually distinct when the run is expanded.
 */

import {
  Bot,
  Brain,
  Loader2,
  MessageCircleQuestion,
  ShieldAlert,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react'

import type { ChatActivityStep } from '@/hooks/use-chat'
import { cn } from '@/lib/utils'

export function ActivityStepIcon({
  step,
  className,
}: {
  step: ChatActivityStep
  className?: string
}): JSX.Element {
  const cls = cn('h-3.5 w-3.5 shrink-0', className)
  if (step.status === 'denied' || step.status === 'error') {
    return <X className={cn(cls, 'text-red-400')} data-testid={`activity-icon-${step.kind}`} />
  }
  if (step.kind === 'reflect') {
    return (
      <Brain
        className={cn(
          cls,
          'text-teal-500',
          (step.status === 'running' || step.status === 'pending') && 'animate-pulse',
        )}
        data-testid="activity-icon-reflect"
      />
    )
  }
  if (step.status === 'running' || step.status === 'pending') {
    return <Loader2 className={cn(cls, 'animate-spin text-teal-500')} data-testid={`activity-icon-${step.kind}`} />
  }
  if (step.kind === 'approval') {
    return <ShieldAlert className={cn(cls, 'text-amber-400')} data-testid="activity-icon-approval" />
  }
  if (step.kind === 'ask') {
    return <MessageCircleQuestion className={cn(cls, 'text-sky-400')} data-testid="activity-icon-ask" />
  }
  if (step.kind === 'agent') {
    return <Bot className={cn(cls, 'text-teal-400')} data-testid="activity-icon-agent" />
  }
  if (step.kind === 'skill') {
    return <Sparkles className={cn(cls, 'text-violet-400')} data-testid="activity-icon-skill" />
  }
  return <Wrench className={cn(cls, 'text-zinc-400')} data-testid={`activity-icon-${step.kind}`} />
}
