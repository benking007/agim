/**
 * Shared parse / extract helpers for Agim todo checklists.
 *
 * Used by the todo dispatcher (persist path), Agim Agent activity emit
 * (structured `todoItems` on tool steps), and the SPA (fallback parse
 * from preview text when history lacks the structured field).
 */

import { canonicalizeToolName } from './tool-names.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

const TODO_LABELS = new Set(['agim_todo_write', 'native_todo_write'])

export function isTodoActivityLabel(label: string | undefined | null): boolean {
  if (!label) return false
  const bare = label.includes('__') ? label.split('__').pop()! : label
  return TODO_LABELS.has(canonicalizeToolName(bare))
}

function asStatus(raw: unknown): TodoStatus | null {
  if (raw === 'pending' || raw === 'in_progress' || raw === 'completed') return raw
  // Aliases — keep activity.todoItems populated even when the model drifts
  // from the schema (dispatcher still validates canonical statuses on write).
  if (raw === 'todo' || raw === 'not_started' || raw === 'open') return 'pending'
  if (raw === 'in-progress' || raw === 'doing' || raw === 'active') return 'in_progress'
  if (raw === 'done' || raw === 'complete' || raw === 'finished') return 'completed'
  return null
}

/** Normalize a JSON `items` array (tool args / details). */
export function normalizeTodoItems(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw)) return null
  const items: TodoItem[] = []
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

/** Pull items from a tool-call argument object (`{ items: [...] }`). */
export function extractTodoItemsFromInput(input: unknown): TodoItem[] | null {
  if (input == null) return null
  let obj: unknown = input
  if (typeof input === 'string') {
    try { obj = JSON.parse(input) } catch { return null }
  }
  if (!obj || typeof obj !== 'object') return null
  return normalizeTodoItems((obj as { items?: unknown }).items)
}

/**
 * Parse the markdown checklist the todo tool returns:
 *   `1. ☑ content` / `2. ▶ content` / `3. ☐ content`
 */
export function parseTodoItemsFromMarkdown(text: string | undefined | null): TodoItem[] | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed || trimmed === '(plan cleared — no items)') {
    return trimmed === '(plan cleared — no items)' ? [] : null
  }
  const items: TodoItem[] = []
  for (const line of trimmed.split('\n')) {
    const m = line.trim().match(/^\d+\.\s*([☑▶☐])\s+(.+)$/)
    if (!m) continue
    const icon = m[1]
    const content = m[2].trim()
    if (!content) continue
    const status: TodoStatus = icon === '☑' ? 'completed'
      : icon === '▶' ? 'in_progress'
        : 'pending'
    items.push({ content, status })
  }
  return items.length > 0 ? items : null
}

/** Prefer structured input; fall back to markdown tool result text. */
export function resolveTodoItems(opts: {
  input?: unknown
  resultText?: string | null
}): TodoItem[] | null {
  const fromInput = extractTodoItemsFromInput(opts.input)
  if (fromInput) return fromInput
  return parseTodoItemsFromMarkdown(opts.resultText)
}

/** Markdown checklist (☐ / ▶ / ☑). Empty → cleared sentinel. */
export function renderMarkdownChecklist(items: TodoItem[]): string {
  if (items.length === 0) return '(plan cleared — no items)'
  return items.map((it, i) => {
    const icon = it.status === 'completed' ? '☑'
      : it.status === 'in_progress' ? '▶' : '☐'
    return `${i + 1}. ${icon} ${it.content}`
  }).join('\n')
}

/**
 * Turn-end reconcile: models often write the Plan once and never mark
 * items completed (left as pending / in_progress while the final answer
 * already landed). On a successful turn, close every open item so Plan
 * shows N/N instead of stuck "in progress".
 *
 * Returns a new array, or null when already all-completed / empty.
 */
export function completeOpenTodoItemsOnTurnSuccess(
  items: readonly TodoItem[],
): TodoItem[] | null {
  if (items.length === 0) return null
  let open = 0
  for (const it of items) {
    if (it.status !== 'completed') open += 1
  }
  if (open === 0) return null
  return items.map((it) => (
    it.status === 'completed'
      ? { ...it }
      : { content: it.content, status: 'completed' as const }
  ))
}

/** @deprecated Prefer completeOpenTodoItemsOnTurnSuccess */
export function completeStickyInProgressItems(
  items: readonly TodoItem[],
): TodoItem[] | null {
  return completeOpenTodoItemsOnTurnSuccess(items)
}
