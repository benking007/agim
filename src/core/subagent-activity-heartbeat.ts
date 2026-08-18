/**
 * Portal / activity-card heartbeat while an A2A Subagent is in flight.
 *
 * IM already has an optional 5-minute file-change heartbeat (verbose only).
 * This pulse is for the chat card: every 30–60s re-emit the live lane so
 * the UI can show phase, callee, last child tool, and wait time even when
 * the CLI only refreshes internal hooks (no new tool-complete events).
 *
 * Does not time out, reap, or cancel the child.
 */

import type { ToolActivityStep } from './types.js'

export const ACTIVITY_HEARTBEAT_MS_DEFAULT = 45_000
export const ACTIVITY_HEARTBEAT_MS_MIN = 30_000
export const ACTIVITY_HEARTBEAT_MS_MAX = 60_000

export type SubagentHeartbeatLastTool = NonNullable<ToolActivityStep['lastTool']>

export function resolveActivityHeartbeatMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env.AGIM_SUBAGENT_ACTIVITY_HEARTBEAT_MS || '').trim()
  if (!raw) return ACTIVITY_HEARTBEAT_MS_DEFAULT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return ACTIVITY_HEARTBEAT_MS_DEFAULT
  return Math.min(ACTIVITY_HEARTBEAT_MS_MAX, Math.max(ACTIVITY_HEARTBEAT_MS_MIN, n))
}

export function buildActivityHeartbeatStep(input: {
  id: string
  label: string
  startedAt: number
  now: number
  jobId?: number
  lastTool?: SubagentHeartbeatLastTool
}): ToolActivityStep {
  return {
    id: input.id,
    kind: 'agent',
    label: input.label,
    status: 'running',
    startedAt: input.startedAt,
    heartbeatAt: input.now,
    ...(typeof input.jobId === 'number' ? { jobId: input.jobId } : {}),
    ...(input.lastTool ? { lastTool: input.lastTool } : {}),
  }
}

export function createSubagentActivityHeartbeat(opts: {
  emit: (step: ToolActivityStep) => void
  stepId: string
  label: string
  startedAt: number
  jobId?: number
  intervalMs?: number
  now?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}): {
  noteProgress: (progress: { lastTool?: SubagentHeartbeatLastTool }) => void
  start: () => void
  stop: () => void
} {
  const intervalMs = opts.intervalMs ?? resolveActivityHeartbeatMs()
  const nowFn = opts.now ?? Date.now
  const setIntervalFn = opts.setIntervalFn ?? setInterval
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval
  let lastTool: SubagentHeartbeatLastTool | undefined
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  const tick = (): void => {
    if (stopped) return
    const now = nowFn()
    try {
      opts.emit(buildActivityHeartbeatStep({
        id: opts.stepId,
        label: opts.label,
        startedAt: opts.startedAt,
        now,
        ...(typeof opts.jobId === 'number' ? { jobId: opts.jobId } : {}),
        ...(lastTool ? { lastTool } : {}),
      }))
    } catch { /* observer must not break A2A */ }
  }

  return {
    noteProgress(progress) {
      if (progress.lastTool) lastTool = progress.lastTool
    },
    start() {
      if (stopped || timer) return
      timer = setIntervalFn(tick, intervalMs)
    },
    stop() {
      stopped = true
      if (timer) {
        clearIntervalFn(timer)
        timer = undefined
      }
    },
  }
}
