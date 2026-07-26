/**
 * Todo-first mutation gate for Agim Agent.
 *
 * When AGIM_TODO_GATE is on (default), mutating tools are blocked until the
 * thread has a non-empty checklist from agim_todo_write. Read-only tools,
 * ask_user, and todo_write itself stay exempt so short Q&A and planning
 * still work.
 *
 * Opt out: AGIM_TODO_GATE=off|0|false|no|disable
 */

import { canonicalizeToolName, expandToolNameList } from './tool-names.js'
import { getTodoSnapshot } from './todo-dispatcher.js'

/** Default ON — same polarity as AGIM_NATIVE_TOOL_DISCIPLINE. */
export function isTodoGateOn(): boolean {
  const raw = (process.env.AGIM_TODO_GATE ?? '').toLowerCase().trim()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no' || raw === 'disable')
}

/**
 * Tools allowed without a checklist. Mirrors plan-mode read allowlist plus
 * ask_user (clarification before planning) and todo_write itself.
 */
const TODO_GATE_EXEMPT_BASE: readonly string[] = [
  'agim_echo',
  'agim_now',
  'agim_random_uuid',
  'agim_sleep_ms',
  'agim_read_file',
  'agim_list_dir',
  'agim_glob',
  'agim_grep',
  'agim_web_fetch',
  'agim_web_search',
  'agim_todo_write',
  'agim_exit_plan_mode',
  'mcp__agim__ask_user',
  'mcp__agim__read_skill',
  'mcp__agim__list_skills',
  'mcp__agim__search_memos',
  'mcp__agim__memory_list',
  'mcp__agim__memory_query',
]

const TODO_GATE_EXEMPT = expandToolNameList(TODO_GATE_EXEMPT_BASE)

export function isTodoGateExemptTool(toolName: string): boolean {
  if (!toolName) return false
  if (TODO_GATE_EXEMPT.has(toolName)) return true
  const canon = canonicalizeToolName(toolName)
  if (TODO_GATE_EXEMPT.has(canon)) return true
  // Bare mcp__agim__* → short name (ask_user, memory_query, …)
  if (toolName.startsWith('mcp__agim__')) {
    const bare = toolName.slice('mcp__agim__'.length)
    if (TODO_GATE_EXEMPT.has(bare) || TODO_GATE_EXEMPT.has(`mcp__agim__${bare}`)) return true
  }
  return false
}

export type TodoMutationGateResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Hard preflight for mutating tools. Exempt tools always pass.
 * Fail-closed when the store is unavailable.
 */
export function evaluateTodoMutationGate(
  threadKey: string,
  toolName: string,
): TodoMutationGateResult {
  if (!isTodoGateOn()) return { ok: true }
  if (isTodoGateExemptTool(toolName)) return { ok: true }

  const snap = getTodoSnapshot(threadKey)
  if (snap.status === 'unavailable') {
    return {
      ok: false,
      reason:
        'todo-gate: checklist store unavailable; call agim_todo_write after the store recovers '
        + '(or set AGIM_TODO_GATE=off to disable this gate)',
    }
  }
  if (snap.status === 'absent' || snap.items.length === 0) {
    return {
      ok: false,
      reason:
        'todo-gate: write a non-empty agim_todo_write checklist before mutating tools '
        + '(read / ask_user / todo_write are allowed without a plan)',
    }
  }
  return { ok: true }
}

/** Mission-completion presence check when the gate is on. */
export function evaluateTodoPresenceGate(threadKey: string): TodoMutationGateResult {
  if (!isTodoGateOn()) return { ok: true }
  const snap = getTodoSnapshot(threadKey)
  if (snap.status === 'unavailable') {
    return {
      ok: false,
      reason: 'TODO_UNAVAILABLE: checklist store unavailable; completion blocked',
    }
  }
  if (snap.status === 'absent' || snap.items.length === 0) {
    return {
      ok: false,
      reason:
        'TODO_REQUIRED: AGIM_TODO_GATE requires a non-empty agim_todo_write checklist '
        + 'before marking a mission complete',
    }
  }
  return { ok: true }
}

export const TODO_FIRST_PROMPT = [
  '[agim framework rule — todo-first planning]',
  '- Before any mutating tool (agim_exec / agim_write_file / edit / memo write / push / call_agent / loop_verdict / ...), you MUST call agim_todo_write with a non-empty checklist.',
  '- Read tools, ask_user, and agim_todo_write itself are allowed without a checklist.',
  '- For multi-step work, the first tool call should be agim_todo_write. Update the checklist after each completed item.',
  '- Before ending the turn, call agim_todo_write once with every item completed (no trailing in_progress).',
  '- Clearing the list (empty items) re-arms the gate — write a new plan before mutating again.',
  '[/agim framework rule]',
].join('\n')
