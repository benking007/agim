// /outbox — inspect and operate the message-sink delivery queue.
//
// Subcommands:
//   /outbox            — same as `status`
//   /outbox status     — aggregate counts (pending / delivered / giving_up)
//   /outbox list [N]   — last N rows (default 10)
//   /outbox failed [N] — last N rows in 'giving_up' state
//   /outbox retry <id> — move a 'giving_up' row back to 'pending'
//
// Why expose this:
//   - Operators need quick visibility into stuck deliveries without
//     opening sqlite (`sqlite3 ~/.agim/outbox.db` works but isn't IM-friendly).
//   - 'giving_up' is terminal by design — without a retry knob, a transient
//     IM-side outage that spans the 6-step backoff (~2h cumulative) would
//     leave good messages permanently dead-lettered.
//
// Permission model: the underlying outbox table is global. Phase 1 keeps
// this command admin-only / not multi-tenant — every IM user sees the same
// rows. If multi-tenant slicing becomes a requirement, gate by ctx.userId
// the same way job-board does (createJob's creator_id column).

import type { RouteContext } from '../router.js'
import {
  getOutboxStats, listOutbox, retryGivingUp, type OutboxRow, type OutboxStatus,
} from '../outbox.js'

function fmtRow(r: OutboxRow): string {
  const icon = r.status === 'delivered' ? '✅'
    : r.status === 'giving_up' ? '💀'
    : '📤'
  const ts = new Date(`${r.created_at}Z`).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit',
  })
  const preview = r.payload.replace(/\n/g, ' ').slice(0, 40)
    + (r.payload.length > 40 ? '…' : '')
  const errTail = r.last_error ? ` · err: ${r.last_error.slice(0, 60)}` : ''
  return `${icon} #${r.id} ${r.platform}/${r.thread_id} [${r.status} · ${r.attempts}x] ${preview} · ${ts}${errTail}`
}

function fmtStatus(): string {
  const stats = getOutboxStats()
  const total = stats.pending + stats.delivered + stats.giving_up
  return [
    `📬 outbox · 共 ${total}`,
    `   ⏳ pending: ${stats.pending}`,
    `   ✅ delivered: ${stats.delivered}`,
    `   💀 giving_up: ${stats.giving_up}`,
    '',
    `提示: /outbox list · /outbox failed · /outbox retry <id>`,
  ].join('\n')
}

export async function handleOutboxCommand(
  args: string,
  _ctx: RouteContext,
): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'status'

  switch (sub) {
    case 'status':
    case 's':
      return fmtStatus()

    case 'list':
    case 'ls': {
      const n = Math.max(1, Math.min(parseInt(parts[1] || '10', 10) || 10, 50))
      const rows = listOutbox({ limit: n })
      if (rows.length === 0) return '📬 outbox 为空。'
      return [`📬 outbox · 最近 ${rows.length} 条:`, '', ...rows.map(fmtRow)].join('\n')
    }

    case 'failed': {
      const n = Math.max(1, Math.min(parseInt(parts[1] || '10', 10) || 10, 50))
      const rows = listOutbox({ status: 'giving_up' as OutboxStatus, limit: n })
      if (rows.length === 0) return '✅ 没有 giving_up 行。'
      return [
        `💀 outbox 失败列表 · ${rows.length} 条`,
        '',
        ...rows.map(fmtRow),
        '',
        `回执 /outbox retry <id> 可重新入队`,
      ].join('\n')
    }

    case 'retry': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id) || id <= 0) {
        return '❌ 用法: /outbox retry <id>'
      }
      const ok = retryGivingUp(id)
      return ok
        ? `✅ outbox #${id} 已重新入队 (attempts 重置)`
        : `❌ outbox #${id} 不存在或不在 giving_up 状态`
    }

    default:
      return [
        `❓ 未知子命令: ${sub}`,
        '',
        '可用: /outbox · /outbox list [N] · /outbox failed [N] · /outbox retry <id>',
      ].join('\n')
  }
}
