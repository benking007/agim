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
//   - agim_todo_write(items)  — overwrites the per-thread todo list
//     (legacy alias: native_todo_write)
//
// Storage: ~/.agim/todos.db (SQLite) with an in-memory fallback when the
// native addon is unavailable (Bun tests). Persistence matters for
// complete_goal: a restart must not turn "incomplete checklist" into
// "no checklist".

import { join } from 'node:path'
import { AGIM_HOME } from '../agim-paths.js'
import { logger as rootLogger } from '../logger.js'
import { createSqliteHelper } from '../sqlite-helper.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { canonicalizeToolName } from './tool-names.js'
import {
  completeStickyInProgressItems,
  renderMarkdownChecklist,
  type TodoItem,
} from './todo-items.js'

const log = rootLogger.child({ component: 'todo-dispatcher' })

export type { TodoItem, TodoStatus } from './todo-items.js'

/** Three-state read for completion gates and inspectors. */
export type TodoSnapshot =
  | { status: 'unavailable' }
  | { status: 'absent' }
  | { status: 'present'; items: TodoItem[] }

const TODO_TOOL_NAMES = ['agim_todo_write'] as const
export function isTodoToolName(name: string): boolean {
  return (TODO_TOOL_NAMES as readonly string[]).includes(canonicalizeToolName(name))
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS native_todos (
  thread_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

const DB_PATH_FROM_ENV = process.env.AGIM_TODO_DB
const dbPath = DB_PATH_FROM_ENV && DB_PATH_FROM_ENV.length > 0
  ? DB_PATH_FROM_ENV
  : join(AGIM_HOME, 'todos.db')

const helper = createSqliteHelper({
  file: dbPath,
  schema: SCHEMA,
  logger: rootLogger,
  component: 'todo-db',
})

/** In-memory fallback used when better-sqlite3 cannot load (Bun), and as a
 *  write-through cache on the SQLite path for cheap reads inside a process. */
const MEMORY = new Map<string, TodoItem[]>()

function cloneItems(items: TodoItem[]): TodoItem[] {
  return items.map((it) => ({ ...it }))
}

function parseItemsJson(raw: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(raw || '[]') as unknown
    if (!Array.isArray(parsed)) return null
    const items: TodoItem[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') return null
      const content = typeof (entry as { content?: unknown }).content === 'string'
        ? (entry as { content: string }).content
        : ''
      const status = (entry as { status?: unknown }).status
      if (!content) return null
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
      items.push({ content, status })
    }
    return items
  } catch {
    return null
  }
}

function dbAvailable(): boolean {
  return helper.get() !== null
}

/** Read API for callers that want to render the list outside the
 *  dispatcher (web admin, recap composer, etc.).
 *  Returns null when the thread has never written a checklist. */
export function getTodoForThread(threadKey: string): TodoItem[] | null {
  const snap = getTodoSnapshot(threadKey)
  if (snap.status !== 'present') return null
  return cloneItems(snap.items)
}

/** Prefer this for completion gates — distinguishes unavailable / absent /
 *  present (including an explicit empty list). */
export function getTodoSnapshot(threadKey: string): TodoSnapshot {
  if (!threadKey) return { status: 'absent' }
  if (dbAvailable()) {
    return helper.safe((d): TodoSnapshot => {
      const row = d
        .prepare('SELECT items_json FROM native_todos WHERE thread_key = ?')
        .get(threadKey) as { items_json?: string } | undefined
      if (!row) {
        MEMORY.delete(threadKey)
        return { status: 'absent' }
      }
      const items = parseItemsJson(row.items_json ?? '[]')
      if (!items) return { status: 'unavailable' }
      MEMORY.set(threadKey, cloneItems(items))
      return { status: 'present', items: cloneItems(items) }
    }, { status: 'unavailable' })
  }
  // SQLite unavailable: memory-only process. Treat as present/absent from
  // MEMORY; do NOT claim "unavailable" here — Bun unit tests exercise this
  // path and still need a working checklist. Completion fail-closed on
  // unavailable only when the DB was expected (Node) but is broken.
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    return { status: 'unavailable' }
  }
  const cur = MEMORY.get(threadKey)
  return cur ? { status: 'present', items: cloneItems(cur) } : { status: 'absent' }
}

/** Gate used by complete_goal for native agents. */
export function evaluateTodoCompletionGate(threadKey: string):
  | { ok: true }
  | { ok: false; error: string } {
  const snap = getTodoSnapshot(threadKey)
  if (snap.status === 'unavailable') {
    return {
      ok: false,
      error: 'TODO_UNAVAILABLE: checklist store unavailable; completion blocked',
    }
  }
  if (snap.status === 'absent') return { ok: true }
  const incomplete = snap.items.filter((item) => item.status !== 'completed')
  if (incomplete.length > 0) {
    return {
      ok: false,
      error: `TODO_INCOMPLETE: ${incomplete.length} checklist item(s) are not completed`,
    }
  }
  return { ok: true }
}

/** Clear a thread's todo list (e.g. on /new conversation). */
export function clearTodoForThread(threadKey: string): void {
  if (!threadKey) return
  MEMORY.delete(threadKey)
  if (!dbAvailable()) return
  helper.safe((d) => {
    d.prepare('DELETE FROM native_todos WHERE thread_key = ?').run(threadKey)
    return true
  }, false)
}

/**
 * On a successful agent turn, mark every open Plan item completed so the
 * UI does not stay on "in progress" when the model skipped a final
 * todo_write. No-op when already all-done or the store is unavailable.
 */
export function reconcileTodoOnSuccessfulTurn(threadKey: string): TodoItem[] | null {
  if (!threadKey) return null
  const snap = getTodoSnapshot(threadKey)
  if (snap.status !== 'present') return null
  const next = completeStickyInProgressItems(snap.items)
  if (!next) return null
  if (!persistTodo(threadKey, next)) return null
  log.info({
    event: 'todo.reconcile_turn_end',
    threadKey,
    count: next.length,
  }, 'completed open checklist items on successful turn end')
  return next
}

function persistTodo(threadKey: string, items: TodoItem[]): boolean {
  MEMORY.set(threadKey, cloneItems(items))
  if (!dbAvailable()) {
    // Bun / broken-addon path: memory is the only store.
    return process.env.AGIM_TEST_REQUIRE_SQLITE !== '1'
  }
  return helper.safe((d) => {
    d.prepare(
      `INSERT INTO native_todos (thread_key, items_json, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(thread_key) DO UPDATE SET
         items_json = excluded.items_json,
         updated_at = datetime('now')`,
    ).run(threadKey, JSON.stringify(items))
    return true
  }, false)
}

/** Tool definitions to advertise to the LLM. */
export function getTodoTools(): ToolDef[] {
  return [
    {
      name: 'agim_todo_write',
      description:
        'Overwrite this conversation\'s plan checklist with a fresh array of items. ' +
        'REQUIRED before mutating tools when AGIM_TODO_GATE is on (default): call this with a '
        + 'non-empty list before agim_exec / agim_write_file / edit / memo writes / push / '
        + 'call_agent / complete_goal / etc. Read tools and ask_user stay allowed without a plan. '
        + 'Use this at the start of any multi-step task (≥ 3 steps) to externalise the plan. ' +
        'The user watches this checklist live in chat (like a progress board) — so you MUST ' +
        'call it again immediately after finishing each item to mark that item completed and ' +
        'set the next one to in_progress, BEFORE starting the next tool work. ' +
        'Do NOT wait until the whole task finishes to batch all status changes. ' +
        'Before ending the turn, call once more with EVERY item status=completed ' +
        '(including the last one — do not leave a trailing in_progress). ' +
        'The tool result returns the rendered markdown checklist. ' +
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
    if (canonicalizeToolName(call.name) === 'agim_todo_write') {
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
    const status = (
      rawStatus === 'pending' || rawStatus === 'in_progress' || rawStatus === 'completed'
    )
      ? rawStatus
      : rawStatus === 'todo' || rawStatus === 'not_started' || rawStatus === 'open'
        ? 'pending' as const
        : rawStatus === 'in-progress' || rawStatus === 'doing' || rawStatus === 'active'
          ? 'in_progress' as const
          : rawStatus === 'done' || rawStatus === 'complete' || rawStatus === 'finished'
            ? 'completed' as const
            : null
    if (!status) {
      return {
        text: `items[${i}].status must be one of: pending | in_progress | completed (got "${rawStatus}")`,
        isError: true, source: 'todo',
      }
    }
    normalized.push({ content, status })
  }
  if (!persistTodo(threadKey, normalized)) {
    return {
      text: 'todo store unavailable; checklist was not persisted',
      isError: true,
      source: 'todo',
    }
  }
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

/** Test-only: drop memory + close the handle so a temp DB can be unlinked
 *  or reopened after a simulated restart. */
export function closeTodoDbForTesting(): void {
  MEMORY.clear()
  helper.close()
}

/** Test-only: wipe rows without closing the handle. */
export function _truncateTodosForTests(): void {
  MEMORY.clear()
  helper.safe((d) => {
    d.exec('DELETE FROM native_todos')
    return true
  }, false)
}
