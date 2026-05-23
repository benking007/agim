// /heartbeat command — proactive wake-up loop management (P0 #1).
//
// Subcommands (all per IM thread unless otherwise noted):
//
//   /heartbeat                       same as /heartbeat show (or help if no binding)
//   /heartbeat help                  show usage
//   /heartbeat status                global scheduler health
//   /heartbeat show                  print current binding (body, interval, last tick)
//   /heartbeat bind <body…>          create or replace this thread's binding
//   /heartbeat interval <minutes>    change tick recurrence for this thread
//   /heartbeat cancel                disable this thread's binding (row kept)
//   /heartbeat resume                re-enable a previously-cancelled binding
//   /heartbeat run-now               fire one tick now (debug; respects evaluator gate)
//   /heartbeat list                  admin-only: every binding across threads

import type { RouteContext } from '../router.js'
import {
  upsertBinding, getBinding, disableBinding, enableBinding,
  updateInterval, listAllBindings,
  defaultIntervalMinutes,
  MIN_INTERVAL_MIN, MAX_INTERVAL_MIN, MAX_BODY_CHARS,
} from '../heartbeat-store.js'
import { runForBinding, schedulerInfo } from '../heartbeat.js'
import { isAdmin } from '../admin-allowlist.js'

const HELP = [
  '🫀 **/heartbeat** — agim 主动唤醒（定期跑一段任务，只在有结果时打扰你）',
  '',
  '用法：',
  '  `/heartbeat help`                查看帮助',
  '  `/heartbeat status`              查看调度器运行状态',
  '  `/heartbeat show`                查看当前线程的绑定',
  '  `/heartbeat bind <内容>`          创建/替换绑定（body 即 agent 周期看到的"待办清单"）',
  '  `/heartbeat interval <分钟>`      修改本线程 tick 周期（5–1440 分钟）',
  '  `/heartbeat cancel`              禁用本线程绑定（行保留，可恢复）',
  '  `/heartbeat resume`              恢复已禁用的绑定',
  '  `/heartbeat run-now`             立刻跑一次（仍走 evaluator 静默过滤）',
  '  `/heartbeat list`                列出所有绑定（admin only）',
  '',
  '三阶段流程：',
  '  decide → execute → evaluate → 投递',
  '  · decide：cheap LLM 判断"此刻需要做什么吗"；no → 整个 tick 静默',
  '  · execute：把任务交给本线程的 CLI agent 执行',
  '  · evaluate：把 agent 输出送入通知评估器；纯客套被丢弃',
  '',
  '示例 body：',
  '```',
  '- 每天 8:30 给我一句今天的工作要点',
  '- 盯着 600519 涨停（任意时段触发）',
  '- 收盘后 (15:00) 把今日深市 ETF 净流入前 5 列出来',
  '```',
].join('\n')

export async function handleHeartbeatCommand(args: string, ctx: RouteContext): Promise<string> {
  const trimmed = args.trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = (parts[0] || '').toLowerCase()
  const rest = trimmed.slice(parts[0]?.length ?? 0).trim()

  if (!sub) {
    // Bare `/heartbeat` → show binding if present, otherwise help.
    const existing = getBinding(ctx.platform, ctx.channelId, ctx.threadId)
    if (existing) return renderShow(existing)
    return HELP
  }

  switch (sub) {
    case 'help':
    case '?':
      return HELP

    case 'status':
      return renderStatus()

    case 'show':
    case 'get': {
      const row = getBinding(ctx.platform, ctx.channelId, ctx.threadId)
      if (!row) return '本线程尚未绑定 heartbeat。用 `/heartbeat bind <内容>` 创建。'
      return renderShow(row)
    }

    case 'bind':
    case 'set': {
      const body = rest
      if (!body) {
        return '用法：`/heartbeat bind <希望我周期跑的任务清单>`\n\n例如：\n```\n/heartbeat bind\n- 每天 8:30 给我一句今天的工作要点\n- 盯着 600519 涨停\n```'
      }
      if (body.length > MAX_BODY_CHARS) {
        return `❌ body 超过 ${MAX_BODY_CHARS} 字符（当前 ${body.length}）。删一删再试。`
      }
      const row = upsertBinding({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId || 'unknown',
        body,
      })
      if (!row) return '❌ 保存失败（数据库不可用？）'
      const next = nextTickHint(row.intervalMinutes)
      return `✅ heartbeat 绑定已保存（间隔 ${row.intervalMinutes} 分钟）。${next}\n\n用 \`/heartbeat run-now\` 立刻跑一次试试。`
    }

    case 'interval':
    case 'every': {
      const arg = rest.trim()
      const n = parseIntervalArg(arg)
      if (n === null) {
        return `用法：\`/heartbeat interval <分钟>\` (${MIN_INTERVAL_MIN}–${MAX_INTERVAL_MIN})`
      }
      const ok = updateInterval(ctx.platform, ctx.channelId, ctx.threadId, n)
      if (!ok) return '本线程尚未绑定 heartbeat。先用 `/heartbeat bind <内容>`。'
      return `✅ 已改为每 ${n} 分钟一次。下一次 tick 将在 ≤ ${n} 分钟内到达。`
    }

    case 'cancel':
    case 'disable':
    case 'off': {
      const ok = disableBinding(ctx.platform, ctx.channelId, ctx.threadId)
      if (!ok) return '本线程尚未绑定 heartbeat。'
      return '✅ 已禁用本线程 heartbeat。`/heartbeat resume` 可恢复，`/heartbeat bind` 可重新设置。'
    }

    case 'resume':
    case 'enable':
    case 'on': {
      const ok = enableBinding(ctx.platform, ctx.channelId, ctx.threadId)
      if (!ok) return '本线程尚未绑定 heartbeat。先用 `/heartbeat bind <内容>`。'
      return '✅ 已恢复本线程 heartbeat。下一次 tick 将照常发生。'
    }

    case 'run-now':
    case 'runnow':
    case 'now':
    case 'fire': {
      const row = getBinding(ctx.platform, ctx.channelId, ctx.threadId)
      if (!row) return '本线程尚未绑定 heartbeat。先用 `/heartbeat bind <内容>`。'
      const result = await runForBinding(row)
      switch (result.status) {
        case 'skipped':
          return `⏸ skipped — ${result.reason}\n（没投递；意味着 decide 阶段判断"现在无事可做"或 agent 输出 NO_UPDATE）`
        case 'delivered':
          return `📤 delivered — ${result.reason}\n下面是已经发到本线程的内容：\n\n${result.deliveredText ?? ''}`
        case 'suppressed':
          return `🤐 suppressed — ${result.reason}\n（evaluator 认为无需打扰；原始输出已被静默丢弃）\n\nagent 原文（仅本次命令可见）：\n${truncate(result.rawAgentOutput || '', 600)}`
        case 'no-agent':
          return `⚠️ no-agent — ${result.reason}\n（本线程还没有可用的 CLI agent。在该线程先发一次正常对话即可激活）`
        case 'failed':
          return `❌ failed — ${result.reason}`
      }
      return `状态未知`
    }

    case 'list': {
      if (!isAdmin(ctx.platform, ctx.userId || '')) {
        return '❌ `/heartbeat list` 仅 admin 可用。'
      }
      const rows = listAllBindings()
      if (rows.length === 0) return '（暂无任何 heartbeat 绑定）'
      const lines = rows.map(r => {
        const flag = r.enabled ? '✅' : '⏸'
        const last = r.lastTickAt ? `${r.lastStatus} @ ${r.lastTickAt} UTC` : 'never ticked'
        return `${flag} #${r.id} ${r.platform}:${r.threadId} · every ${r.intervalMinutes}m · ${last}`
      })
      return ['🫀 **All heartbeats**', ...lines].join('\n')
    }

    default:
      return `未知子命令: \`/heartbeat ${sub}\`。用 \`/heartbeat help\` 查看用法。`
  }
}

function renderShow(row: import('../heartbeat-store.js').HeartbeatRow): string {
  const enabledFlag = row.enabled ? '✅ 启用' : '⏸ 已禁用'
  const last = row.lastTickAt
    ? `最近 tick：**${row.lastStatus}** @ ${row.lastTickAt} UTC\n  原因：${row.lastReason || '(无)'}`
    : '尚未 tick 过'
  const preview = row.lastTextPreview
    ? `\n最近投递预览：\n> ${truncate(row.lastTextPreview, 200).replace(/\n/g, '\n> ')}`
    : ''
  return [
    `🫀 **Heartbeat 绑定** (${enabledFlag})`,
    `线程：\`${row.platform}:${row.channelId}:${row.threadId}\``,
    `周期：每 ${row.intervalMinutes} 分钟一次`,
    last + preview,
    '',
    'Body：',
    '```',
    truncate(row.body, 1200),
    '```',
    '',
    '操作：`/heartbeat run-now` · `/heartbeat interval N` · `/heartbeat cancel`',
  ].join('\n')
}

function renderStatus(): string {
  const info = schedulerInfo()
  return [
    '🫀 **Heartbeat scheduler**',
    `- 已启用 (env IMHUB_HEARTBEAT_ENABLED)：${info.enabled ? '是' : '否'}`,
    `- 正在运行：${info.running ? '是' : '否'}`,
    `- Tick 间隔：${(info.periodMs / 1000).toFixed(0)}s`,
    `- 每行绑定的实际周期由 \`/heartbeat interval\` 控制（默认 ${defaultIntervalMinutes()} 分钟）`,
    '',
    info.enabled
      ? ''
      : '提示：调度器未启用。`export IMHUB_HEARTBEAT_ENABLED=on` 然后重启 agim 即可自动 tick；现在仍可手工 `/heartbeat run-now`。',
  ].filter(Boolean).join('\n')
}

function parseIntervalArg(arg: string): number | null {
  if (!arg) return null
  // Accept "30", "30m", "30min", "30 分钟"
  const m = arg.match(/^(\d+)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MIN || n > MAX_INTERVAL_MIN) return null
  return n
}

function nextTickHint(intervalMinutes: number): string {
  if (intervalMinutes <= 30) return `下一次 tick 将在 ≤ ${intervalMinutes} 分钟内到达。`
  if (intervalMinutes <= 90) return `下一次 tick 在 ~${intervalMinutes} 分钟后。`
  return `下一次 tick 在 ~${(intervalMinutes / 60).toFixed(1)} 小时后。`
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n)}…`
}
