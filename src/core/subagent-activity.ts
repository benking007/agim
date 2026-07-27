/**
 * Subagent activity helpers — keep pending lane cards (`${toolCallId}#i`)
 * from hanging forever when call_agents / call_agent bails before A2A
 * attaches a jobId (cap, policy deny, aligning gate, validation, …).
 *
 * Stop is only shown when `jobId` is known (`resolveSubagentJobId`). A
 * pending card without a terminal update therefore looks like a stuck
 * Subagent with no Stop — the bug users hit after a second fan-out.
 */

import type { AgentSendOpts } from './types.js'

export type SubagentActivityEmit = NonNullable<AgentSendOpts['onToolActivity']>

/** Count tasks[] for call_agents pending-lane cleanup. */
export function countCallAgentsTasks(input: unknown): number {
  if (!input || typeof input !== 'object') return 0
  const tasks = (input as { tasks?: unknown }).tasks
  return Array.isArray(tasks) ? tasks.length : 0
}

/** Label for lane i from call_agents input (best-effort). */
export function callAgentsLaneLabel(input: unknown, index: number): string {
  if (!input || typeof input !== 'object') return 'agent'
  const tasks = (input as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) return 'agent'
  const t = tasks[index]
  if (!t || typeof t !== 'object') return 'agent'
  const agent = (t as { agent?: unknown }).agent
  return typeof agent === 'string' && agent.trim() ? agent.trim() : 'agent'
}

/**
 * Mark every pending call_agents lane (`${toolCallId}#i`) failed/denied.
 * No-op when emit is missing or there are no tasks.
 */
export function failCallAgentsPendingLanes(
  emit: SubagentActivityEmit | undefined,
  opts: {
    toolCallId: string
    input?: unknown
    /** Explicit count when input is unavailable. */
    taskCount?: number
    status?: 'error' | 'denied'
    preview: string
    startedAt?: number
  },
): void {
  if (!emit) return
  const toolCallId = opts.toolCallId.trim()
  if (!toolCallId) return
  const n = typeof opts.taskCount === 'number' && opts.taskCount > 0
    ? Math.floor(opts.taskCount)
    : countCallAgentsTasks(opts.input)
  if (n <= 0) return
  const now = Date.now()
  const startedAt = opts.startedAt ?? now
  const status = opts.status ?? 'error'
  const preview = opts.preview.slice(0, 180)
  for (let i = 0; i < n; i++) {
    try {
      emit({
        id: `${toolCallId}#${i}`,
        kind: 'agent',
        label: callAgentsLaneLabel(opts.input, i),
        status,
        startedAt,
        finishedAt: now,
        preview,
      })
    } catch { /* observer must not break dispatch */ }
  }
}

/** Mark a singular call_agent pending card (id = toolCallId) failed/denied. */
export function failCallAgentPendingLane(
  emit: SubagentActivityEmit | undefined,
  opts: {
    toolCallId: string
    label?: string
    status?: 'error' | 'denied'
    preview: string
    startedAt?: number
  },
): void {
  if (!emit) return
  const toolCallId = opts.toolCallId.trim()
  if (!toolCallId) return
  const now = Date.now()
  try {
    emit({
      id: toolCallId,
      kind: 'agent',
      label: (opts.label && opts.label.trim()) || 'agent',
      status: opts.status ?? 'error',
      startedAt: opts.startedAt ?? now,
      finishedAt: now,
      preview: opts.preview.slice(0, 180),
    })
  } catch { /* observer must not break dispatch */ }
}
