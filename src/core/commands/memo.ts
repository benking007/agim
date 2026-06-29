// /memo — 5W1H persistent memos. Slash surface is intentionally minimal
// (list / show / delete / help). The interesting interactions go through
// the agent's MCP tools (save_memo / search_memos / etc.) — slash is just
// for management when the user wants to peek at the database directly.
//
// Aliases: /memo · /记
//
// /memo                          list 10 most recent
// /memo list [N]                 list N (max 50)
// /memo show <id>                detail (with map links if where_* set)
// /memo delete <id>              remove
// /memo here [what]              shortcut: issue a GPS capture link with
//                                a note (skips going through the agent)
// /memo help                     this

import type { RouteContext } from '../router.js'
import {
  listMemos, getMemo, deleteMemo, searchMemos,
  type Memo,
  mapUrls,
} from '../memos.js'
import { issueToken } from '../location-token.js'

const DEFAULT_LOC_BASE_URL = 'https://agent.iclaw.host'

const HELP = [
  '📝 /memo — 5W1H 记录',
  '─────────────────────',
  '/memo                          列出最近 10 条',
  '/memo list [N]                 列 N 条',
  '/memo show <id>                查看一条 (含地图链接)',
  '/memo delete <id>              删除',
  '/memo here [what]              拿当前 GPS 链接 (例: /memo here 车)',
  '',
  '更聪明的用法：直接说自然语言交给 agent，例如',
  '  "帮我记下，爸爸的生日是5月8日"',
  '  "我的车在哪？"',
  'agent 会自动调 save_memo / search_memos / request_location_capture',
  '',
  '别名: /memo · /记',
].join('\n')

function fmtRow(m: Memo): string {
  const head = [m.what, m.who && `· ${m.who}`].filter(Boolean).join(' ')
  const when = m.when_text || m.when_at || ''
  const where = m.where_label || (m.where_lat != null ? '📍坐标' : '')
  const meta = [when, where].filter(Boolean).join(' · ')
  const expires = m.expires_at ? ` (⏰ 过期 ${m.expires_at.slice(0, 16)})` : ''
  return `📝 #${m.id}  ${head}${meta ? `\n   ${meta}` : ''}${expires}`
}

function fmtDetail(m: Memo): string {
  const lines: string[] = [`📝 记录 #${m.id}`]
  lines.push(`   what: ${m.what}`)
  if (m.who) lines.push(`   who: ${m.who}`)
  if (m.when_at) lines.push(`   when: ${m.when_at}`)
  else if (m.when_text) lines.push(`   when: ${m.when_text}`)
  if (m.where_label) lines.push(`   where: ${m.where_label}`)
  if (m.where_lat != null && m.where_lng != null) {
    lines.push(`   坐标: ${m.where_lat.toFixed(6)}, ${m.where_lng.toFixed(6)}`)
  }
  if (m.how) lines.push(`   how: ${m.how}`)
  if (m.why) lines.push(`   why: ${m.why}`)
  lines.push(`   来源: ${m.source}`)
  lines.push(`   记于: ${m.created_at}`)
  if (m.expires_at) lines.push(`   ⏰ 自动过期: ${m.expires_at}`)
  if (m.where_lat != null && m.where_lng != null) {
    const urls = mapUrls(m.where_lat, m.where_lng, m.where_label || m.what, '')
    lines.push('')
    lines.push(`   🗺 [百度地图](${urls.baidu}) · [高德地图](${urls.amap}) · [Google](${urls.google})`)
  }
  return lines.join('\n')
}

export async function handleMemoCommand(args: string, ctx: RouteContext): Promise<string> {
  const trimmed = args.trim()
  const ownerOpts = ctx.userId ? { userId: ctx.userId } : {}

  if (!trimmed) return listAction('', ownerOpts)
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase()
  const rest = trimmed.slice(firstWord.length).trim()

  if (firstWord === 'help' || firstWord === '?' || firstWord === '-h' || firstWord === '--help') return HELP
  if (firstWord === 'list' || firstWord === 'ls') return listAction(rest, ownerOpts)
  if (firstWord === 'show' || firstWord === 'get') return showAction(rest, ownerOpts)
  if (firstWord === 'delete' || firstWord === 'del' || firstWord === 'rm') return deleteAction(rest, ownerOpts)
  if (firstWord === 'search' || firstWord === 'find') return searchAction(rest, ownerOpts)
  if (firstWord === 'here' || firstWord === '当前') return hereAction(rest, ctx)

  // Free-form input that's not a known subcommand: treat as a search query.
  // Power-user shortcut for "/memo 车" → search for "车".
  return searchAction(trimmed, ownerOpts)
}

function listAction(rest: string, ownerOpts: { userId?: string }): string {
  const n = rest ? Math.max(1, Math.min(50, parseInt(rest, 10) || 10)) : 10
  const all = listMemos({ ...ownerOpts, limit: n })
  if (!all.length) {
    return [
      '📭 还没有记录。',
      '',
      '让 agent 帮你: 直接说"帮我记下..."',
      '看帮助: /memo help',
    ].join('\n')
  }
  return [`📝 最近 ${all.length} 条记录`, '', ...all.map(fmtRow), '', `详情: /memo show <id>`].join('\n')
}

function showAction(rest: string, ownerOpts: { userId?: string }): string {
  const id = parseInt(rest, 10)
  if (!Number.isFinite(id)) return '用法: /memo show <id>'
  const m = getMemo(id, ownerOpts)
  if (!m) return `❌ 找不到 #${id}（或不属于你）。`
  return fmtDetail(m)
}

function deleteAction(rest: string, ownerOpts: { userId?: string }): string {
  const id = parseInt(rest, 10)
  if (!Number.isFinite(id)) return '用法: /memo delete <id>'
  return deleteMemo(id, ownerOpts) ? `🗑 已删除 #${id}` : `❌ 找不到 #${id}（或不属于你）。`
}

function searchAction(query: string, ownerOpts: { userId?: string }): string {
  const q = query.trim()
  if (!q) return listAction('', ownerOpts)
  const rows = searchMemos({ ...ownerOpts, query: q, limit: 10 })
  if (!rows.length) {
    return `🔍 没有匹配 "${q}" 的记录。\n试试 /memo list 看全部，或让 agent 用更精确的查询：\n"我的${q}在哪？" 或 "${q}相关的记录"`
  }
  return [`🔍 匹配 "${q}" 的 ${rows.length} 条`, '', ...rows.map(fmtRow), '', `详情: /memo show <id>`].join('\n')
}

function hereAction(rest: string, ctx: RouteContext): string {
  const what = rest.trim().slice(0, 80)
  if (!ctx.userId) return '❌ 无法识别用户身份，无法发起位置授权请求。'
  const baseUrl = (process.env.AGIM_LOC_BASE_URL || DEFAULT_LOC_BASE_URL).replace(/\/+$/, '')
  const { token, ttlSeconds } = issueToken(
    {
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId,
    },
    what ? { what } : {},
  )
  const url = `${baseUrl}/l/${token}`
  const ttlMin = Math.floor(ttlSeconds / 60)
  return [
    `📍 [👉 点击共享当前位置](${url})`,
    '',
    `链接 ${ttlMin} 分钟内有效。授权后自动回传给 bot 并记入${what ? ` "${what}"` : ''}。`,
  ].join('\n')
}
