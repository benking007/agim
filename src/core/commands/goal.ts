// /goal command — sustained-objective tracking (P0 #2).
//
// Subcommands (per IM thread unless noted):
//
//   /goal                       same as /goal show (or help if none set)
//   /goal help                  usage
//   /goal set <title…>          create / replace the active goal
//   /goal body <body…>          add or replace the longer body for the active goal
//   /goal show [<id>]           print active goal (or specific id)
//   /goal list                  every goal for this thread (any status)
//   /goal progress <note…>      append a 'user' progress note
//   /goal pause                 pause the active goal (kept, not injected)
//   /goal resume <id>           resume a paused goal (auto-pauses current)
//   /goal complete              mark active goal completed
//   /goal cancel                mark active goal cancelled
//   /goal all                   admin: every active goal across threads
//
// Goals are bound to the current thread (platform + channelId + threadId).
// Each thread has at most ONE active goal at a time.

import type { RouteContext } from '../router.js'
import { isAdmin } from '../admin-allowlist.js'
import {
  setActiveGoal, appendProgress, updateStatus, resumeGoal,
  getGoalById, getActiveGoal, listGoalsForThread, listAllActiveGoals,
  formatGoalShow,
  MAX_TITLE_CHARS, MAX_BODY_CHARS, MAX_PROGRESS_NOTE_CHARS,
  type GoalRow,
} from '../goals.js'

const HELP = [
  '🎯 **/goal** — 长时目标跟踪（一个线程一次一个活动目标）',
  '',
  '用法：',
  '  `/goal`                      查看本线程当前活动目标（无则显示帮助）',
  '  `/goal set <标题>`            创建/替换活动目标（旧的自动 pause）',
  '  `/goal body <内容>`           为活动目标补充/替换详细描述（多行）',
  '  `/goal show [<id>]`           查看活动目标或指定 id',
  '  `/goal list`                 列出本线程所有目标（含历史）',
  '  `/goal progress <说明>`       记录一条进度（带时间戳，注入下一轮 prompt）',
  '  `/goal pause`                暂停活动目标（保留行；不再注入 prompt）',
  '  `/goal resume <id>`          恢复某个 paused 目标为 active',
  '  `/goal complete`             标记活动目标已完成 🎯',
  '  `/goal cancel`               标记活动目标已取消 ✖',
  '  `/goal all`                  admin：列出所有线程的活动目标',
  '',
  '与 /remind / /cron / /heartbeat 的区别：',
  '  · 提醒：一次性触发文本',
  '  · cron：定时跑 agent，回合无状态',
  '  · 心跳：定期检查"现在要做什么吗"',
  '  · 目标：跨多轮持续的主线任务，agent 每轮都看到，引导他保持方向',
  '',
  '示例：',
  '  `/goal set 这周完成 v1.3.0 发布`',
  '  `/goal body 包括：CHANGELOG、版本号 bump、release notes、推 npm`',
  '  `/goal progress 已完成 CHANGELOG 草稿`',
  '  `/goal complete`',
].join('\n')

export async function handleGoalCommand(args: string, ctx: RouteContext): Promise<string> {
  const trimmed = args.trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = (parts[0] || '').toLowerCase()
  const rest = trimmed.slice(parts[0]?.length ?? 0).trim()

  if (!sub) {
    const active = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
    if (active) return formatGoalShow(active)
    return HELP
  }

  switch (sub) {
    case 'help':
    case '?':
      return HELP

    case 'show':
    case 'get': {
      const idArg = rest.trim()
      if (idArg) {
        const id = parseId(idArg)
        if (id === null) return `❌ 无效 id：${idArg}`
        const row = getGoalById(id)
        if (!row) return `❌ 未找到 goal #${id}`
        if (row.platform !== ctx.platform || row.channelId !== ctx.channelId || row.threadId !== ctx.threadId) {
          return `❌ goal #${id} 不属于本线程`
        }
        return formatGoalShow(row)
      }
      const active = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
      if (!active) return '本线程当前没有活动目标。`/goal set <标题>` 创建一个。'
      return formatGoalShow(active)
    }

    case 'set':
    case 'create':
    case 'new': {
      const title = rest.trim()
      if (!title) {
        return `用法：\`/goal set <标题>\`（≤ ${MAX_TITLE_CHARS} 字符）。后续可用 \`/goal body\` 补充详细描述。`
      }
      if (title.length > MAX_TITLE_CHARS) {
        return `❌ 标题过长（${title.length} > ${MAX_TITLE_CHARS}）`
      }
      const row = setActiveGoal({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId || 'unknown',
        title,
      })
      if (!row) return '❌ 保存失败（数据库不可用？）'
      return `✅ 已设为活动目标 #${row.id}：${row.title}\n用 \`/goal body <详细描述>\` 补充背景，或 \`/goal progress\` 开始记录进度。`
    }

    case 'body':
    case 'desc':
    case 'detail': {
      const active = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
      if (!active) return '本线程没有活动目标。先用 `/goal set <标题>` 创建。'
      const body = rest.trim()
      if (!body) {
        return `用法：\`/goal body <详细描述>\`（≤ ${MAX_BODY_CHARS} 字符，支持多行）`
      }
      if (body.length > MAX_BODY_CHARS) {
        return `❌ body 过长（${body.length} > ${MAX_BODY_CHARS}）`
      }
      // Re-set keeps title; we model "edit body" as set+title+body. The
      // setActiveGoal helper auto-pauses the existing row + creates a
      // new active row. That preserves the historical record (old row
      // stays as paused with the old body) — by design.
      const row = setActiveGoal({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId || 'unknown',
        title: active.title,
        body,
      })
      if (!row) return '❌ 保存失败'
      return `✅ goal #${row.id} body 已更新（旧版本 #${active.id} 已保留为 paused）`
    }

    case 'progress':
    case 'prog':
    case 'log': {
      const note = rest.trim()
      if (!note) {
        return `用法：\`/goal progress <说明>\`（≤ ${MAX_PROGRESS_NOTE_CHARS} 字符）`
      }
      const active = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
      if (!active) return '本线程没有活动目标，无处记录。'
      const ok = appendProgress(active.id, 'user', note)
      if (!ok) return '❌ 记录失败'
      return `✅ 已记录到 goal #${active.id}（注入下一轮 prompt 让 agent 看到）`
    }

    case 'pause':
    case 'off': {
      const active = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
      if (!active) return '本线程没有活动目标可暂停。'
      const ok = updateStatus(active.id, 'paused')
      if (!ok) return '❌ pause 失败'
      return `⏸ goal #${active.id} 已暂停（仍可 \`/goal resume ${active.id}\` 恢复，或 \`/goal list\` 查看历史）。`
    }

    case 'resume':
    case 'on': {
      const id = parseId(rest)
      if (id === null) return '用法：`/goal resume <id>`（id 通过 `/goal list` 查看）'
      const row = getGoalById(id)
      if (!row) return `❌ 未找到 goal #${id}`
      if (row.platform !== ctx.platform || row.channelId !== ctx.channelId || row.threadId !== ctx.threadId) {
        return `❌ goal #${id} 不属于本线程`
      }
      if (row.status === 'completed' || row.status === 'cancelled') {
        return `❌ goal #${id} 已 ${row.status}，不能恢复（用 \`/goal set\` 创建新目标）`
      }
      const ok = resumeGoal(id)
      if (!ok) return '❌ resume 失败'
      return `✅ goal #${id} 已恢复为活动状态（之前的活动目标已自动 pause）`
    }

    case 'complete':
    case 'done':
    case 'finish': {
      const active = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
      if (!active) return '本线程没有活动目标可完成。'
      appendProgress(active.id, 'system', `marked completed by ${ctx.userId ?? 'unknown'}`)
      const ok = updateStatus(active.id, 'completed')
      if (!ok) return '❌ complete 失败'
      return `🎯 goal #${active.id} 已标记完成。下次设新目标用 \`/goal set <标题>\`。`
    }

    case 'cancel':
    case 'abort':
    case 'drop': {
      const active = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
      if (!active) return '本线程没有活动目标可取消。'
      appendProgress(active.id, 'system', `cancelled by ${ctx.userId ?? 'unknown'}`)
      const ok = updateStatus(active.id, 'cancelled')
      if (!ok) return '❌ cancel 失败'
      return `✖ goal #${active.id} 已取消。`
    }

    case 'list':
    case 'history': {
      const rows = listGoalsForThread(ctx.platform, ctx.channelId, ctx.threadId)
      if (rows.length === 0) return '本线程还没有任何目标（含历史）。'
      return ['📜 **本线程目标历史**（按 id 倒序）', ...rows.map(formatRowLine)].join('\n')
    }

    case 'all': {
      if (!isAdmin(ctx.platform, ctx.userId || '')) {
        return '❌ `/goal all` 仅 admin 可用。'
      }
      const rows = listAllActiveGoals()
      if (rows.length === 0) return '（当前没有任何活动目标）'
      return ['🎯 **所有活动目标**', ...rows.map((r) => `#${r.id} ${r.platform}:${r.threadId} — ${r.title}`)].join('\n')
    }

    default:
      return `未知子命令：\`/goal ${sub}\`。用 \`/goal help\` 查看用法。`
  }
}

function parseId(raw: string): number | null {
  const stripped = raw.trim().replace(/^#/, '')
  const n = parseInt(stripped, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function formatRowLine(r: GoalRow): string {
  const flag = ({
    active: '✅',
    paused: '⏸',
    completed: '🎯',
    cancelled: '✖',
  })[r.status]
  const progress = r.progressLog.length > 0 ? ` · ${r.progressLog.length} progress` : ''
  return `${flag} #${r.id} [${r.status}] ${r.title} (updated ${r.updatedAt} UTC)${progress}`
}
