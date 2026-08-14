/**
 * Shared chat activity (tool / approval / ask / A2A) helpers.
 *
 * Used by the web SPA reducer and the Ink TUI so both surfaces merge
 * `onToolActivity` + approval/ask dock events the same way.
 */

import type { ToolActivityStep } from './types.js'
import { mergeStepReflects } from './llm/step-reflect.js'

export type ChatActivityStepKind = ToolActivityStep['kind'] | 'approval' | 'ask'

export interface ChatActivityStep {
  id: string
  kind: ChatActivityStepKind
  label: string
  status: ToolActivityStep['status']
  startedAt: number
  finishedAt?: number
  preview?: string
  todoItems?: ToolActivityStep['todoItems']
  /** Subagent / A2A inline job id when known. */
  jobId?: number
  reflects?: ToolActivityStep['reflects']
  lastTool?: ToolActivityStep['lastTool']
}

export interface ChatActivity {
  runId: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  outputChars?: number
  error?: string
  steps: ChatActivityStep[]
}

export function createChatActivity(runId: string, startedAt = Date.now()): ChatActivity {
  return {
    runId,
    status: 'running',
    startedAt,
    steps: [],
  }
}

/** Upsert one live tool/skill/agent/status step onto an activity. */
export function mergeActivityStep(
  activity: ChatActivity,
  step: ChatActivityStep,
): ChatActivity {
  const existing = activity.steps.findIndex((st) => st.id === step.id)
  const steps = [...activity.steps]
  const prev = existing >= 0 ? steps[existing] : undefined
  if (prev) {
    steps[existing] = {
      ...prev,
      ...step,
      startedAt: Math.min(prev.startedAt, step.startedAt),
      preview: step.preview ?? prev.preview,
      todoItems: step.todoItems ?? prev.todoItems,
      jobId: step.jobId ?? prev.jobId,
      reflects: mergeStepReflects(prev.reflects, step.reflects) ?? prev.reflects,
      lastTool: step.lastTool ?? prev.lastTool,
    }
  } else {
    steps.push(step)
  }
  return {
    ...activity,
    runId: activity.runId || step.id,
    status: activity.status === 'running' ? 'running' : activity.status,
    steps,
  }
}

export function mergeToolActivityStep(
  activity: ChatActivity,
  step: ToolActivityStep,
): ChatActivity {
  return mergeActivityStep(activity, {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    preview: step.preview,
    todoItems: step.todoItems,
    ...(typeof step.jobId === 'number' ? { jobId: step.jobId } : {}),
    ...(step.reflects ? { reflects: step.reflects } : {}),
    ...(step.lastTool ? { lastTool: step.lastTool } : {}),
  })
}

export function appendApprovalStep(
  activity: ChatActivity,
  opts: { messageId: string; toolName: string; inputJson?: string; startedAt?: number },
): ChatActivity {
  if (activity.steps.some((st) => st.id === opts.messageId)) return activity
  return mergeActivityStep(activity, {
    id: opts.messageId,
    kind: 'approval',
    label: opts.toolName,
    status: 'pending',
    startedAt: opts.startedAt ?? Date.now(),
    preview: opts.inputJson,
  })
}

export function resolveApprovalStep(
  activity: ChatActivity,
  opts: {
    messageId: string
    decision: 'allow' | 'deny' | 'timeout' | string
    finishedAt?: number
  },
): ChatActivity {
  const status = approvalDecisionToStepStatus(opts.decision)
  const finishedAt = opts.finishedAt ?? Date.now()
  return {
    ...activity,
    steps: activity.steps.map((st) => (
      st.id === opts.messageId
        ? { ...st, status, finishedAt }
        : st
    )),
  }
}

export function appendAskStep(
  activity: ChatActivity,
  opts: { messageId: string; label: string; body?: string; startedAt?: number },
): ChatActivity {
  if (activity.steps.some((st) => st.id === opts.messageId)) return activity
  return mergeActivityStep(activity, {
    id: opts.messageId,
    kind: 'ask',
    label: opts.label,
    status: 'pending',
    startedAt: opts.startedAt ?? Date.now(),
    preview: opts.body,
  })
}

export function resolveAskStep(
  activity: ChatActivity,
  opts: { messageId: string; finalText?: string; finishedAt?: number },
): ChatActivity {
  const finishedAt = opts.finishedAt ?? Date.now()
  return {
    ...activity,
    steps: activity.steps.map((st) => (
      st.id === opts.messageId
        ? {
            ...st,
            status: 'success' as const,
            finishedAt,
            preview: opts.finalText ?? st.preview,
          }
        : st
    )),
  }
}

export function finishActivity(
  activity: ChatActivity,
  opts: {
    status: 'success' | 'error'
    finishedAt?: number
    error?: string
    outputChars?: number
  },
): ChatActivity {
  const finishedAt = opts.finishedAt ?? Date.now()
  return {
    ...activity,
    status: opts.status,
    finishedAt,
    durationMs: Math.max(0, finishedAt - activity.startedAt),
    ...(opts.error ? { error: opts.error } : {}),
    ...(opts.outputChars != null ? { outputChars: opts.outputChars } : {}),
    steps: activity.steps.map((st) => (
      st.status === 'pending' || st.status === 'running'
        ? {
            ...st,
            status: opts.status === 'success' ? 'success' : 'error',
            finishedAt,
          }
        : st
    )),
  }
}

export function approvalDecisionToStepStatus(
  decision: string,
): ChatActivityStep['status'] {
  switch (decision) {
    case 'allowed':
    case 'allowed-pinned':
    case 'allow':
    case 'y':
    case 'a':
      return 'success'
    case 'denied':
    case 'denied-revoked':
    case 'deny':
    case 'n':
      return 'denied'
    case 'expired':
    case 'timeout':
      return 'error'
    default:
      return 'error'
  }
}

/** All live Subagent / A2A steps (oldest → newest). */
export function listWaitingAgentSteps(
  activity: ChatActivity,
): ChatActivityStep[] {
  return activity.steps.filter((s) => (
    s.kind === 'agent' && (s.status === 'running' || s.status === 'pending')
  ))
}

/** Latest live Subagent step (compat helper for single-line titles). */
export function findWaitingAgentStep(
  activity: ChatActivity,
): ChatActivityStep | undefined {
  const waiting = listWaitingAgentSteps(activity)
  return waiting.length > 0 ? waiting[waiting.length - 1] : undefined
}

/** Compact labels for a waiting-subagent banner, e.g. `agim/cheap, claude-code`. */
export function formatWaitingSubagentLabels(
  steps: ChatActivityStep[],
  max = 4,
): string {
  const labels = steps.map((s) => s.label).filter(Boolean)
  if (labels.length === 0) return ''
  if (labels.length <= max) return labels.join(', ')
  return `${labels.slice(0, max).join(', ')} +${labels.length - max}`
}

export function findLiveActivityStep(
  activity: ChatActivity,
): ChatActivityStep | undefined {
  return [...activity.steps].reverse().find((s) => (
    s.status === 'running' || s.status === 'pending'
  ))
}

export function formatActivityDuration(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

/** Per-kind tallies for collapsed “Worked · N tools · M skills” titles. */
export interface ChatActivityKindCounts {
  tools: number
  skills: number
  agents: number
  approvals: number
  asks: number
  total: number
}

export function countActivityStepKinds(
  activity: ChatActivity,
): ChatActivityKindCounts {
  let tools = 0
  let skills = 0
  let agents = 0
  let approvals = 0
  let asks = 0
  for (const step of activity.steps) {
    switch (step.kind) {
      case 'tool':
        tools += 1
        break
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
      case 'reflect':
        break
      default:
        tools += 1
        break
    }
  }
  return {
    tools,
    skills,
    agents,
    approvals,
    asks,
    total: activity.steps.length,
  }
}

/**
 * Compact English/Chinese-style summary fragments after “Worked” /
 * “已完成”, e.g. `["2 tools", "1 skill"]`. Empty when there are no steps.
 * Callers join with ` · ` and append duration separately.
 */
export function formatActivityKindSummaryParts(
  counts: ChatActivityKindCounts,
  locale: 'en' | 'zh' = 'en',
): string[] {
  const parts: string[] = []
  const en = locale === 'en'
  if (counts.tools > 0) {
    parts.push(en
      ? `${counts.tools} ${counts.tools === 1 ? 'tool' : 'tools'}`
      : `${counts.tools} 次工具`)
  }
  if (counts.skills > 0) {
    parts.push(en
      ? `${counts.skills} ${counts.skills === 1 ? 'skill' : 'skills'}`
      : `${counts.skills} 次技能`)
  }
  if (counts.agents > 0) {
    parts.push(en
      ? `${counts.agents} ${counts.agents === 1 ? 'agent' : 'agents'}`
      : `${counts.agents} 次协作`)
  }
  if (counts.approvals > 0) {
    parts.push(en
      ? `${counts.approvals} ${counts.approvals === 1 ? 'approval' : 'approvals'}`
      : `${counts.approvals} 次审批`)
  }
  if (counts.asks > 0) {
    parts.push(en
      ? `${counts.asks} ${counts.asks === 1 ? 'ask' : 'asks'}`
      : `${counts.asks} 次提问`)
  }
  // Fallback if kinds were empty but steps existed (shouldn't happen).
  if (parts.length === 0 && counts.total > 0) {
    parts.push(en
      ? `${counts.total} ${counts.total === 1 ? 'step' : 'steps'}`
      : `${counts.total} 步`)
  }
  return parts
}
