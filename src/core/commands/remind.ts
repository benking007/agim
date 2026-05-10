// /remind command — lightweight one-shot reminders.
//
// /remind <when> <text>             create
// /remind list                      list own pending
// /remind cancel <id>               cancel
// /remind clear                     cancel all own pending
// /remind snooze <id> <when>        snooze (clones row, cancels original)

import type { RouteContext } from '../router.js'
import {
  createReminder, listReminders, cancelReminder, clearReminders, snoozeReminder, retryReminder,
  parseWhenPrefix, parseRecurrencePrefix, parseDuration, describeRecurrence,
  bindEmail, unbindEmail, getBoundEmail,
  isAiwatchEnabled, setAiwatchEnabled,
  ReminderError, MAX_PENDING_PER_USER,
} from '../reminders.js'

const HELP = [
  '🔔 **/remind** — 提醒（一次性 + 定期 + 邮件）',
  '',
  '一次性：',
  '  `/remind 2m 喝水`              相对时间（s/m/h/d）',
  '  `/remind 40秒喝水`              中文相对时间',
  '  `/remind 下午6点下班`            中文时点',
  '  `/remind 18:30 出门吃饭`        今天/明天最近的 18:30',
  '  `/remind 2026-05-09T20:00 ...`  绝对 ISO 时间',
  '',
  '定期 🔁：',
  '  `/remind 每5分钟 看看屏幕外`     每 N 分钟/小时/天',
  '  `/remind 每天早上8点 喝水`       每日固定时间',
  '  `/remind 每周一三五9点 站会`     每周指定几天',
  '  `/remind 每个工作日18:00 下班`   每周一到周五',
  '  `/remind 每周末10点 大扫除`      周六周日',
  '',
  '邮件 ✉️ （前缀 email）：',
  '  `/remind email me@x.com 8:00 早安`     发到指定邮箱',
  '  `/remind email 每天8点 早安`            发到已绑定邮箱',
  '  `/remind bindemail me@x.com`           绑定默认邮箱',
  '  `/remind unbindemail`                  解绑',
  '',
  '智能润色（默认开启 LLM）：',
  '  `/remind 每天8点 喝水`                   默认 LLM 润色后投递',
  '  `/remind literal 每天8点 喝水`           关闭润色，字面投递',
  '  （高频循环 < 1h 必须配 `literal`）',
  '',
  '智能识别（默认开启）：',
  '  直接说"明天8点提醒我开会"，系统会自动识别并请求确认。',
  '  `/remind aiwatch off`                  关闭识别',
  '  `/remind aiwatch on`                   重新开启',
  '',
  '管理：',
  '  `/remind list`                查看待发提醒',
  '  `/remind cancel <id>`         取消（定期 = 终止整条循环）',
  '  `/remind clear`               清空所有待发',
  '  `/remind snooze <id> 5m`      延后',
].join('\n')

const EMAIL_LIKE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function fmtRel(fireAtIso: string, now: Date): string {
  const fireAt = new Date(fireAtIso)
  const diff = fireAt.getTime() - now.getTime()
  if (diff < 0) {
    const s = Math.round(-diff / 1000)
    if (s < 60) return `已过 ${s}s`
    if (s < 3600) return `已过 ${Math.round(s / 60)}m`
    return `已过 ${Math.round(s / 3600)}h`
  }
  const s = Math.round(diff / 1000)
  if (s < 60) return `${s}s 后`
  if (s < 3600) return `${Math.round(s / 60)}m 后`
  if (s < 86400) return `${(s / 3600).toFixed(1)}h 后`
  return `${(s / 86400).toFixed(1)}d 后`
}

export async function handleRemindCommand(args: string, ctx: RouteContext): Promise<string> {
  const trimmed = args.trim()
  if (!trimmed) return HELP

  const parts = trimmed.split(/\s+/)
  const sub = parts[0]
  const ownerOpts = ctx.userId ? { creatorId: ctx.userId } : {}

  // ─── list ──────────────────────────────────────────────────────────
  if (sub === 'list' || sub === 'ls') {
    const all = listReminders({ ...ownerOpts, status: 'pending', limit: MAX_PENDING_PER_USER })
    if (!all.length) return '🔔 当前没有待发提醒。\n\n创建：`/remind 2m 喝水`'
    const now = new Date()
    const lines = all.map((r) => {
      const text = r.text.length > 40 ? `${r.text.slice(0, 40)}…` : r.text
      const icon = r.recurrence ? '🔁' : '🔔'
      const tail = r.recurrence ? `  [${describeRecurrence(r.recurrence)}]` : ''
      return `${icon} #${r.id}  ${fmtRel(r.fire_at, now)}  ${text}${tail}`
    })
    return `🔔 **待发提醒** (${all.length})\n\n${lines.join('\n')}\n\n` +
      '/remind cancel <id>  取消\n/remind clear  清空'
  }

  // ─── cancel ────────────────────────────────────────────────────────
  if (sub === 'cancel' || sub === 'c' || sub === 'rm' || sub === 'del') {
    const id = Number.parseInt(parts[1] || '', 10)
    if (!Number.isFinite(id)) return '用法：`/remind cancel <id>`'
    const ok = cancelReminder(id, ownerOpts)
    return ok ? `✅ 已取消提醒 #${id}` : `❌ 找不到 pending 提醒 #${id}（或不属于你）`
  }

  // ─── clear ─────────────────────────────────────────────────────────
  if (sub === 'clear') {
    if (!ctx.userId) return '❌ 无法识别身份，clear 已拒绝'
    const n = clearReminders({ creatorId: ctx.userId })
    return n > 0 ? `✅ 已取消 ${n} 条待发提醒` : '🔔 没有待取消的提醒'
  }

  // ─── retry ─────────────────────────────────────────────────────────
  if (sub === 'retry') {
    const id = Number.parseInt(parts[1] || '', 10)
    if (!Number.isFinite(id)) return '用法：`/remind retry <id>`'
    const ok = retryReminder(id, ownerOpts)
    return ok
      ? `✅ 已将 #${id} 重新排队（10s 后触发）`
      : `❌ #${id} 不能重试（不存在 / 不属于你 / 还在 pending）`
  }

  // ─── snooze ────────────────────────────────────────────────────────
  if (sub === 'snooze') {
    const id = Number.parseInt(parts[1] || '', 10)
    const dur = parts[2] || ''
    if (!Number.isFinite(id) || !dur) return '用法：`/remind snooze <id> <duration>`，例：`/remind snooze 17 5m`'
    const deltaMs = parseDuration(dur)
    if (deltaMs === null) return `❌ 时长格式错："${dur}"。支持 s/m/h/d，例：5m / 30s / 2h`
    try {
      const newId = snoozeReminder(id, deltaMs, ownerOpts)
      return `✅ 提醒 #${id} 已延后 ${dur}（新 #${newId}）`
    } catch (err) {
      if (err instanceof ReminderError) return `❌ ${err.message}`
      throw err
    }
  }

  // ─── bindemail / unbindemail ───────────────────────────────────────
  if (sub === 'bindemail') {
    if (!ctx.userId) return '❌ 无法识别身份，绑定已拒绝'
    const addr = parts[1] || ''
    if (!addr) {
      const cur = getBoundEmail(ctx.platform, ctx.userId)
      return cur
        ? `📮 当前绑定邮箱：${cur}\n要换：\`/remind bindemail new@example.com\`\n要解：\`/remind unbindemail\``
        : '用法：`/remind bindemail you@example.com`'
    }
    try {
      const bound = bindEmail(ctx.platform, ctx.userId, addr)
      return `✅ 已绑定邮箱：${bound}\n\n之后可以：\`/remind email 每天8点 早安\``
    } catch (err) {
      if (err instanceof ReminderError) return `❌ ${err.message}`
      throw err
    }
  }

  if (sub === 'unbindemail') {
    if (!ctx.userId) return '❌ 无法识别身份'
    return unbindEmail(ctx.platform, ctx.userId)
      ? '✅ 已解绑邮箱'
      : '🔔 当前没有绑定邮箱'
  }

  // ─── aiwatch (intent detector toggle) ──────────────────────────────
  if (sub === 'aiwatch') {
    if (!ctx.userId) return '❌ 无法识别身份'
    const arg = (parts[1] || '').toLowerCase()
    if (!arg) {
      const on = isAiwatchEnabled(ctx.platform, ctx.userId)
      return on
        ? '🔍 智能提醒检测：**开启**\n\n' +
          '当你说"明天8点提醒我开会"这类话时，会自动识别并请求确认。\n关闭：`/remind aiwatch off`'
        : '🔍 智能提醒检测：**关闭**\n\n开启：`/remind aiwatch on`'
    }
    if (arg === 'on' || arg === 'enable' || arg === '1' || arg === 'yes') {
      setAiwatchEnabled(ctx.platform, ctx.userId, true)
      return '✅ 智能提醒检测已开启'
    }
    if (arg === 'off' || arg === 'disable' || arg === '0' || arg === 'no') {
      setAiwatchEnabled(ctx.platform, ctx.userId, false)
      return '✅ 智能提醒检测已关闭'
    }
    return '用法：`/remind aiwatch on` 或 `/remind aiwatch off`'
  }

  // ─── help ──────────────────────────────────────────────────────────
  if (sub === 'help' || sub === '?' || sub === '-h' || sub === '--help') return HELP

  // ─── create ────────────────────────────────────────────────────────
  // Peel prefixes off the head (any order):
  //   `literal` → force prompt_mode='literal' (skip LLM polish)
  //   `email [<addr>]` → re-target to email messenger
  //
  // `/remind literal email me@x.com 2m ...` works the same as
  // `/remind email literal me@x.com 2m ...`.
  let createInput = trimmed
  let promptMode: 'literal' | 'llm' = 'llm'
  let emailTarget: string | null = null
  let routeViaEmail = false

  for (let pass = 0; pass < 2; pass++) {
    const head = createInput.split(/\s+/)[0]
    if (head === 'literal') {
      promptMode = 'literal'
      createInput = createInput.replace(/^literal\s*/, '')
      continue
    }
    if (head === 'email') {
      routeViaEmail = true
      const after = createInput.replace(/^email\s*/, '')
      const second = after.split(/\s+/)[0] || ''
      if (EMAIL_LIKE_RE.test(second)) {
        emailTarget = second
        createInput = after.replace(/^\S+\s*/, '')
      } else {
        if (!ctx.userId) {
          return '❌ 无法识别身份；用 `/remind email you@example.com 2m 内容`'
        }
        emailTarget = getBoundEmail(ctx.platform, ctx.userId)
        if (!emailTarget) {
          return '❌ 还没绑定邮箱。先 `/remind bindemail you@example.com`，或在命令里写明：\n  `/remind email you@example.com 2m 内容`'
        }
        createInput = after
      }
      continue
    }
    break
  }
  if ((routeViaEmail || promptMode === 'literal') && !createInput.trim()) {
    return '❌ 缺少时间和内容。例：`/remind email 每天8点 早安`、`/remind literal 5m 喝水`'
  }

  const now = new Date()
  const recurring = parseRecurrencePrefix(createInput, now)
  const parsed = recurring ?? parseWhenPrefix(createInput, now)
  if (!parsed) {
    return [
      '❌ 没看懂时间。例：',
      '  一次性：`/remind 40秒喝水`、`/remind 下午6点下班`、`/remind 2m drink water`',
      '  定期：`/remind 每天8点喝水`、`/remind 每周一三五9点站会`、`/remind 每5分钟看屏幕外`',
      '  邮件：`/remind email me@x.com 每天8点 早安`',
    ].join('\n')
  }
  // Strip leading "提醒/通知/告诉我/我"-style filler so "40秒提醒我喝水" → "喝水"
  const text = parsed.rest.replace(/^(提醒(我)?|通知(我)?|告诉我|喊我|叫我)[，、:：\s]*/, '').trim()
  if (!text) {
    return '❌ 缺少提醒内容\n\n例：`/remind 40秒喝水` 或 `/remind 每天8点喝水`'
  }

  try {
    const id = createReminder({
      fireAt: parsed.fireAt,
      text,
      platform: routeViaEmail ? 'email' : ctx.platform,
      channelId: routeViaEmail ? 'email' : ctx.channelId,
      threadId: routeViaEmail ? (emailTarget as string) : ctx.threadId,
      userId: ctx.userId || '',
      source: 'slash',
      recurrence: recurring?.recurrence,
      promptMode,
    })
    const icon = routeViaEmail ? '✉️' : recurring ? '🔁' : '✅'
    const recurLine = recurring ? `\n   循环：${describeRecurrence(recurring.recurrence)}` : ''
    const targetLine = routeViaEmail ? `\n   邮件至：${emailTarget}` : ''
    const modeLine = promptMode === 'literal' ? '\n   模式：字面文本（不走 LLM 润色）' : ''
    return `${icon} 已创建提醒 #${id}${recurLine}${targetLine}${modeLine}\n   首次触发：${parsed.fireAt.toLocaleString()} (${fmtRel(parsed.fireAt.toISOString(), now)})\n   内容：${text}`
  } catch (err) {
    if (err instanceof ReminderError) return `❌ ${err.message}`
    throw err
  }
}
