import { mergeStepReflects } from '../core/llm/step-reflect.js'
import {
  dedupeInjectedContextForPersist,
  isInjectedContextUnchangedMarker,
} from '../core/injected-context-dedupe.js'

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
export type ActiveRunStepKind = 'tool' | 'skill' | 'status' | 'approval' | 'ask' | 'agent' | 'reflect'

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
  reflects?: Array<{ stance: 'keep' | 'adjust' | 'stop'; next: string; at: number }>
  lastTool?: {
    label: string
    status: ActiveRunStepStatus
    at: number
  }
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
  /** Prompt injection snapshot (system + ephemeral) for the accordion viewer. */
  injectedContext?: string
}

/** Soft cap so a huge AGENTS.md + skills dump cannot blow WS / session JSON. */
export const INJECTED_CONTEXT_MAX_CHARS = 120_000

/** Last full injectedContext seen on this thread (live-wire dedupe only). */
const lastFullInjectedByThread = new Map<string, string>()

export function setActiveRunInjectedContext(threadId: string, text: string): boolean {
  const snap = runs.get(threadId)
  if (!snap) return false
  const trimmed = text.trim()
  if (!trimmed) return false
  snap.injectedContext = trimmed.length > INJECTED_CONTEXT_MAX_CHARS
    ? `${trimmed.slice(0, INJECTED_CONTEXT_MAX_CHARS)}\n\n…[truncated ${trimmed.length - INJECTED_CONTEXT_MAX_CHARS} chars]`
    : trimmed
  return true
}

/**
 * Wire text for the live `injected-context` WS event: full on first/changed
 * turn, unchanged marker when equal to the last persisted full copy.
 */
export function injectedContextForWire(threadId: string, text: string): string {
  const trimmed = text.trim()
  const prior = lastFullInjectedByThread.get(threadId)
  return dedupeInjectedContextForPersist(trimmed, prior) ?? trimmed
}

/** Keep finished runs briefly so a refresh right after completion still
 *  restores the accordion / run-finish row. */
const FINISHED_RETENTION_MS = 60 * 60 * 1000
const PARTIAL_TEXT_MAX_CHARS = 400_000
const MAX_FINISHED_SNAPSHOTS = 500

const runs = new Map<string, ActiveRunSnapshot>()
const finishTimers = new Map<string, ReturnType<typeof setTimeout>>()

function evictFinishedSnapshots(): void {
  const finished: Array<{ threadId: string; finishedAt: number }> = []
  for (const [threadId, snap] of runs) {
    if (snap.status !== 'running' && snap.finishedAt) {
      finished.push({ threadId, finishedAt: snap.finishedAt })
    }
  }
  if (finished.length <= MAX_FINISHED_SNAPSHOTS) return
  finished.sort((a, b) => a.finishedAt - b.finishedAt)
  const drop = finished.length - MAX_FINISHED_SNAPSHOTS
  for (let i = 0; i < drop; i++) {
    const id = finished[i]?.threadId
    if (!id) continue
    clearFinishTimer(id)
    runs.delete(id)
  }
}

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

export function upsertActiveRunStep(threadId: string, step: ActiveRunStep): boolean {
  const snap = runs.get(threadId)
  if (!snap) return false
  const idx = snap.steps.findIndex((s) => s.id === step.id)
  const terminalAgent = step.kind === 'agent'
    && (step.status === 'success' || step.status === 'error' || step.status === 'denied')
  const lateAgentReflect = step.kind === 'agent' && idx >= 0 && !!step.reflects?.length
  if (snap.status !== 'running') {
    // Late Subagent terminal: update an existing card so it does not stay
    // Waiting after the parent turn already finished. Do not insert new
    // rows (that would reopen a finished accordion).
    if ((!terminalAgent && !lateAgentReflect) || idx < 0) return false
  }
  if (idx >= 0) {
    const prev = snap.steps[idx]
    snap.steps[idx] = {
      ...prev,
      ...step,
      preview: step.preview ?? prev.preview,
      todoItems: step.todoItems ?? prev.todoItems,
      jobId: step.jobId ?? prev.jobId,
      reflects: mergeStepReflects(prev.reflects, step.reflects) ?? prev.reflects,
      lastTool: step.lastTool ?? prev.lastTool,
    }
  } else {
    snap.steps.push(step)
  }
  return true
}

export function appendActiveRunChunk(threadId: string, chunk: string): void {
  const snap = runs.get(threadId)
  if (!snap || snap.status !== 'running') return
  snap.partialText += chunk
  if (snap.partialText.length > PARTIAL_TEXT_MAX_CHARS) {
    snap.partialText = snap.partialText.slice(-PARTIAL_TEXT_MAX_CHARS)
  }
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
  let open = 0
  for (const it of items) {
    if (it.status !== 'completed') open += 1
  }
  if (open === 0) return st
  const next = items.map((it) => (
    it.status === 'completed'
      ? it
      : { content: it.content, status: 'completed' as const }
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
  // On success, also complete open Plan items so the persisted activity
  // matches a finished turn (N/N, not stuck 0/N in progress).
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
  evictFinishedSnapshots()
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

/** Move a live/finished snapshot when WS get-history adopts a persisted id. */
export function rekeyActiveRun(oldId: string, newId: string): void {
  if (!oldId || !newId || oldId === newId) return
  const snap = runs.get(oldId)
  if (!snap) return
  const existing = runs.get(newId)
  if (existing && existing !== snap && existing.status === 'running') return
  runs.delete(oldId)
  snap.threadId = newId
  runs.set(newId, snap)
  const timer = finishTimers.get(oldId)
  if (timer) {
    finishTimers.delete(oldId)
    finishTimers.set(newId, timer)
  }
  const injected = lastFullInjectedByThread.get(oldId)
  if (injected) {
    lastFullInjectedByThread.delete(oldId)
    lastFullInjectedByThread.set(newId, injected)
  }
}

export function clearActiveRun(threadId: string): void {
  clearFinishTimer(threadId)
  runs.delete(threadId)
  lastFullInjectedByThread.delete(threadId)
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
  // Keep live-wire dedupe cache; do not write injectedContext into .log.
  // Historical accordion no longer shows the inject card.
  const full = snap.injectedContext?.trim()
  if (full && !isInjectedContextUnchangedMarker(full)) {
    lastFullInjectedByThread.set(snap.threadId, full)
  }
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

/** Seed / refresh the per-thread last-full cache (e.g. after loading history). */
export function rememberFullInjectedContext(threadId: string, text: string | undefined): void {
  const trimmed = text?.trim()
  if (!trimmed || isInjectedContextUnchangedMarker(trimmed)) return
  lastFullInjectedByThread.set(threadId, trimmed)
}

/** Drop thread cache (new conversation / clear). */
export function clearInjectedContextCache(threadId: string): void {
  lastFullInjectedByThread.delete(threadId)
}

/** Test helper. */
export function _resetActiveRunsForTests(): void {
  for (const t of finishTimers.values()) clearTimeout(t)
  finishTimers.clear()
  runs.clear()
  lastFullInjectedByThread.clear()
}
