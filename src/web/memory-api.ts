// memory-api — REST surface for memory, vector index, consolidation, and
// distillation admin. Extracted from server.ts; follows the dispatcher
// pattern used by mcp-api.ts.
//
// Endpoints (all under /api/memory/*):
//   GET    /api/memory/users                    → list users          — admin
//   GET    /api/memory/facts                    → list/search facts   — admin
//   DELETE /api/memory/facts                    → bulk delete facts   — admin
//   DELETE /api/memory/facts/:id                → delete one fact     — admin
//   GET    /api/memory/persona                  → get persona         — admin
//   PUT    /api/memory/persona                  → upsert persona      — admin
//   DELETE /api/memory/persona                  → delete persona      — admin
//   GET    /api/memory/export                   → export user memory  — admin
//   GET    /api/memory/vector/status            → backend status      — any auth
//   POST   /api/memory/vector/test              → test backend        — admin
//   POST   /api/memory/vector/download          → trigger download    — admin
//   POST   /api/memory/vector/backfill          → backfill embeddings — admin
//   POST   /api/memory/vector/clear             → clear embeddings    — admin
//   POST   /api/memory/consolidate              → run consolidation   — admin
//   GET    /api/memory/consolidate/status       → consolidation jobs  — admin
//   POST   /api/memory/distill                  → run distillation    — admin
//   GET    /api/memory/distill/status           → distillation status — admin

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError } from './http-utils.js'
import { requireAdmin } from './auth.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleMemoryApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/memory/users' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryUsers(req, res); return true
  }
  if (p === '/api/memory/facts' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryFacts(req, res, url); return true
  }
  if (p === '/api/memory/facts' && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryBulkDelete(req, res, url); return true
  }
  const memFactIdMatch = p.match(/^\/api\/memory\/facts\/(\d+)$/)
  if (memFactIdMatch && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryDeleteOne(req, res, url, parseInt(memFactIdMatch[1], 10)); return true
  }
  if (p === '/api/memory/persona' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryPersona(req, res, url); return true
  }
  if (p === '/api/memory/persona' && m === 'PUT') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryPersonaPut(req, res, url); return true
  }
  if (p === '/api/memory/persona' && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryPersonaDelete(req, res, url); return true
  }
  if (p === '/api/memory/export' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryExport(req, res, url); return true
  }
  if (p === '/api/memory/vector/status' && m === 'GET') {
    await handleVectorStatus(req, res, url); return true
  }
  if (p === '/api/memory/vector/test' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleVectorTest(req, res); return true
  }
  if (p === '/api/memory/vector/download' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleVectorDownload(req, res); return true
  }
  if (p === '/api/memory/vector/backfill' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleVectorBackfill(req, res, url); return true
  }
  if (p === '/api/memory/vector/clear' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleVectorClear(req, res, url); return true
  }
  if (p === '/api/memory/consolidate' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryConsolidate(req, res); return true
  }
  if (p === '/api/memory/consolidate/status' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryConsolidateStatus(req, res); return true
  }
  if (p === '/api/memory/distill' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryDistill(req, res); return true
  }
  if (p === '/api/memory/distill/status' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleMemoryDistillStatus(req, res); return true
  }
  return false
}

// ─── v1.5 Memory admin handlers ──────────────────────────────────────

function readUserKey(url: URL): string | null {
  const k = url.searchParams.get('user_key')
  if (!k?.includes(':')) return null
  return k
}

async function handleMemoryUsers(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { listUsers } = await import('../core/memory.js')
    sendJson(res, 200, { users: listUsers() })
  } catch (err) {
    sendError(res, 500, 'MEMORY_USERS_FAILED', { message: err instanceof Error ? err.message : String(err) })
  }
}

async function handleMemoryFacts(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const user_key = readUserKey(url)
    if (!user_key) { sendError(res, 400, 'MEMORY_USER_KEY_REQUIRED', { message: 'user_key required (platform:userId)' }); return }
    const { listFacts } = await import('../core/memory.js')
    const query = url.searchParams.get('query') || ''
    const category = url.searchParams.get('category') || ''
    const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0
    const validCats = new Set(['fact', 'preference', 'goal', 'history', 'profile'])
    const cat = validCats.has(category) ? category as 'fact' | 'preference' | 'goal' | 'history' | 'profile' : undefined
    sendJson(res, 200, listFacts({ user_key, query, category: cat, limit, offset }))
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleMemoryDeleteOne(req: IncomingMessage, res: ServerResponse, url: URL, id: number): Promise<void> {
  try {
    const user_key = readUserKey(url)
    if (!user_key) { sendError(res, 400, 'MEMORY_USER_KEY_REQUIRED', { message: 'user_key required' }); return }
    const { deleteFact } = await import('../core/memory.js')
    const ok = deleteFact(id, user_key)
    sendJson(res, ok ? 200 : 404, { ok, id })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
  void req
}

async function handleMemoryBulkDelete(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const user_key = readUserKey(url)
    if (!user_key) { sendError(res, 400, 'MEMORY_USER_KEY_REQUIRED', { message: 'user_key required' }); return }
    const body = await readBody(req, res)
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : {}
    const { bulkDeleteFacts } = await import('../core/memory.js')
    const idsRaw = parsed.ids
    const ids = Array.isArray(idsRaw) ? idsRaw.filter((n): n is number => typeof n === 'number') : undefined
    const category = typeof parsed.category === 'string' ? parsed.category : undefined
    const max_confidence = typeof parsed.max_confidence === 'number' ? parsed.max_confidence : undefined
    const confirm_clear = parsed.confirm_clear === true
    const validCats = new Set(['fact', 'preference', 'goal', 'history', 'profile'])
    const deleted = bulkDeleteFacts({
      user_key,
      ids: ids && ids.length > 0 ? ids : undefined,
      category: category && validCats.has(category) ? category as 'fact' | 'preference' | 'goal' | 'history' | 'profile' : undefined,
      max_confidence,
      confirm_clear,
    })
    sendJson(res, 200, { deleted })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleMemoryPersona(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const user_key = readUserKey(url)
    if (!user_key) { sendError(res, 400, 'MEMORY_USER_KEY_REQUIRED', { message: 'user_key required' }); return }
    const { getPersona } = await import('../core/memory.js')
    const p = getPersona(user_key)
    if (!p) { sendJson(res, 404, { error: 'no persona for user_key', user_key }); return }
    sendJson(res, 200, p)
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleMemoryPersonaPut(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const user_key = readUserKey(url)
    if (!user_key) { sendError(res, 400, 'MEMORY_USER_KEY_REQUIRED', { message: 'user_key required' }); return }
    const body = await readBody(req, res)
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : {}
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
    if (!summary) { sendJson(res, 400, { error: 'summary required (non-empty string)' }); return }
    const { upsertPersona } = await import('../core/memory.js')
    const ok = upsertPersona(user_key, summary)
    sendJson(res, ok ? 200 : 500, { ok })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleMemoryPersonaDelete(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const user_key = readUserKey(url)
    if (!user_key) { sendError(res, 400, 'MEMORY_USER_KEY_REQUIRED', { message: 'user_key required' }); return }
    const { deletePersona } = await import('../core/memory.js')
    const ok = deletePersona(user_key)
    sendJson(res, ok ? 200 : 404, { ok })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleMemoryExport(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const user_key = readUserKey(url)
    if (!user_key) { sendError(res, 400, 'MEMORY_USER_KEY_REQUIRED', { message: 'user_key required' }); return }
    const { exportUserMemory } = await import('../core/memory.js')
    const data = exportUserMemory(user_key)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="agim-memory-${user_key.replace(/[^a-zA-Z0-9_-]+/g, '_')}.json"`,
    })
    res.end(JSON.stringify(data, null, 2))
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// ─── v1.6 vector backend handlers ────────────────────────────────────

async function handleVectorStatus(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { getActiveBackend } = await import('../core/memory-vector.js')
    const { getVectorCoverage } = await import('../core/memory.js')
    const backend = getActiveBackend()
    const userKeyParam = url.searchParams.get('user_key') || undefined
    const coverage = getVectorCoverage(userKeyParam)
    sendJson(res, 200, {
      status: backend.describe(),
      coverage,
      // Backfill / download jobs share an in-memory map for progress polling.
      jobs: pickPublicJobs(),
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleVectorTest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { testActiveBackend } = await import('../core/memory-vector.js')
    const r = await testActiveBackend()
    sendJson(res, r.ok ? 200 : 400, r)
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// In-memory async job tracker for download + backfill. Polling-driven UI
// reads these via /api/memory/vector/status. Single in-flight per kind.
interface VectorJob {
  id: string
  kind: 'download' | 'backfill'
  startedAt: number
  finishedAt: number | null
  phase: 'running' | 'done' | 'failed'
  message: string
  details: Record<string, unknown>
}
const vectorJobs = new Map<string, VectorJob>()
function pickPublicJobs(): VectorJob[] {
  const all = Array.from(vectorJobs.values()).sort((a, b) => b.startedAt - a.startedAt)
  return all.slice(0, 5)
}
function newJob(kind: VectorJob['kind']): VectorJob {
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const j: VectorJob = {
    id, kind, startedAt: Date.now(), finishedAt: null,
    phase: 'running', message: 'started', details: {},
  }
  vectorJobs.set(id, j)
  // P2 cleanup: bound the map size — keep up to 100 entries, oldest first.
  if (vectorJobs.size > 100) {
    const oldest = Array.from(vectorJobs.values())
      .sort((a, b) => a.startedAt - b.startedAt)[0]
    if (oldest) vectorJobs.delete(oldest.id)
  }
  return j
}
function findRunningJob(kind: VectorJob['kind']): VectorJob | undefined {
  for (const j of vectorJobs.values()) {
    if (j.kind === kind && j.phase === 'running') return j
  }
  return undefined
}
function finishJob(id: string, ok: boolean, message: string, details: Record<string, unknown> = {}): void {
  const j = vectorJobs.get(id)
  if (!j) return
  j.finishedAt = Date.now()
  j.phase = ok ? 'done' : 'failed'
  j.message = message
  j.details = details
}

async function handleVectorDownload(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { triggerLocalDownload, getActiveBackend } = await import('../core/memory-vector.js')
    const b = getActiveBackend()
    if (b.name !== 'local') {
      sendJson(res, 400, { error: `backend is "${b.name}", switch to "local" first` })
      return
    }
    if (b.ready) {
      sendJson(res, 200, { ok: true, alreadyReady: true })
      return
    }
    // P1-10: dedupe concurrent download attempts. Two browser tabs (or a
    // double-click) would otherwise spawn parallel triggerLocalDownload
    // calls that race on the same model cache directory.
    const inflight = findRunningJob('download')
    if (inflight) {
      sendJson(res, 202, { ok: true, jobId: inflight.id, alreadyRunning: true })
      return
    }
    const job = newJob('download')
    // Kick off async; respond immediately so the UI doesn't block.
    void (async () => {
      try {
        const r = await triggerLocalDownload()
        if (r.ok) finishJob(job.id, true, 'model ready', { modelId: b.modelId, dims: b.dims })
        else finishJob(job.id, false, r.error || 'unknown error', {})
      } catch (err) {
        finishJob(job.id, false, err instanceof Error ? err.message : String(err), {})
      }
    })()
    sendJson(res, 202, { ok: true, jobId: job.id, hint: 'poll /api/memory/vector/status for progress' })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleVectorBackfill(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { backfillEmbeddings } = await import('../core/memory.js')
    const { getActiveBackend } = await import('../core/memory-vector.js')
    const b = getActiveBackend()
    if (!b.ready) {
      sendJson(res, 400, { error: `vector backend not ready (${b.name})` })
      return
    }
    const user_key = url.searchParams.get('user_key') || undefined
    const body = await readBody(req, res).catch(() => '')
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : {}
    const maxRows = typeof parsed.max_rows === 'number' ? parsed.max_rows : undefined

    // P1-10: dedupe concurrent backfill — backfill is idempotent at the
    // UPDATE layer, but running two passes wastes inference budget +
    // makes the progress display jump around.
    const inflight = findRunningJob('backfill')
    if (inflight) {
      sendJson(res, 202, { ok: true, jobId: inflight.id, alreadyRunning: true })
      return
    }
    const job = newJob('backfill')
    void (async () => {
      try {
        const r = await backfillEmbeddings({ user_key, maxRows })
        finishJob(job.id, !r.errored, r.errored || `${r.succeeded}/${r.processed} ok (failed ${r.failed})`, r)
      } catch (err) {
        finishJob(job.id, false, err instanceof Error ? err.message : String(err), {})
      }
    })()
    sendJson(res, 202, { ok: true, jobId: job.id, hint: 'poll /api/memory/vector/status for progress' })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleVectorClear(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { clearEmbeddings } = await import('../core/memory.js')
    const user_key = url.searchParams.get('user_key') || undefined
    const cleared = clearEmbeddings(user_key)
    sendJson(res, 200, { ok: true, cleared })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// v1.2.2 — async consolidate. Per-user LLM call can take 30-60s; a
// long-held POST routinely hits intermediary timeouts (cloudflare, nginx,
// browser fetch defaults). Same pattern as vector download/backfill:
// register a job + return 202 immediately; client polls /status for state.
type ConsolidateJob = {
  id: string
  startedAt: number
  finishedAt: number | null
  phase: 'running' | 'done' | 'failed'
  result: { users?: number; updated?: number; error?: string }
}
const consolidateJobs = new Map<string, ConsolidateJob>()
function pickRecentConsolidate(): ConsolidateJob[] {
  return Array.from(consolidateJobs.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 5)
}

async function handleMemoryConsolidate(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Dedupe: if a consolidate is already running, return that jobId.
    for (const j of consolidateJobs.values()) {
      if (j.phase === 'running') {
        sendJson(res, 202, { ok: true, jobId: j.id, alreadyRunning: true })
        return
      }
    }
    const id = `consolidate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const job: ConsolidateJob = { id, startedAt: Date.now(), finishedAt: null, phase: 'running', result: {} }
    consolidateJobs.set(id, job)
    if (consolidateJobs.size > 50) {
      const oldest = Array.from(consolidateJobs.values()).sort((a, b) => a.startedAt - b.startedAt)[0]
      if (oldest) consolidateJobs.delete(oldest.id)
    }
    void (async () => {
      try {
        const { runConsolidationOnce } = await import('../core/memory-consolidate.js')
        const r = await runConsolidationOnce()
        job.finishedAt = Date.now()
        job.phase = 'done'
        job.result = r
      } catch (err) {
        job.finishedAt = Date.now()
        job.phase = 'failed'
        job.result = { error: err instanceof Error ? err.message : String(err) }
      }
    })()
    sendJson(res, 202, { ok: true, jobId: id, hint: 'poll /api/memory/consolidate/status for progress' })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleMemoryConsolidateStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { jobs: pickRecentConsolidate() })
}

// P2 — dream distillation: trigger a pass now (fire-and-forget; status reflects
// progress) and report the buffer/last-run status for the Memory tab.
async function handleMemoryDistill(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { runDistillerOnce } = await import('../core/memory-distiller.js')
    // force: a manual "Run now" must flush the whole buffer even while the bot
    // is busy — the idle gate only governs the periodic background tick.
    void runDistillerOnce({ force: true }).catch(() => { /* status carries the error */ })
    sendJson(res, 202, { ok: true, hint: 'poll /api/memory/distill/status for progress' })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleMemoryDistillStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { getDistillerStatus } = await import('../core/memory-distiller.js')
    sendJson(res, 200, getDistillerStatus())
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
