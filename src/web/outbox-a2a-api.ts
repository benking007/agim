// outbox-a2a-api — Outbox delivery queue + A2A chain inspector + Artifacts.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET  /api/outbox              → list outbox rows             — admin only
//   GET  /api/outbox/stats        → aggregate stats              — admin only
//   POST /api/outbox/:id/retry    → retry giving_up row          — admin only
//   GET  /api/a2a/stats           → A2A aggregate stats          — open (no sensitive data)
//   GET  /api/a2a/recent          → recent A2A calls             — open
//   GET  /api/a2a/tree/:id        → tree walk from root job      — open
//   GET  /api/artifacts/:id       → list artifacts for job       — open
//   GET  /api/artifacts/:id/file/:name → download artifact file  — open

import type { IncomingMessage, ServerResponse } from 'node:http'
import { logger as rootLogger } from '../core/logger.js'
import { sendJson } from './http-utils.js'
import { requireAdmin } from './auth.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleOutboxA2AApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/outbox' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleListOutbox(req, res, url); return true
  }
  if (p === '/api/outbox/stats' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleOutboxStats(req, res); return true
  }
  const outboxRetryMatch = p.match(/^\/api\/outbox\/(\d+)\/retry$/)
  if (outboxRetryMatch && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleOutboxRetry(req, res, parseInt(outboxRetryMatch[1], 10)); return true
  }
  if (p === '/api/a2a/stats' && m === 'GET') {
    await handleA2AStats(req, res); return true
  }
  if (p === '/api/a2a/recent' && m === 'GET') {
    await handleA2ARecent(req, res, url); return true
  }
  const a2aTreeMatch = p.match(/^\/api\/a2a\/tree\/(\d+)$/)
  if (a2aTreeMatch && m === 'GET') {
    await handleA2ATree(req, res, parseInt(a2aTreeMatch[1], 10)); return true
  }
  const artifactsListMatch = p.match(/^\/api\/artifacts\/(\d+)$/)
  if (artifactsListMatch && m === 'GET') {
    await handleArtifactsList(req, res, parseInt(artifactsListMatch[1], 10)); return true
  }
  const artifactsFileMatch = p.match(/^\/api\/artifacts\/(\d+)\/file\/([\w.+-]+)$/)
  if (artifactsFileMatch && m === 'GET') {
    await handleArtifactsFile(req, res, parseInt(artifactsFileMatch[1], 10), artifactsFileMatch[2]); return true
  }
  return false
}

export async function openJobsDbReadOnly(): Promise<import('better-sqlite3').Database | null> {
  try {
    const path = await import('node:path')
    const { AGIM_HOME } = await import('../core/agim-paths.js')
    const Database = (await import('better-sqlite3')).default
    const d = new Database(
      path.join(AGIM_HOME, 'jobs.db'),
      { readonly: true, fileMustExist: true },
    )
    d.pragma('journal_mode = WAL')
    return d
  } catch (err) {
    rootLogger.warn(
      { component: 'web', event: 'web.jobs_db_open_failed', err: err instanceof Error ? err.message : String(err) },
      'failed to open jobs.db for A2A read',
    )
    return null
  }
}

async function handleListOutbox(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { listOutbox } = await import('../core/outbox.js')
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500)
    const statusRaw = url.searchParams.get('status') || ''
    const status = ['pending', 'delivered', 'giving_up'].includes(statusRaw)
      ? (statusRaw as 'pending' | 'delivered' | 'giving_up')
      : undefined
    const threadKey = url.searchParams.get('thread') || undefined
    const rows = listOutbox({ limit, status, threadKey })
    sendJson(res, 200, { rows })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleOutboxStats(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { getOutboxStats } = await import('../core/outbox.js')
    sendJson(res, 200, getOutboxStats())
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleOutboxRetry(_req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  try {
    const { retryGivingUp } = await import('../core/outbox.js')
    const ok = retryGivingUp(id)
    if (!ok) {
      sendJson(res, 404, { ok: false, error: `outbox #${id} not found or not in giving_up state` })
      return
    }
    sendJson(res, 200, { ok: true, id })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleA2AStats(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const d = await openJobsDbReadOnly()
  if (!d) { sendJson(res, 503, { error: 'jobs.db not available' }); return }
  try {
    const total = (d.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL"
    ).get() as { n: number }).n
    const recent24h = (d.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL AND created_at >= datetime('now','-1 day')"
    ).get() as { n: number }).n
    const maxDepth = (d.prepare(
      "SELECT MAX(call_depth) AS m FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL"
    ).get() as { m: number | null }).m ?? 0
    const byStatus = d.prepare(
      "SELECT status, COUNT(*) AS n FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL GROUP BY status"
    ).all() as Array<{ status: string; n: number }>
    const byAgent = d.prepare(
      "SELECT agent, COUNT(*) AS n FROM jobs WHERE kind='inline' AND parent_id IS NOT NULL GROUP BY agent ORDER BY n DESC LIMIT 10"
    ).all() as Array<{ agent: string; n: number }>
    sendJson(res, 200, { total, recent24h, maxDepth, byStatus, byAgent })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  } finally {
    try { d.close() } catch { /* ignore */ }
  }
}

async function handleA2ARecent(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const d = await openJobsDbReadOnly()
  if (!d) { sendJson(res, 503, { error: 'jobs.db not available' }); return }
  try {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 200)
    const rows = d.prepare(
      `SELECT id, agent, parent_id, call_depth, status,
              substr(prompt, 1, 200) AS prompt,
              substr(result, 1, 500) AS result,
              error,
              created_at, started_at, completed_at, delivered_at
         FROM jobs
        WHERE kind='inline' AND parent_id IS NOT NULL
        ORDER BY id DESC
        LIMIT ?`,
    ).all(limit)
    sendJson(res, 200, { rows })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  } finally {
    try { d.close() } catch { /* ignore */ }
  }
}

async function handleA2ATree(_req: IncomingMessage, res: ServerResponse, rootId: number): Promise<void> {
  const dMaybe = await openJobsDbReadOnly()
  if (!dMaybe) { sendJson(res, 503, { error: 'jobs.db not available' }); return }
  const d = dMaybe  // captured non-null binding for nested async closures
  try {
    const { listOutputs } = await import('../core/artifacts.js')
    interface Node {
      id: number; agent: string; status: string; parent_id: number | null
      call_depth: number; prompt: string; result: string | null; error: string | null
      created_at: string; started_at: string | null; completed_at: string | null; delivered_at: string | null
      outputs: Array<{ name: string; bytes: number; mtime: string }>
      children: Node[]
    }
    const rootRow = d.prepare(
      `SELECT id, agent, status, parent_id, call_depth,
              substr(prompt, 1, 400) AS prompt,
              substr(result, 1, 1000) AS result, error,
              created_at, started_at, completed_at, delivered_at
         FROM jobs WHERE id = ?`,
    ).get(rootId) as Omit<Node, 'outputs' | 'children'> | undefined
    if (!rootRow) { sendJson(res, 404, { error: `job #${rootId} not found` }); return }

    const visited = new Set<number>()
    async function build(row: Omit<Node, 'outputs' | 'children'>, depth: number): Promise<Node> {
      visited.add(row.id)
      const node: Node = { ...row, outputs: await listOutputs(row.id), children: [] }
      if (depth >= 10) return node
      const kids = d.prepare(
        `SELECT id, agent, status, parent_id, call_depth,
                substr(prompt, 1, 400) AS prompt,
                substr(result, 1, 1000) AS result, error,
                created_at, started_at, completed_at, delivered_at
           FROM jobs WHERE parent_id = ? ORDER BY id`,
      ).all(row.id) as Array<Omit<Node, 'outputs' | 'children'>>
      for (const k of kids) {
        if (!visited.has(k.id)) node.children.push(await build(k, depth + 1))
      }
      return node
    }
    const tree = await build(rootRow, 0)
    sendJson(res, 200, { tree })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  } finally {
    try { d.close() } catch { /* ignore */ }
  }
}

async function handleArtifactsList(_req: IncomingMessage, res: ServerResponse, jobId: number): Promise<void> {
  try {
    const { statJob } = await import('../core/artifacts.js')
    const s = await statJob(jobId)
    sendJson(res, 200, { jobId, inputs: s.inputs, outputs: s.outputs, totalBytes: s.bytes })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleArtifactsFile(
  _req: IncomingMessage, res: ServerResponse, jobId: number, name: string,
): Promise<void> {
  try {
    const { readOutput, getArtifactsDir } = await import('../core/artifacts.js')
    let buf = await readOutput(jobId, name)
    if (!buf) {
      const { existsSync, promises: fs } = await import('node:fs')
      const path = await import('node:path')
      const { inputDir } = getArtifactsDir(jobId)
      const p = path.join(inputDir, name)
      if (existsSync(p) && !name.includes('/') && name !== '..') {
        buf = await fs.readFile(p)
      }
    }
    if (!buf) { sendJson(res, 404, { error: `artifact ${name} not found for job ${jobId}` }); return }
    const lower = name.toLowerCase()
    const contentType =
      lower.endsWith('.json') ? 'application/json' :
      lower.endsWith('.md')   ? 'text/markdown' :
      lower.endsWith('.csv')  ? 'text/csv' :
      lower.endsWith('.png')  ? 'image/png' :
      lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' :
      'application/octet-stream'
    const disposition = lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.svg') || lower.endsWith('.xml')
      ? 'attachment'
      : 'inline'
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': buf.length,
      'Content-Disposition': `${disposition}; filename="${name.replace(/"/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    })
    res.end(buf)
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
