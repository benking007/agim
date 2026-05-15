// /a2a — Agent-to-Agent observability.
//
// Subcommands:
//   /a2a            — same as `stats`
//   /a2a stats      — counts + summary of A2A invocations
//   /a2a recent [N] — last N A2A rows
//   /a2a tree <id>  — print the call chain rooted at jobs.id (parent + children)
//
// Backed by jobs.db (kind='inline' rows whose parent_id is non-NULL OR
// whose intent='a2a' in audit).

import type { RouteContext } from '../router.js'
import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { logger as rootLogger } from '../logger.js'
import { AGIM_HOME } from '../agim-paths.js'
import { listOutputs } from '../artifacts.js'

const log = rootLogger.child({ component: 'cmd.a2a' })

interface A2aRow {
  id: number
  agent: string
  parent_id: number | null
  call_depth: number
  status: string
  prompt: string
  started_at: string | null
  completed_at: string | null
  result: string | null
  error: string | null
}

/** Open a read-only handle. /a2a is a viewer — we don't want to take the
 *  same connection job-board.ts uses for writes. better-sqlite3 supports
 *  multiple connections to the same db in WAL mode. */
function openReadOnly(): Database.Database | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const d = new (Database as unknown as { new (path: string, opts?: object): import('better-sqlite3').Database })(
      join(AGIM_HOME, 'jobs.db'),
      { readonly: true, fileMustExist: true },
    )
    d.pragma('journal_mode = WAL')
    return d
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'a2a read-only open failed')
    return null
  }
}

function fmtStats(d: Database.Database): string {
  // Two ways a row is "A2A":
  //   - kind='inline' AND parent_id IS NOT NULL   (the callee row)
  //   - status IN (...) groupings
  const total = (d.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL"
  ).get() as { n: number }).n
  if (total === 0) {
    return '🔗 A2A 暂无记录。'
  }
  const byStatus = d.prepare(
    "SELECT status, COUNT(*) AS n FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL GROUP BY status",
  ).all() as Array<{ status: string; n: number }>
  const byAgent = d.prepare(
    "SELECT agent, COUNT(*) AS n FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL GROUP BY agent ORDER BY n DESC LIMIT 5",
  ).all() as Array<{ agent: string; n: number }>
  const maxDepth = (d.prepare(
    "SELECT MAX(call_depth) AS m FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL"
  ).get() as { m: number | null }).m ?? 0
  const recent24h = (d.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL AND created_at >= datetime('now','-1 day')",
  ).get() as { n: number }).n

  const lines: string[] = [
    `🔗 A2A · 共 ${total} 次调用 · 近 24h ${recent24h} 次 · 最深 ${maxDepth} 层`,
    '',
    '按状态:',
    ...byStatus.map((s) => `   ${s.status}: ${s.n}`),
    '',
    '按 callee agent (Top 5):',
    ...byAgent.map((a) => `   ${a.agent}: ${a.n}`),
    '',
    '/a2a recent [N]   最近 N 次（默认 5）',
    '/a2a tree <id>    打印调用链',
  ]
  return lines.join('\n')
}

function fmtRecent(d: Database.Database, n: number): string {
  const rows = d.prepare(
    `SELECT id, agent, parent_id, call_depth, status,
            substr(prompt, 1, 50) AS prompt,
            started_at, completed_at
       FROM jobs
      WHERE kind='inline' AND parent_id IS NOT NULL
      ORDER BY id DESC
      LIMIT ?`,
  ).all(n) as Array<Pick<A2aRow, 'id' | 'agent' | 'parent_id' | 'call_depth' | 'status' | 'prompt' | 'started_at' | 'completed_at'>>
  if (rows.length === 0) return '🔗 A2A 暂无记录。'
  const lines: string[] = [`🔗 A2A 最近 ${rows.length} 次:`]
  for (const r of rows) {
    const icon =
      r.status === 'delivered' || r.status === 'completed' ? '✅' :
      r.status === 'failed' ? '❌' :
      r.status === 'running' ? '🔄' :
      r.status === 'cancelled' ? '🚫' : '⏳'
    const depth = '↳'.repeat(Math.min(r.call_depth, 5))
    const dur = r.started_at && r.completed_at
      ? `${Math.round((new Date(`${r.completed_at}Z`).getTime() - new Date(`${r.started_at}Z`).getTime()) / 1000)}s`
      : '—'
    lines.push(`   ${icon} #${r.id} ${depth}${r.agent} (←#${r.parent_id ?? '?'}) [${r.status}·${dur}] ${r.prompt}${r.prompt.length >= 50 ? '…' : ''}`)
  }
  return lines.join('\n')
}

async function fmtTree(d: Database.Database, rootId: number): Promise<string> {
  const root = d.prepare(`SELECT * FROM jobs WHERE id = ?`).get(rootId) as A2aRow | undefined
  if (!root) return `❌ 未找到 jobs #${rootId}。`

  // Walk down (children of rootId, grandchildren, ...).
  const lines: string[] = []
  const visited = new Set<number>()
  async function walk(id: number, depth: number): Promise<void> {
    if (visited.has(id) || depth > 10) return
    visited.add(id)
    const row = d.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as A2aRow | undefined
    if (!row) return
    const indent = '  '.repeat(depth)
    const icon =
      row.status === 'delivered' || row.status === 'completed' ? '✅' :
      row.status === 'failed' ? '❌' :
      row.status === 'running' ? '🔄' : '⏳'
    const preview = row.prompt.replace(/\n/g, ' ').slice(0, 60)
    lines.push(`${indent}${icon} #${row.id} ${row.agent} [${row.status}] ${preview}${row.prompt.length > 60 ? '…' : ''}`)
    // L2 — show output files alongside the row. Cheap fs hit; tree is a
    // diagnostic command, not on the hot path.
    const outs = await listOutputs(row.id)
    for (const f of outs) {
      lines.push(`${indent}  📎 ${f.name} (${fmtBytes(f.bytes)})`)
    }
    const children = d.prepare(
      `SELECT id FROM jobs WHERE parent_id = ? ORDER BY id`,
    ).all(id) as Array<{ id: number }>
    for (const c of children) await walk(c.id, depth + 1)
  }
  await walk(rootId, 0)
  return [`🌳 A2A 调用树 (root #${rootId}):`, '', ...lines].join('\n')
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export async function handleA2ACommand(
  args: string,
  _ctx: RouteContext,
): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'stats'

  const d = openReadOnly()
  if (!d) return '❌ A2A 数据不可用（jobs.db 未初始化或不存在）。'

  try {
    switch (sub) {
      case 'stats':
      case 's':
        return fmtStats(d)
      case 'recent':
      case 'r':
      case 'list':
      case 'ls': {
        const n = Math.max(1, Math.min(parseInt(parts[1] || '5', 10) || 5, 30))
        return fmtRecent(d, n)
      }
      case 'tree':
      case 't': {
        const id = parseInt(parts[1] || '', 10)
        if (!Number.isFinite(id) || id <= 0) return '用法: /a2a tree <id>'
        return await fmtTree(d, id)
      }
      default:
        return [
          `❓ 未知子命令: ${sub}`,
          '',
          '可用: /a2a · /a2a recent [N] · /a2a tree <id>',
        ].join('\n')
    }
  } finally {
    try { d.close() } catch { /* ignore */ }
  }
}
