/**
 * Loop dispatch hard gate (R3).
 *
 * While an active Loop is in PLAN/DISPATCH and this round still has
 * dispatchesThisRound === 0, the *parent* agent must not do the research /
 * mutation work itself — it must call_agent(s) (or ask_user / todo / stop).
 *
 * This closes the production failure mode where the model writes a Plan
 * checklist then web_fetches step 1 alone, leaving 派工=0 and no Subagent cards.
 *
 * Opt out: AGIM_LOOP_DISPATCH_GATE=off|0|false|no|disable
 */

import { canonicalizeToolName, expandToolNameList } from './llm/tool-names.js'
import { getActiveLoop } from './loop-run.js'

/** Default ON when a Loop is active in the dispatch window. */
export function isLoopDispatchGateOn(): boolean {
  const raw = (process.env.AGIM_LOOP_DISPATCH_GATE ?? '').toLowerCase().trim()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no' || raw === 'disable')
}

/**
 * Tools allowed before the first dispatch of the round.
 * Everything else (web_fetch / exec / write / …) is refused so the parent
 * cannot "do the mission" instead of spawning Subagents.
 */
const DISPATCH_GATE_EXEMPT_BASE: readonly string[] = [
  'agim_echo',
  'agim_now',
  'agim_random_uuid',
  'agim_sleep_ms',
  'agim_todo_write',
  'agim_exit_plan_mode',
  'mcp__agim__ask_user',
  'mcp__agim__call_agent',
  'mcp__agim__call_agents',
  'mcp__agim__loop_verdict',
  'mcp__agim__read_skill',
  'mcp__agim__list_skills',
  'mcp__agim__search_memos',
  'mcp__agim__memory_list',
  'mcp__agim__memory_query',
]

const DISPATCH_GATE_EXEMPT = expandToolNameList(DISPATCH_GATE_EXEMPT_BASE)

export function isLoopDispatchGateExemptTool(toolName: string): boolean {
  if (!toolName) return false
  if (DISPATCH_GATE_EXEMPT.has(toolName)) return true
  const canon = canonicalizeToolName(toolName)
  if (DISPATCH_GATE_EXEMPT.has(canon)) return true
  if (toolName.startsWith('mcp__agim__')) {
    const bare = toolName.slice('mcp__agim__'.length)
    if (DISPATCH_GATE_EXEMPT.has(bare) || DISPATCH_GATE_EXEMPT.has(`mcp__agim__${bare}`)) return true
  }
  // Bare short names used by some adapters
  const lower = toolName.toLowerCase()
  if (
    lower === 'call_agent' || lower === 'call_agents'
    || lower === 'ask_user' || lower === 'loop_verdict'
    || lower === 'todo_write' || lower === 'agim_todo_write'
  ) return true
  return false
}

export type LoopDispatchGateResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Hard preflight: when Loop needs a first dispatch this round, block
 * parent-side research/mutation tools until call_agent(s) succeeds.
 */
export function evaluateLoopDispatchGate(
  platform: string,
  channelId: string,
  threadId: string,
  toolName: string,
): LoopDispatchGateResult {
  if (!isLoopDispatchGateOn()) return { ok: true }
  if (!platform || !threadId) return { ok: true }
  if (isLoopDispatchGateExemptTool(toolName)) return { ok: true }

  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return { ok: true }
  if (run.status === 'aligning' || run.status === 'ended') return { ok: true }
  if ((run.dispatchesThisRound || 0) >= 1) return { ok: true }

  // planning / dispatching / running / observing / verifying / reflecting
  // with 0 dispatches → parent must spawn first (or ask_user / todo / stop).
  return {
    ok: false,
    reason:
      'loop-dispatch-gate: this Loop round has 0 dispatches — call mcp__agim__call_agents '
      + '(or call_agent) to spawn Subagents before doing research/mutation yourself '
      + '(web_fetch / exec / write / …). ask_user / todo_write / loop_verdict stop are allowed. '
      + 'Set AGIM_LOOP_DISPATCH_GATE=off to disable.',
  }
}
