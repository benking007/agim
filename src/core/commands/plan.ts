// /plan [on|off] — toggle plan mode for the active agent
//
// Plan mode is a per-session flag the router forwards to the agent adapter:
//   • claude-code  → spawns with `--permission-mode plan` (read-only)
//   • opencode     → routes through the built-in `plan` agent
//   • codex        → spawns with `-s read-only` sandbox (OS-level write fence;
//                     not a true approval gate, see codex/index.ts header)
//   • native (v1.2.120) → resolvePolicy() hard-denies native_write_file +
//                          native_exec; system prompt gets a PlanMode banner
//   • other agents → ignore the flag (no-op)
//
// Persisted on session.planMode so it survives across turns and across the
// /oc ↔ /cc agent switch (intent travels with the conversation, not with
// the chosen CLI). v1.2.120 also writes to plan-mode-state.db so the native
// adapter can apply the override even when the conversation hasn't yet
// rebuilt its in-memory session row (e.g. after a process restart).
//
// Emergency kill switch: `AGIM_PLAN_MODE=disabled` (legacy
// `AGIM_DISABLE_PLAN_MODE=1`) makes /plan return a static notice.
// "disabled" message without touching session state. Useful for ops to roll
// back the feature without redeploying.

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'
import { approvalBus, threadKey as makeThreadKey } from '../approval-bus.js'
import { PLAN_EXIT_TOOL_NAME } from '../llm/plan-exit-dispatcher.js'
import {
  setPlanModeForThread,
  clearPlanModeForThread,
  resolvePlanModeEnvPolicy,
  setLivePlanMode,
  getLivePlanMode,
} from '../plan-mode-state.js'

const ON_TOKENS = new Set(['on', 'enter', 'start', 'enable', '开', '开启'])
const OFF_TOKENS = new Set(['off', 'exit', 'stop', 'disable', '关', '关闭'])

/** Peel Portal `[技能：…]` / attachment markers so `/plan` still matches. */
function peelLeadingMarkers(text: string): string {
  return text.trim().replace(/^(?:\[[^\]]+\]\s*)+/u, '').trim()
}

const PLAN_SLASH_RE = /^\/(plan(?:-?on|-?off)?|planon|planoff)(?:\s+([\s\S]*))?$/i

/** True for `/plan`, `/plan on|off`, `/plan-off`, `/planoff` (and on aliases). */
export function isPlanModeSlashCommand(text: string): boolean {
  return PLAN_SLASH_RE.test(peelLeadingMarkers(text))
}

/**
 * Args to feed `handlePlanCommand`, or `null` when `text` is not a plan slash.
 * `/plan-off` / `/planoff` map to `off`; `/plan-on` / `/planon` map to `on`.
 */
export function parsePlanSlashArgs(text: string): string | null {
  const match = peelLeadingMarkers(text).match(PLAN_SLASH_RE)
  if (!match) return null
  const cmd = match[1].toLowerCase()
  if (cmd === 'plan-off' || cmd === 'planoff') return 'off'
  if (cmd === 'plan-on' || cmd === 'planon') return 'on'
  return (match[2] ?? '').trim()
}

/** Approve any in-flight `agim_exit_plan_mode` card on this thread. */
function resolvePendingPlanExits(ctx: RouteContext): number {
  const pending = approvalBus.listPending().filter((row) => (
    row.threadId === ctx.threadId
    && row.platform === ctx.platform
    && row.toolName === PLAN_EXIT_TOOL_NAME
  ))
  let n = 0
  for (const row of pending) {
    const actor = row.approverUserId || ctx.userId || ''
    const info = approvalBus.resolvePendingByReqId(row.reqId, { behavior: 'allow' }, actor)
    if (info) n += 1
  }
  return n
}

/** Agents that genuinely honor session.planMode at adapter level.
 *  - claude-code: --permission-mode plan
 *  - opencode:    --agent plan
 *  - codex:       -s read-only sandbox (sandbox-level "safety floor" — see
 *                 plugins/agents/codex/index.ts header for the caveat)
 *  - native (v1.2.120): plan-mode-state.db + resolvePolicy() denies
 *                 native_write_file + native_exec; system prompt gets
 *                 a PlanMode banner */
// v1.2.134 — added 'cursor' which has had --plan since v1.2.49 but was
// missing from this set (so the warning incorrectly fired for cursor).
const PLAN_CAPABLE_AGENTS = new Set(['claude-code', 'opencode', 'codex', 'cursor', 'agim', 'native'])

export async function handlePlanCommand(args: string, ctx: RouteContext): Promise<string> {
  if (resolvePlanModeEnvPolicy() === 'disabled') {
    return '🚫 Plan 模式已通过 AGIM_PLAN_MODE=disabled（或旧键 AGIM_DISABLE_PLAN_MODE）全局禁用，请联系运维。'
  }

  const token = args.trim().toLowerCase()
  const existing = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)

  if (!token) {
    const cur = existing?.planMode ? 'on' : 'off'
    const agent = existing?.agent || ctx.defaultAgent
    const capable = PLAN_CAPABLE_AGENTS.has(agent)
    // v1.2.134 — per-agent breakdown of how plan mode is actually enforced.
    // Used to also list "exit handshake" — kept narrow to what each agent does.
    const PLAN_MECH: Record<string, string> = {
      'claude-code': '`--permission-mode plan`（只读权限模式）',
      'codex':       '`-s read-only` 沙盒（OS 层只读，非 approval 闸门）',
      'cursor':      '`--plan` 旗标（cursor-agent 自带的 plan 模式）',
      'opencode':    '`--agent plan`（切到 opencode 内置 plan agent）',
      'agim':        'policy denyList 拒绝 agim_write_file / agim_exec + `agim_exit_plan_mode` 握手出 plan 模式',
      'native':      'alias of agim — same plan-mode handshake (legacy id)',
    }
    const activeMech = PLAN_MECH[agent] ?? '（该 agent 未对接 plan 模式）'
    const others = Object.entries(PLAN_MECH)
      .filter(([k]) => k !== agent)
      .map(([k, v]) => `  · ${k}: ${v}`)
      .join('\n')
    const agentNote = capable
      ? ''
      : `\n\n⚠️ 当前 agent **${agent}** 暂未对接 plan 模式 —— /plan 会改 session 标志位，但 ${agent} 不读它。要规划-only 行为请用 ${agent} 自身的只读模式，或 /cc / /oc 切到对接版本。`
    return `📐 Plan 模式: \`${cur}\`（当前 agent: \`${agent}\`）

**生效方式（${agent}）**: ${activeMech}

切换：
  /plan on   开启 plan 模式
  /plan off  关闭，恢复正常执行

其他 agent 的对应机制：
${others}

plan 模式下文件不会被修改，适合先讨论方案再动手。${agentNote}`
  }

  // Ensure a session exists so the patch is durable. Defer to the active
  // sticky agent if one exists, else the configured default.
  await sessionManager.getOrCreateSession(
    ctx.platform, ctx.channelId, ctx.threadId,
    existing?.agent || ctx.defaultAgent,
  )

  // Warn (don't refuse) when the active agent doesn't honor plan mode —
  // the user might intentionally pre-set the flag before /cc-switching to
  // a capable agent. Surface, then proceed.
  const activeAgent = existing?.agent || ctx.defaultAgent
  const capabilityNote = PLAN_CAPABLE_AGENTS.has(activeAgent)
    ? ''
    : `\n\n⚠️ 当前 agent **${activeAgent}** 不读 planMode 标志位（claude-code / opencode / codex / cursor / native 才支持）。标志会保存，但要切到上述 agent 才会生效。`

  // v1.2.120 — compose the composite key once. native reads from the
  // plan-mode-state.db keyed by this exact composite (matches
  // sendPrompt's makeThreadKey call).
  const tkey = makeThreadKey(ctx.platform, ctx.channelId, ctx.threadId)

  if (ON_TOKENS.has(token)) {
    // Seed the in-flight harness even when session is already on, so a
    // mid-turn `/plan on` hard-denies writes for the rest of this turn.
    setLivePlanMode(tkey, true)
    if (existing?.planMode) return `✅ Plan 模式已开启（无变化）。${capabilityNote}`
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { planMode: true })
    // v1.2.120 — also write to plan-mode-state so the native agent
    // picks it up (session.planMode is read by CLI adapters but
    // native's resolvePolicy() reads plan-mode-state.db).
    setPlanModeForThread(tkey, true)
    return `✅ Plan 模式已开启 — 接下来 agent 只规划不动手。/plan off 恢复。${capabilityNote}`
  }

  if (OFF_TOKENS.has(token)) {
    const liveWasOn = getLivePlanMode(tkey) === true
    // Always knock down the live gate first: intent auto-enter only sets
    // opts.planMode for this turn and never writes session.planMode, so
    // "session already off" must still unlock in-flight writes.
    setLivePlanMode(tkey, false)
    const resolvedExits = resolvePendingPlanExits(ctx)
    if (existing?.planMode) {
      await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { planMode: false })
    }
    // v1.2.120 — drop the per-thread row so the env default applies
    // again (don't write `false`; that would override env=on too).
    clearPlanModeForThread(tkey)
    if (!existing?.planMode && !liveWasOn && resolvedExits === 0) {
      return 'ℹ️ Plan 模式本来就是关闭状态。'
    }
    return '✅ Plan 模式已关闭 — 恢复正常执行模式。'
  }

  return `⚠️ 无效参数: \`${token}\`

/plan on | off`
}
