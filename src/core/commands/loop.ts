// /loop — L3 Loop Engineering. See docs/architecture/loop-engineering.md

import type { RouteContext } from '../router.js'
import {
  confirmLoopMission,
  formatAligningPrompt,
  formatLoopEndedSummary,
  formatLoopStatus,
  getActiveLoop,
  getLoopRun,
  getMissionView,
  parseLoopStartText,
  setLoopAcceptance,
  setLoopExit,
  setLoopObjective,
  startLoop,
  stopLoop,
  type LoopRun,
  type StartLoopResult,
} from '../loop-run.js'

const HELP = [
  '🔁 **/loop** — Loop Engineering（L3：对焦 → 拆解 → 子代理 → 验收）',
  '',
  '和 Claude Code 原语对照（防命名混淆）：',
  '  | 场景           | Claude              | Agim                          |',
  '  | 普通对话迭代   | Turn-based / L2     | 普通 Agent 回合（非 /loop）   |',
  '  | 目标+停机条件  | `/goal`             | **本命令 `/loop`**（使命闭环）|',
  '  | 定时再跑 prompt| **`/loop` /schedule** | Heartbeat / 提醒（R6 暂缓） |',
  '  | Focus 注意力   | （会话上下文）      | `/focus`（不是 Loop）         |',
  '',
  '硬输入（缺一不可，确认前不派子代理）：',
  '  **目标** + **退出条件**',
  '',
  '用法：',
  '  `/loop 目标…；退出条件为…`  尽量一次给齐（也可用「退出：…」）',
  '  `/loop` / `/loop start`  Focus 已 on：用 Focus 作文稿，仍须补退出条件',
  '  `/loop start <note>`     Focus 已 on：附带说明启动对焦',
  '  `/loop objective <text>` 对焦中补目标（可含「；验收：…」）',
  '  `/loop exit <text>`      对焦中补退出条件',
  '  `/loop acceptance <text>` 可选验收细则（写入 Mission）',
  '  `/loop confirm`          两硬字段齐后确认 → planning',
  '  `/loop status`           查看阶段 / 目标+退出 / **用量**',
  '  `/loop stop`             强制结束',
  '  `/loop help`             本帮助',
  '',
  '验收：`loop_verdict` 声明 met=true 时，默认再用 cheap 角色做**独立验收**',
  '（`AGIM_LOOP_EVALUATOR=auto|on|off`）。',
  '',
  '派工：本轮首次 `call_agents` 前，父 Agent 禁止自行 web_fetch/exec 做任务',
  '（`AGIM_LOOP_DISPATCH_GATE=on|off`，默认 on）。',
  '',
  '路径 A：先 `/focus …` 再 `/loop` → 结束不关 Focus',
  '路径 B：直接 `/loop <text>` → 代开 Focus，结束 Focus off',
].join('\n')

export async function handleLoopCommand(args: string, ctx: RouteContext): Promise<string> {
  const trimmed = args.trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = (parts[0] || '').toLowerCase()
  const rest = trimmed.slice(parts[0]?.length ?? 0).trim()

  if (sub === 'help' || sub === '?') return HELP

  if (sub === 'status' || sub === 'show') {
    const run = getLoopRun(ctx.platform, ctx.channelId, ctx.threadId)
    if (!run) return '本线程还没有 Loop。用 `/loop 目标…；退出：…` 或先 `/focus` 再 `/loop`。'
    return formatLoopStatus(run)
  }

  if (sub === 'stop' || sub === 'end' || sub === 'cancel') {
    const ended = stopLoop(ctx.platform, ctx.channelId, ctx.threadId, 'user_stop')
    if (!ended) return '没有正在运行的 Loop。'
    const focusNote = ended.openedFocus
      ? '\n\n（本次为直开路径：Focus 已 off）'
      : '\n\n（Focus 保持原样）'
    return formatLoopEndedSummary(ended) + focusNote
  }

  if (sub === 'objective' || sub === 'goal' || sub === '目标') {
    if (!rest) return '用法：`/loop objective <目标描述>`'
    const r = setLoopObjective(ctx.platform, ctx.channelId, ctx.threadId, rest)
    if (!r.ok) return mapAlignError(r.error)
    return maybeConfirmOrPrompt(ctx, r.run)
  }

  if (sub === 'exit' || sub === '退出') {
    if (!rest) return '用法：`/loop exit <退出条件>`（例：验收通过，或最多 5 轮）'
    const r = setLoopExit(ctx.platform, ctx.channelId, ctx.threadId, rest)
    if (!r.ok) return mapAlignError(r.error)
    return maybeConfirmOrPrompt(ctx, r.run)
  }

  if (sub === 'acceptance' || sub === 'accept' || sub === '验收') {
    if (!rest) return '用法：`/loop acceptance <验收细则>`'
    const r = setLoopAcceptance(ctx.platform, ctx.channelId, ctx.threadId, rest)
    if (!r.ok) {
      if (r.error === 'ended') return 'Loop 已结束，无法再改验收。'
      return mapAlignError(r.error)
    }
    if (r.run.status === 'aligning') return formatAligningPrompt(r.run)
    return formatLoopStatus(r.run)
  }

  if (sub === 'confirm' || sub === 'ok' || sub === '确认') {
    const r = confirmLoopMission(ctx.platform, ctx.channelId, ctx.threadId)
    if (!r.ok) {
      if (r.error === 'incomplete') {
        const active = getActiveLoop(ctx.platform, ctx.channelId, ctx.threadId)
        if (active) return formatAligningPrompt(active)
      }
      return mapAlignError(r.error)
    }
    return formatConfirmed(r.run)
  }

  // Bare `/loop` — status if active; else try path A start
  if (!sub) {
    const active = getActiveLoop(ctx.platform, ctx.channelId, ctx.threadId)
    if (active) {
      if (active.status === 'aligning') return formatAligningPrompt(active)
      return formatLoopStatus(active)
    }
    return respondStart(startLoop({
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId || 'unknown',
      text: '',
    }))
  }

  // Aligning: free text updates drafts (and confirms when both present)
  const active = getActiveLoop(ctx.platform, ctx.channelId, ctx.threadId)
  if (active?.status === 'aligning' && sub !== 'start') {
    return applyAligningText(ctx, trimmed)
  }

  // start | bare text → startLoop
  let text = trimmed
  if (sub === 'start') {
    text = rest
  }

  return respondStart(startLoop({
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    userId: ctx.userId || 'unknown',
    text,
  }))
}

function mapAlignError(error: string): string {
  switch (error) {
    case 'no_active_loop':
      return '没有活跃 Loop。先 `/loop …` 启动。'
    case 'not_aligning':
      return '当前不在对焦（ALIGNING）阶段。用 `/loop status` 查看。'
    case 'empty':
      return '内容不能为空。'
    case 'incomplete':
      return '目标与退出条件都需要填写后再 `/loop confirm`。'
    default:
      return `❌ ${error}`
  }
}

function maybeConfirmOrPrompt(ctx: RouteContext, run: LoopRun): string {
  const view = getMissionView(run)
  if (view.objective && view.exitDescription) {
    const confirmed = confirmLoopMission(ctx.platform, ctx.channelId, ctx.threadId)
    if (confirmed.ok) return formatConfirmed(confirmed.run)
  }
  return formatAligningPrompt(run)
}

function applyAligningText(ctx: RouteContext, text: string): string {
  const parsed = parseLoopStartText(text)
  if (parsed.objective) {
    const r = setLoopObjective(ctx.platform, ctx.channelId, ctx.threadId, parsed.objective)
    if (!r.ok) return mapAlignError(r.error)
  }
  if (parsed.exitDescription) {
    const r = setLoopExit(ctx.platform, ctx.channelId, ctx.threadId, parsed.exitDescription)
    if (!r.ok) return mapAlignError(r.error)
  }
  if (!parsed.objective && !parsed.exitDescription) {
    // Treat whole string as objective draft
    const r = setLoopObjective(ctx.platform, ctx.channelId, ctx.threadId, text)
    if (!r.ok) return mapAlignError(r.error)
    return formatAligningPrompt(r.run)
  }
  const run = getActiveLoop(ctx.platform, ctx.channelId, ctx.threadId)
  if (!run) return '没有活跃 Loop。'
  return maybeConfirmOrPrompt(ctx, run)
}

function respondStart(result: StartLoopResult): string {
  if (!result.ok) {
    switch (result.error) {
      case 'already_running':
        return '已有 Loop 在运行。先 `/loop status` 或 `/loop stop`。'
      case 'need_text':
        return 'Focus 未开启。请 `/loop 目标…；退出：…`，或先 `/focus set <标题>` 再 `/loop`。\n\n' + HELP
      case 'focus_set_failed':
      case 'focus_required':
        return '❌ 无法准备 Focus，Loop 未启动。'
      case 'persist_failed':
        return '❌ Loop 状态保存失败。'
      default:
        return `❌ 启动失败：${result.error}`
    }
  }

  if (!result.aligned || result.run.status === 'aligning') {
    return formatAligningPrompt(result.run)
  }
  return formatConfirmed(result.run, result.path)
}

function formatConfirmed(run: LoopRun, path?: 'A' | 'B'): string {
  const pathNote = path === 'B'
    ? '路径 B · 已代开 Focus · 结束会 focus off'
    : path === 'A'
      ? '路径 A · 沿用 Focus · 结束保留 Focus'
      : (run.openedFocus
        ? '结束会 focus off'
        : '结束保留 Focus')
  const view = getMissionView(run)
  return [
    `✅ Loop 使命已确认 → **planning** \`${run.id.slice(0, 8)}\``,
    pathNote,
    `**目标**：${view.objective}`,
    `**退出条件**：${view.exitDescription}`,
    ...(view.acceptance ? [`**验收**：${view.acceptance}`] : []),
    `Round ${run.round}/${view.maxRounds}`,
    '',
    '下一句普通消息后，Agent **须先 `call_agents` 派子代理**（派工前不能自己调研）。',
    '用 `/loop status` 查看；`/loop stop` 结束。',
  ].join('\n')
}
