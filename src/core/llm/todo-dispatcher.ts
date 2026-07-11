// todo-dispatcher — Claude-Code-style TodoWrite tool for the native
// agent (v1.2.124).
//
// Why this exists:
//   Long-form multi-step turns benefit from the model externalising
//   its plan into a visible checklist. Three concrete wins:
//     1. Forces the model to commit to a plan before grinding through
//        tool calls — reduces "wandered off, finished nothing" turns.
//     2. Each iteration the model can re-read its own todo state
//        instead of inferring from the running history.
//     3. Operators / users can see what's planned + what's done from
//        the IM transcript (the tool result is markdown checklist).
//
// Tool surface (intentionally tiny):
//   - native_todo_write(items)  — overwrites the per-thread todo list
//
// Storage: in-memory Map<threadKey, TodoItem[]>. Per-thread, no DB.
// Todo lists are intentionally short-lived (collapse a turn or two
// after the goal completes); losing them on restart is fine.

import { logger as rootLogger } from '../logger.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'

const log = rootLogger.child({ component: 'todo-dispatcher' })

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

const TODO_TOOL_NAMES = ['native_todo_write'] as const
export function isTodoToolName(name: string): boolean {
  return (TODO_TOOL_NAMES as readonly string[]).includes(name)
}

/** Module-level per-thread store. Map keyed by composite thread_key. */
const TODOS = new Map<string, TodoItem[]>()

/** Read API for callers that want to render the list outside the
 *  dispatcher (web admin, recap composer, etc.). */
export function getTodoForThread(threadKey: string): TodoItem[] | null {
  if (!threadKey) return null
  const cur = TODOS.get(threadKey)
  return cur ? cur.map((it) => ({ ...it })) : null
}

/** Clear a thread's todo list (e.g. on /new conversation). */
export function clearTodoForThread(threadKey: string): void {
  if (!threadKey) return
  TODOS.delete(threadKey)
}

/** Tool definitions to advertise to the LLM. */
export function getTodoTools(): ToolDef[] {
  return [
    {
      name: 'native_todo_write',
      description:
        'Overwrite this conversation\'s plan checklist with a fresh array of items. ' +
        'Use this at the start of any multi-step task (≥ 3 steps) to externalise the plan, ' +
        'then call it again to update statuses as you complete each step. The tool result ' +
        'returns the rendered markdown checklist — the user sees your current state. ' +
        '\n\n' +
        'Status legend: pending (not started) · in_progress (working on it now) · completed (done). ' +
        'Keep items short (one sentence). Exactly one item should be in_progress at a time.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Replacement list of todo items. Empty array clears the list.',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: 'Short description of the step (≤ 200 chars).',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Item state.',
                },
              },
              required: ['content', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      // v1.2.118 — per-tool cap. Todo writes are tiny + in-process, no
      // need for the default 60s budget.
      timeoutMs: 5_000,
    },
  ]
}

/**
 * Build a per-thread dispatcher. `threadKey` is the composite
 * `threadKey(platform, channelId, threadId)` so the store is scoped
 * to a single conversation.
 */
export function buildTodoDispatcher(threadKey: string): ToolDispatcher {
  return async (call): Promise<DispatcherResult> => {
    if (!isTodoToolName(call.name)) {
      return { text: `not handled: ${call.name}`, isError: true, source: 'unknown' }
    }
    if (!threadKey) {
      // CLI smoke / tests sometimes call without an IM thread; degrade
      // to a synthetic key so the tool still works.
      threadKey = '_no-thread'
    }
    if (call.name === 'native_todo_write') {
      return handleWrite(call.arguments, threadKey)
    }
    return { text: `unknown todo tool: ${call.name}`, isError: true, source: 'todo' }
  }
}

function handleWrite(args: Record<string, unknown>, threadKey: string): DispatcherResult {
  const rawItems = args.items
  if (!Array.isArray(rawItems)) {
    return { text: 'items must be an array', isError: true, source: 'todo' }
  }
  const normalized: TodoItem[] = []
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i]
    if (!item || typeof item !== 'object') {
      return { text: `items[${i}] must be an object`, isError: true, source: 'todo' }
    }
    const it = item as Record<string, unknown>
    const content = typeof it.content === 'string' ? it.content.trim() : ''
    if (!content) {
      return { text: `items[${i}].content is required (non-empty string)`, isError: true, source: 'todo' }
    }
    if (content.length > 500) {
      return { text: `items[${i}].content too long (max 500 chars)`, isError: true, source: 'todo' }
    }
    const rawStatus = typeof it.status === 'string' ? it.status : ''
    if (rawStatus !== 'pending' && rawStatus !== 'in_progress' && rawStatus !== 'completed') {
      return {
        text: `items[${i}].status must be one of: pending | in_progress | completed (got "${rawStatus}")`,
        isError: true, source: 'todo',
      }
    }
    normalized.push({ content, status: rawStatus })
  }
  TODOS.set(threadKey, normalized)
  log.info({
    event: 'todo.write',
    threadKey,
    count: normalized.length,
    inProgress: normalized.filter((it) => it.status === 'in_progress').length,
    completed: normalized.filter((it) => it.status === 'completed').length,
  })
  return {
    text: renderMarkdownChecklist(normalized),
    isError: false,
    source: 'todo',
  }
}

/** Markdown checklist. Status icons match Claude Code's TodoWrite for
 *  user familiarity: ☐ pending · ▶ in_progress · ☑ completed. */
function renderMarkdownChecklist(items: TodoItem[]): string {
  if (items.length === 0) return '(plan cleared — no items)'
  const lines: string[] = []
  for (const [i, it] of items.entries()) {
    const icon = it.status === 'completed' ? '☑'
      : it.status === 'in_progress' ? '▶' : '☐'
    lines.push(`${i + 1}. ${icon} ${it.content}`)
  }
  return lines.join('\n')
}
