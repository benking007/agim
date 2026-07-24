// /loop — Phase C development loop. See docs/architecture/loop-engineering.md

import type { RouteContext } from '../router.js'
import {
  formatLoopStatus,
  getActiveLoop,
  getLoopRun,
  startLoop,
  stopLoop,
} from '../loop-run.js'

const HELP = [
  '🔁 **/loop** — 开发闭环（Focus 上的 executor ↔ observer）',
  '',
  '用法：',
  '  `/loop <text>`           Focus 未开时：代开 Focus 并启动（结束会 focus off）',
  '  `/loop` / `/loop start`  Focus 已 on：直接启动（结束保留 Focus）',
  '  `/loop start <note>`     Focus 已 on：启动并附带说明',
  '  `/loop status`           查看状态',
  '  `/loop stop`             强制结束',
  '  `/loop help`             本帮助',
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

  if (!sub) {
    const active = getActiveLoop(ctx.platform, ctx.channelId, ctx.threadId)
    if (active) return formatLoopStatus(active)
    // Path A: Focus already on → start with no note; else need text (error from startLoop).
    const result = startLoop({
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId || 'unknown',
      text: '',
    })
    if (!result.ok) {
      if (result.error === 'need_text') {
        return 'Focus 未开启。请 `/loop <要聚焦的内容>`，或先 `/focus set <标题>` 再 `/loop`。\n\n' + HELP
      }
      if (result.error === 'already_running') return '已有 Loop 在运行。`/loop status` 或 `/loop stop`。'
      return `❌ 启动失败：${result.error}`
    }
    return formatStartOk(result.run, result.path, '')
  }

  if (sub === 'status' || sub === 'show') {
    const run = getLoopRun(ctx.platform, ctx.channelId, ctx.threadId)
    if (!run) return '本线程还没有 Loop。用 `/loop <text>` 或先 `/focus` 再 `/loop` 启动。'
    return formatLoopStatus(run)
  }

  if (sub === 'stop' || sub === 'end' || sub === 'cancel') {
    const ended = stopLoop(ctx.platform, ctx.channelId, ctx.threadId, 'user_stop')
    if (!ended) return '没有正在运行的 Loop。'
    const focusNote = ended.openedFocus
      ? '\n（本次为直开路径：Focus 已 off）'
      : '\n（Focus 保持原样）'
    return `🛑 Loop 已结束。${focusNote}`
  }

  // start | bare text
  let text = trimmed
  if (sub === 'start') {
    text = rest
  }

  const result = startLoop({
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    userId: ctx.userId || 'unknown',
    text,
  })

  if (!result.ok) {
    switch (result.error) {
      case 'already_running':
        return '已有 Loop 在运行。先 `/loop status` 或 `/loop stop`。'
      case 'need_text':
        return 'Focus 未开启。请 `/loop <要聚焦的内容>`，或先 `/focus set <标题>` 再 `/loop`。'
      case 'focus_set_failed':
      case 'focus_required':
        return '❌ 无法准备 Focus，Loop 未启动。'
      case 'persist_failed':
        return '❌ Loop 状态保存失败。'
      default:
        return `❌ 启动失败：${result.error}`
    }
  }

  return formatStartOk(result.run, result.path, text)
}

function formatStartOk(
  run: import('../loop-run.js').LoopRun,
  path: 'A' | 'B',
  text: string,
): string {
  if (path === 'A') {
    return [
      `✅ Loop 已启动（路径 A · 沿用现有 Focus）\`${run.id.slice(0, 8)}\``,
      `Round 1/${run.maxRounds} · 结束时 **不会** 关闭 Focus`,
      run.startNote ? `Note: ${run.startNote}` : '',
      '用 `/loop status` 查看；`/loop stop` 结束。',
    ].filter(Boolean).join('\n')
  }
  return [
    `✅ Loop 已启动（路径 B · 已代开 Focus）\`${run.id.slice(0, 8)}\``,
    `Focus: ${text}`,
    `Round 1/${run.maxRounds} · 结束时会 **focus off**`,
    '用 `/loop status` 查看；`/loop stop` 结束。',
  ].join('\n')
}
