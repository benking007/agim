// /focus — attention anchor (Focus primitive). See docs/architecture/focus.md

import type { RouteContext } from '../router.js'
import {
  appendFocusNote,
  focusClear,
  focusOff,
  focusOn,
  formatFocusShow,
  getFocusOn,
  getFocusRetained,
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  setFocus,
} from '../focus.js'
import { cancelLoopForFocusOff } from '../loop-run.js'

const HELP = [
  '◎ **/focus** — 聚焦（注意力锚点；开启时每轮自动注入）',
  '',
  '用法：',
  '  `/focus`                      查看当前 Focus（无则显示帮助）',
  '  `/focus set <标题>`            设置内容并开启注入',
  '  `/focus <标题>`                同上（省略 set）',
  '  `/focus body <内容>`           补充/替换正文（需已有 Focus）',
  '  `/focus show`                 查看',
  '  `/focus on`                   开启注入（需已有内容）',
  '  `/focus off`                  关闭注入，保留内容',
  '  `/focus clear`                清除内容并关闭',
  '  `/focus help`                 本帮助',
  '',
  '与 /loop：可先 focus 再 loop（结束保留 focus）；或直接 `/loop <text>` 代开。',
  '旧命令 `/goal` 已废弃，请改用 `/focus`。',
].join('\n')

const DEPRECATION =
  '⚠️ `/goal` 已废弃，请改用 `/focus`（on/off/set/clear）。完成闭环请用 `/loop`。\n\n'

export async function handleFocusCommand(args: string, ctx: RouteContext): Promise<string> {
  return dispatchFocus(args, ctx, false)
}

/** Deprecated `/goal` surface — forwards to Focus with a banner. */
export async function handleGoalCommandDeprecated(args: string, ctx: RouteContext): Promise<string> {
  const mapped = mapGoalArgsToFocus(args)
  if (mapped.kind === 'hard_deprecated') {
    return DEPRECATION + mapped.message
  }
  const body = await dispatchFocus(mapped.args, ctx, true)
  return DEPRECATION + body
}

function mapGoalArgsToFocus(args: string): { kind: 'forward'; args: string } | { kind: 'hard_deprecated'; message: string } {
  const trimmed = args.trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = (parts[0] || '').toLowerCase()
  const rest = trimmed.slice(parts[0]?.length ?? 0).trim()

  if (!sub) return { kind: 'forward', args: '' }
  switch (sub) {
    case 'help':
    case '?':
      return { kind: 'forward', args: 'help' }
    case 'show':
    case 'get':
      return { kind: 'forward', args: 'show' }
    case 'set':
    case 'create':
    case 'new':
      return { kind: 'forward', args: rest ? `set ${rest}` : 'set' }
    case 'body':
    case 'desc':
    case 'detail':
      return { kind: 'forward', args: rest ? `body ${rest}` : 'body' }
    case 'pause':
    case 'off':
      return { kind: 'forward', args: 'off' }
    case 'resume':
    case 'on':
      // Old resume required id; Focus on uses retained content.
      return { kind: 'forward', args: 'on' }
    case 'cancel':
    case 'abort':
    case 'drop':
      return { kind: 'forward', args: 'clear' }
    case 'complete':
    case 'done':
    case 'finish':
      return {
        kind: 'hard_deprecated',
        message: '`/goal complete` 已废弃（完成语义不在 Focus 上）。请用 `/loop` 做开发闭环，或 `/focus off` 停止注入。',
      }
    case 'progress':
    case 'prog':
    case 'log':
      return { kind: 'forward', args: rest ? `note ${rest}` : 'note' }
    case 'list':
    case 'history':
    case 'all':
      return {
        kind: 'hard_deprecated',
        message: `\`/goal ${sub}\` 已废弃。查看当前聚焦用 \`/focus show\`。`,
      }
    default:
      // Treat bare text after /goal as set (legacy muscle memory).
      return { kind: 'forward', args: `set ${trimmed}` }
  }
}

async function dispatchFocus(args: string, ctx: RouteContext, _fromGoal: boolean): Promise<string> {
  const trimmed = args.trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = (parts[0] || '').toLowerCase()
  const rest = trimmed.slice(parts[0]?.length ?? 0).trim()

  if (!sub) {
    const retained = getFocusRetained(ctx.platform, ctx.channelId, ctx.threadId)
    if (retained) return formatFocusShow(retained)
    return HELP
  }

  switch (sub) {
    case 'help':
    case '?':
      return HELP

    case 'show':
    case 'get': {
      const retained = getFocusRetained(ctx.platform, ctx.channelId, ctx.threadId)
      if (!retained) return '本线程没有 Focus。用 `/focus set <标题>` 创建一个。'
      return formatFocusShow(retained)
    }

    case 'set':
    case 'create':
    case 'new': {
      const title = rest.trim()
      if (!title) return `用法：\`/focus set <标题>\`（≤ ${MAX_TITLE_CHARS} 字符）`
      if (title.length > MAX_TITLE_CHARS) {
        return `❌ 标题过长（${title.length} > ${MAX_TITLE_CHARS}）`
      }
      const row = setFocus({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId || 'unknown',
        title,
      })
      if (!row) return '❌ 保存失败（数据库不可用？）'
      return `✅ Focus 已开启：${row.title}\n可用 \`/focus body <详细描述>\` 补充，或 \`/focus off\` 暂停注入。`
    }

    case 'body':
    case 'desc':
    case 'detail': {
      const current = getFocusRetained(ctx.platform, ctx.channelId, ctx.threadId)
      if (!current) return '本线程没有 Focus。先用 `/focus set <标题>`。'
      const body = rest.trim()
      if (!body) return `用法：\`/focus body <详细描述>\`（≤ ${MAX_BODY_CHARS} 字符）`
      if (body.length > MAX_BODY_CHARS) {
        return `❌ body 过长（${body.length} > ${MAX_BODY_CHARS}）`
      }
      const row = setFocus({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId || 'unknown',
        title: current.title,
        body,
      })
      if (!row) return '❌ 保存失败'
      return `✅ Focus body 已更新（注入${row.enabled ? '中' : '将在 on 后生效'}）。`
    }

    case 'on': {
      const r = focusOn(ctx.platform, ctx.channelId, ctx.threadId)
      if (!r.ok) {
        if (r.error === 'no_focus') return '没有可开启的 Focus 内容。先用 `/focus set <标题>`。'
        return '❌ focus on 失败'
      }
      return `✅ Focus 已开启注入：${r.focus.title}`
    }

    case 'off': {
      const r = focusOff(ctx.platform, ctx.channelId, ctx.threadId)
      if (!r.ok) return '本线程没有 Focus 可关闭。'
      cancelLoopForFocusOff(ctx.platform, ctx.channelId, ctx.threadId)
      return `⏸ Focus 已关闭注入（内容保留）。可用 \`/focus on\` 恢复。`
    }

    case 'clear': {
      const had = getFocusRetained(ctx.platform, ctx.channelId, ctx.threadId)
      if (!had) return '本线程没有 Focus 可清除。'
      cancelLoopForFocusOff(ctx.platform, ctx.channelId, ctx.threadId)
      const r = focusClear(ctx.platform, ctx.channelId, ctx.threadId)
      if (!r.ok) return '❌ focus clear 失败'
      return '✖ Focus 已清除。'
    }

    case 'note':
    case 'progress': {
      const note = rest.trim()
      if (!note) return '用法：`/focus note <说明>`'
      if (!getFocusOn(ctx.platform, ctx.channelId, ctx.threadId)) {
        return 'Focus 未开启，无法记 note。先 `/focus on` 或 `/focus set`。'
      }
      if (!appendFocusNote(ctx.platform, ctx.channelId, ctx.threadId, note)) {
        return '❌ 记录失败'
      }
      return '✅ 已记录（底层仍写入 progress；Focus 注入以标题/正文为主）。'
    }

    default: {
      // Bare `/focus <text>` → set
      const title = trimmed
      if (title.length > MAX_TITLE_CHARS) {
        return `❌ 标题过长（${title.length} > ${MAX_TITLE_CHARS}）`
      }
      const row = setFocus({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId || 'unknown',
        title,
      })
      if (!row) return '❌ 保存失败（数据库不可用？）'
      return `✅ Focus 已开启：${row.title}`
    }
  }
}
