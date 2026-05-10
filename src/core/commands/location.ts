// /location — record + recall geo memos.
//
// /location                          list (last 10)
// /location list [N]                 list last N (max 100)
// /location <lat>,<lng> [memo]       record by coords (zero-dep path)
// /location <lat> <lng> [memo]       same, space-separated
// /location <address> [memo]         record by text address (requires geocode key)
// /location show <id>                show one with map URL
// /location delete <id>              remove
// /location help                     help
//
// Owner-scoped per (platform, userId) — same pattern as /remind, /cron.

import type { RouteContext } from '../router.js'
import {
  createMemo, listMemos, getMemo, deleteMemo,
  parseCoordPair, stripCoordPrefix,
  geocodeAddress, isGeocodingAvailable,
  mapUrl,
} from '../locations.js'

const HELP = [
  '📍 /location — 位置备忘',
  '─────────────────────',
  '/location <lat>,<lng> [备注]   记录坐标 (例: /location 39.908,116.397 停车场B区)',
  '/location <地址> [备注]         按地址记录 (需配置腾讯地图 key)',
  '/location list [N]              列出最近 N 条 (默认 10)',
  '/location show <id>             查看详情 + 地图链接',
  '/location delete <id>           删除',
  '',
  '别名: /loc · /位置',
].join('\n')

function fmtRow(m: { id: number; lat: number; lng: number; label: string; note: string; created_at: string }): string {
  const head = m.label || m.note || `${m.lat.toFixed(4)},${m.lng.toFixed(4)}`
  const dim = `#${m.id} · ${m.created_at}`
  return `📍 ${head}\n   ${dim}`
}

function fmtDetail(m: {
  id: number; lat: number; lng: number; label: string; note: string;
  source: string; created_at: string;
}): string {
  const url = mapUrl(m.lat, m.lng, m.label || m.note || `位置 #${m.id}`, m.label)
  return [
    `📍 位置 #${m.id}`,
    m.label ? `   位置: ${m.label}` : '',
    m.note ? `   备注: ${m.note}` : '',
    `   坐标: ${m.lat.toFixed(6)}, ${m.lng.toFixed(6)}`,
    `   来源: ${m.source === 'geocoded' ? '地址解析' : m.source === 'browser' ? '浏览器定位' : '手动录入'}`,
    `   时间: ${m.created_at}`,
    '',
    `   🗺 ${url}`,
  ].filter(Boolean).join('\n')
}

export async function handleLocationCommand(args: string, ctx: RouteContext): Promise<string> {
  const trimmed = args.trim()
  const ownerOpts = ctx.userId ? { userId: ctx.userId } : {}

  // Bare `/location` → list
  if (!trimmed) return listAction('', ownerOpts)

  // Help / sub-commands first (before falling through to coord/address parse).
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase()
  if (firstWord === 'help' || firstWord === '?' || firstWord === '-h' || firstWord === '--help') {
    return HELP
  }
  if (firstWord === 'list' || firstWord === 'ls') {
    return listAction(trimmed.slice(firstWord.length).trim(), ownerOpts)
  }
  if (firstWord === 'show' || firstWord === 'get') {
    return showAction(trimmed.slice(firstWord.length).trim(), ownerOpts)
  }
  if (firstWord === 'delete' || firstWord === 'del' || firstWord === 'rm') {
    return deleteAction(trimmed.slice(firstWord.length).trim(), ownerOpts)
  }

  // Coord input (preferred path — zero infrastructure required).
  const coords = parseCoordPair(trimmed)
  if (coords) {
    const note = stripCoordPrefix(trimmed)
    try {
      const id = createMemo({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId,
        lat: coords.lat,
        lng: coords.lng,
        note,
        source: 'manual',
      })
      const m = getMemo(id, ownerOpts)
      if (!m) return `✅ 已记录 #${id}（详情查询失败，见 /location show ${id}）`
      return `✅ 已记录\n${fmtDetail(m)}`
    } catch (err) {
      return `❌ 记录失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Address input (geocode). Treat the whole trimmed input as the address +
  // optional trailing note separated by a single space — heuristic: the first
  // 1-3 Chinese tokens are the address, rest is note. For v1 keep it simple:
  // the whole input is the address; if user wants a note, they can add it on
  // /location show + /location delete + recreate. Or future flag.
  if (!isGeocodingAvailable()) {
    return [
      '❌ 不识别为坐标，且地址解析未配置。',
      '',
      '试试坐标输入: /location 39.908,116.397 停车场B区',
      '或配置 IMHUB_TENCENT_MAP_KEY 启用地址识别（lbs.qq.com 注册免费 key）。',
    ].join('\n')
  }

  const geo = await geocodeAddress(trimmed)
  if (!geo.ok) {
    switch (geo.reason) {
      case 'quota':
        return [
          `❌ 地图服务今日配额已用尽（status ${geo.status}）。`,
          '解决：[lbs.qq.com](https://lbs.qq.com) 控制台 → 配额管理 → 申请免费配额。',
          '或者直接用坐标：/location 39.908,116.397',
        ].join('\n')
      case 'signature':
        return [
          `❌ 地图 key 签名校验失败（status ${geo.status}）。`,
          '检查：IMHUB_TENCENT_MAP_KEY 是否对应 IMHUB_TENCENT_MAP_SK；',
          '或在控制台关掉强制签名校验。',
        ].join('\n')
      case 'http':
        return `❌ 地图服务 HTTP 错误（${geo.status}），稍后再试或用坐标。`
      case 'not_found':
        return [
          `❌ 找不到 "${trimmed}" 这个位置。`,
          '换个具体点的地址试试，或直接给坐标：/location 39.908,116.397',
        ].join('\n')
      default:
        return [
          `❌ 地址解析失败：${geo.message ?? geo.reason}。`,
          '可以直接给坐标：/location 39.908,116.397',
        ].join('\n')
    }
  }
  try {
    const id = createMemo({
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId,
      lat: geo.lat,
      lng: geo.lng,
      label: geo.formattedAddress,
      note: '',
      source: 'geocoded',
    })
    const m = getMemo(id, ownerOpts)
    if (!m) return `✅ 已记录 #${id}（${geo.formattedAddress}）`
    return `✅ 已记录\n${fmtDetail(m)}`
  } catch (err) {
    return `❌ 记录失败：${err instanceof Error ? err.message : String(err)}`
  }
}

function listAction(rest: string, ownerOpts: { userId?: string }): string {
  const n = rest ? Math.max(1, Math.min(100, parseInt(rest, 10) || 10)) : 10
  const all = listMemos({ ...ownerOpts, limit: n })
  if (!all.length) {
    return [
      '📭 还没有位置备忘。',
      '',
      '记录一条: /location <lat>,<lng> [备注]',
      '看帮助: /location help',
    ].join('\n')
  }
  return [`📍 最近 ${all.length} 条位置备忘`, '', ...all.map(fmtRow), '', `详情: /location show <id>`].join('\n')
}

function showAction(rest: string, ownerOpts: { userId?: string }): string {
  const id = parseInt(rest, 10)
  if (!Number.isFinite(id)) return '用法: /location show <id>'
  const m = getMemo(id, ownerOpts)
  if (!m) return `❌ 找不到 #${id}（或不属于你）。`
  return fmtDetail(m)
}

function deleteAction(rest: string, ownerOpts: { userId?: string }): string {
  const id = parseInt(rest, 10)
  if (!Number.isFinite(id)) return '用法: /location delete <id>'
  return deleteMemo(id, ownerOpts)
    ? `🗑 已删除 #${id}`
    : `❌ 找不到 #${id}（或不属于你）。`
}
