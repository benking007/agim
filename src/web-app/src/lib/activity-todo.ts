/**
 * Extract the latest plan checklist from a ChatActivity for the Todo card.
 *
 * Prefers structured `step.todoItems` (new servers). Falls back to parsing
 * markdown / JSON previews so refresh against older persisted activity still
 * shows a usable list.
 */

import type { ChatActivity, ChatActivityStep } from '@/hooks/use-chat'

export type ChatTodoStatus = 'pending' | 'in_progress' | 'completed'

export interface ChatTodoItem {
  content: string
  status: ChatTodoStatus
}

const TODO_LABELS = new Set(['agim_todo_write', 'native_todo_write'])

export function isTodoActivityStep(step: Pick<ChatActivityStep, 'label'>): boolean {
  const label = step.label || ''
  const bare = label.includes('__') ? (label.split('__').pop() || label) : label
  return TODO_LABELS.has(bare)
}

function asStatus(raw: unknown): ChatTodoStatus | null {
  if (raw === 'pending' || raw === 'in_progress' || raw === 'completed') return raw
  // Models occasionally emit aliases; keep the Plan card visible mid-turn.
  if (raw === 'todo' || raw === 'not_started' || raw === 'open') return 'pending'
  if (raw === 'in-progress' || raw === 'doing' || raw === 'active') return 'in_progress'
  if (raw === 'done' || raw === 'complete' || raw === 'finished') return 'completed'
  return null
}

export function normalizeChatTodoItems(raw: unknown): ChatTodoItem[] | null {
  if (!Array.isArray(raw)) return null
  const items: ChatTodoItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null
    const content = typeof (entry as { content?: unknown }).content === 'string'
      ? (entry as { content: string }).content.trim()
      : ''
    const status = asStatus((entry as { status?: unknown }).status)
    if (!content || !status) return null
    items.push({ content, status })
  }
  return items
}

export function parseTodoItemsFromPreview(preview: string | undefined): ChatTodoItem[] | null {
  if (!preview) return null
  const trimmed = preview.trim()
  if (!trimmed) return null
  if (trimmed === '(plan cleared — no items)') return []

  // Structured JSON preview (older running steps).
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const fromObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? normalizeChatTodoItems((parsed as { items?: unknown }).items)
        : normalizeChatTodoItems(parsed)
      if (fromObj) return fromObj
    } catch { /* fall through to markdown */ }
  }

  const items: ChatTodoItem[] = []
  for (const line of trimmed.split('\n')) {
    const m = line.trim().match(/^\d+\.\s*([☑▶☐])\s+(.+)$/)
    if (!m) continue
    const icon = m[1]
    const content = m[2]?.trim()
    if (!icon || !content) continue
    items.push({
      content,
      status: icon === '☑' ? 'completed' : icon === '▶' ? 'in_progress' : 'pending',
    })
  }
  return items.length > 0 ? items : null
}

/** Latest non-empty checklist on the activity (most recent todo step wins). */
export function extractLatestTodoItems(activity: ChatActivity | undefined | null): ChatTodoItem[] | null {
  if (!activity?.steps?.length) return null
  for (let i = activity.steps.length - 1; i >= 0; i -= 1) {
    const step = activity.steps[i]
    if (!step || !isTodoActivityStep(step)) continue
    if (step.todoItems) {
      const normalized = normalizeChatTodoItems(step.todoItems)
      if (normalized) return normalized
    }
    const fromPreview = parseTodoItemsFromPreview(step.preview)
    if (fromPreview) return fromPreview
  }
  return null
}

export function summarizeTodoItems(items: ChatTodoItem[]): {
  total: number
  completed: number
  inProgress: number
  pending: number
  allDone: boolean
} {
  let completed = 0
  let inProgress = 0
  let pending = 0
  for (const it of items) {
    if (it.status === 'completed') completed += 1
    else if (it.status === 'in_progress') inProgress += 1
    else pending += 1
  }
  return {
    total: items.length,
    completed,
    inProgress,
    pending,
    allDone: items.length > 0 && completed === items.length,
  }
}

/**
 * Turn-end: if every item is done except exactly one `in_progress` (no
 * pending), mark that last row completed. Mirrors backend
 * `completeStickyInProgressItems` so DONE / RUN_FINISH still closes Plan
 * when the model skipped a final todo_write.
 */
export function completeStickyInProgressItems(
  items: readonly ChatTodoItem[],
): ChatTodoItem[] | null {
  if (items.length === 0) return null
  const summary = summarizeTodoItems([...items])
  if (
    summary.pending > 0
    || summary.inProgress !== 1
    || summary.completed !== items.length - 1
  ) {
    return null
  }
  return items.map((it) => (
    it.status === 'in_progress'
      ? { content: it.content, status: 'completed' as const }
      : { ...it }
  ))
}

/** Apply sticky reconcile to every step that carries todoItems. */
export function reconcileActivityTodoItemsOnSuccess<T extends {
  todoItems?: ChatTodoItem[]
  preview?: string
}>(steps: readonly T[]): T[] {
  return steps.map((st) => {
    if (!st.todoItems?.length) return st
    const next = completeStickyInProgressItems(st.todoItems)
    if (!next) return st
    return {
      ...st,
      todoItems: next,
      preview: next.map((it, i) => `${i + 1}. ☑ ${it.content}`).join('\n'),
    }
  })
}
