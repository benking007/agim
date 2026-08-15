// /sessions — list recent local conversations for the current platform
//
// Reads ~/.agim/sessions/*.json (same store as SessionManager). Does not
// call an external dashboard — personal installs have nothing on :8001.

import type { RouteContext } from '../router.js'
import { sessionManager, type RecentSessionSummary } from '../session.js'

const DEFAULT_LIMIT = 10

export type SessionLister = (opts: {
  platform?: string
  limit?: number
}) => Promise<RecentSessionSummary[]>

function formatAge(lastActivity: Date, nowMs: number): string {
  const ageHours = (nowMs - lastActivity.getTime()) / 3_600_000
  if (!Number.isFinite(ageHours) || ageHours < 0) return '?'
  if (ageHours < 1) return '<1h'
  if (ageHours < 24) return `${Math.round(ageHours)}h`
  return `${Math.round(ageHours / 24)}d`
}

export async function handleSessionsCommand(
  _args: string,
  ctx: RouteContext,
  listSessions: SessionLister = (opts) => sessionManager.listRecentSessions(opts),
): Promise<string> {
  const rows = await listSessions({ platform: ctx.platform, limit: DEFAULT_LIMIT })
  if (!rows.length) return '📋 暂无活跃会话。'

  const nowMs = Date.now()
  let msg = `📋 最近 ${rows.length} 个会话:\n\n`
  rows.forEach((s, i) => {
    const time = s.lastActivity.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    const title = s.threadId || s.channelId || '(无标题)'
    const agent = s.agent || '?'
    msg += `${i + 1}. ${title}\n   ${time} · ${agent} · ${s.turns}轮 · ${formatAge(s.lastActivity, nowMs)}前\n`
  })
  return msg
}
