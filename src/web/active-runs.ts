/**
 * In-flight web chat run snapshots.
 *
 * React state (activity accordion, "接收中", run timeline) is wiped on
 * refresh / WS reconnect because HISTORY only carries role/content. This
 * module keeps a per-thread snapshot so get-history can replay the live
 * (or just-finished) run, and so chunk/activity emits can retarget the
 * reconnecting socket instead of a closed one.
 */

export type ActiveRunStepStatus = 'pending' | 'running' | 'success' | 'error' | 'denied'
export type ActiveRunStepKind = 'tool' | 'skill' | 'status' | 'approval' | 'ask' | 'agent'

export interface ActiveRunStep {
  id: string
  kind: ActiveRunStepKind
  label: string
  status: ActiveRunStepStatus
  startedAt: number
  finishedAt?: number
  preview?: string
  todoItems?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
  /** Subagent / A2A inline job id when known. */
  jobId?: number
}

export interface ActiveRunSnapshot {
  threadId: string
  runId: string
  agent: string
  startedAt: number
  status: 'running' | 'success' | 'error'
  steps: ActiveRunStep[]
  partialText: string
  finishedAt?: number
  durationMs?: number
  error?: string
}

/** Keep finished runs briefly so a refresh right after completion still
 *  restores the accordion / run-finish row. */
const FINISHED_RETENTION_MS = 60 * 60 * 1000

const runs = new Map<string, ActiveRunSnapshot>()
const finishTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearFinishTimer(threadId: string): void {
  const t = finishTimers.get(threadId)
  if (t) {
    clearTimeout(t)
    finishTimers.delete(threadId)
  }
}

export function startActiveRun(input: {
  threadId: string
  runId: string
  agent: string
  startedAt: number
}): ActiveRunSnapshot {
  clearFinishTimer(input.threadId)
  const snap: ActiveRunSnapshot = {
    threadId: input.threadId,
    runId: input.runId,
    agent: input.agent,
    startedAt: input.startedAt,
    status: 'running',
    steps: [],
    partialText: '',
  }
  runs.set(input.threadId, snap)
  return snap
}

export function upsertActiveRunStep(threadId: string, step: ActiveRunStep): void {
  const snap = runs.get(threadId)
  if (!snap || snap.status !== 'running') return
  const idx = snap.steps.findIndex((s) => s.id === step.id)
  if (idx >= 0) {
    const prev = snap.steps[idx]
    snap.steps[idx] = {
      ...prev,
      ...step,
      preview: step.preview ?? prev.preview,
      todoItems: step.todoItems ?? prev.todoItems,
      jobId: step.jobId ?? prev.jobId,
    }
  } else {
    snap.steps.push(step)
  }
}

export function appendActiveRunChunk(threadId: string, chunk: string): void {
  const snap = runs.get(threadId)
  if (!snap || snap.status !== 'running') return
  snap.partialText += chunk
}

export function setActiveRunPartialText(threadId: string, text: string): void {
  const snap = runs.get(threadId)
  if (!snap) return
  snap.partialText = text
}

function completeStickyTodoItemsOnStep<T extends {
  todoItems?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
  preview?: string
}>(st: T): T {
  const items = st.todoItems
  if (!items || items.length === 0) return st
  let completed = 0
  let inProgress = 0
  let pending = 0
  for (const it of items) {
    if (it.status === 'completed') completed += 1
    else if (it.status === 'in_progress') inProgress += 1
    else if (it.status === 'pending') pending += 1
  }
  if (pending > 0 || inProgress !== 1 || completed !== items.length - 1) return st
  const next = items.map((it) => (
    it.status === 'in_progress'
      ? { content: it.content, status: 'completed' as const }
      : it
  ))
  const preview = next.map((it, i) => `${i + 1}. ☑ ${it.content}`).join('\n')
  return { ...st, todoItems: next, preview }
}

export function finishActiveRun(
  threadId: string,
  outcome: {
    status: 'success' | 'error'
    finishedAt: number
    durationMs: number
    finalText?: string
    error?: string
  },
): void {
  const snap = runs.get(threadId)
  if (!snap) return
  snap.status = outcome.status
  snap.finishedAt = outcome.finishedAt
  snap.durationMs = outcome.durationMs
  if (outcome.finalText !== undefined) snap.partialText = outcome.finalText
  if (outcome.error) snap.error = outcome.error
  // Close any still-open steps so the accordion doesn't look stuck.
  // On success, also flip a sticky trailing in_progress Plan item so the
  // persisted activity matches a finished turn (N/N, not N-1/N).
  const finishedAt = outcome.finishedAt
  snap.steps = snap.steps.map((st) => {
    let next = st
    if (outcome.status === 'success') next = completeStickyTodoItemsOnStep(next)
    if (next.status === 'pending' || next.status === 'running') {
      return {
        ...next,
        status: outcome.status === 'error' ? 'error' : 'success',
        finishedAt,
      }
    }
    return next
  })
  clearFinishTimer(threadId)
  finishTimers.set(
    threadId,
    setTimeout(() => {
      finishTimers.delete(threadId)
      const cur = runs.get(threadId)
      if (cur && cur.runId === snap.runId && cur.status !== 'running') {
        runs.delete(threadId)
      }
    }, FINISHED_RETENTION_MS),
  )
}

export function getActiveRun(threadId: string): ActiveRunSnapshot | undefined {
  return runs.get(threadId)
}

export function clearActiveRun(threadId: string): void {
  clearFinishTimer(threadId)
  runs.delete(threadId)
}

/** Convert a snapshot into the durable ChatMessage.activity shape. */
export function snapshotToPersistedActivity(snap: ActiveRunSnapshot): {
  runId: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  error?: string
  steps: ActiveRunStep[]
} {
  return {
    runId: snap.runId,
    status: snap.status,
    startedAt: snap.startedAt,
    finishedAt: snap.finishedAt,
    durationMs: snap.durationMs,
    error: snap.error,
    steps: snap.steps.map((st) => ({ ...st })),
  }
}

/** Test helper. */
export function _resetActiveRunsForTests(): void {
  for (const t of finishTimers.values()) clearTimeout(t)
  finishTimers.clear()
  runs.clear()
}
