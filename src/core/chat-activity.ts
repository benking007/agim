/**
 * Shared chat activity (tool / approval / ask / A2A) helpers.
 *
 * Used by the web SPA reducer and the Ink TUI so both surfaces merge
 * `onToolActivity` + approval/ask dock events the same way.
 */

import type { ToolActivityStep } from './types.js'

export type ChatActivityStepKind = ToolActivityStep['kind'] | 'approval' | 'ask'

export interface ChatActivityStep {
  id: string
  kind: ChatActivityStepKind
  label: string
  status: ToolActivityStep['status']
  startedAt: number
  finishedAt?: number
  preview?: string
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

/** Live A2A / agent step preferred for "Waiting for subagent" copy. */
export function findWaitingAgentStep(
  activity: ChatActivity,
): ChatActivityStep | undefined {
  return [...activity.steps].reverse().find((s) => (
    s.kind === 'agent' && (s.status === 'running' || s.status === 'pending')
  ))
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
