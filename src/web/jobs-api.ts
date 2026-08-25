// jobs-api — web REST surface for job-board, schedules, reminders,
// bgjobs, subtasks, plans, and batch job operations.
//
// Endpoints exposed:
//
//   GET    /api/jobs                        → { jobs, stats }
//   GET    /api/jobs/:id                    → { job }
//   POST   /api/jobs/:id/cancel             → { ok }
//   POST   /api/jobs/:id/run               → { ok, traceId }
//   POST   /api/jobs                        → { ok, id }
//   POST   /api/jobs/batch-cancel           → { results }
//   POST   /api/jobs/batch-run             → { results }
//   GET    /api/bgjobs                      → { roots, groups }
//   GET    /api/bgjobs/:id                  → { job }
//   GET    /api/subtasks                    → { subtasks }
//   GET    /api/schedules                   → { schedules }
//   GET    /api/reminders                   → { reminders }
//   POST   /api/reminders/:id/cancel        → { ok, id }
//   POST   /api/reminders/:id/snooze        → { ok, originalId, newId, duration }
//   GET    /api/plans                       → { plans, total }
//
// List/read/cancel of a member's own rows is allowed. Creating arbitrary jobs
// and batch ops stay admin. GET /api/jobs/:id also allows a role=user token
// when `?threadId=` matches the job's web thread (Subagent detail sheet).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { registry } from '../core/registry.js'
import { generateTraceId, createLogger } from '../core/logger.js'
import { sendJson, readBody, sendError } from './http-utils.js'
import {
  requireAdmin,
  isRequestAdmin,
  extractToken,
  verifyTokenSync,
} from './auth.js'
import {
  emptyMemberScope,
  jobVisibleToScope,
  resolveMemberScope,
  sendForbidden,
} from './member-scope.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served (caller should stop walking its own route table); `false`
 * when the URL/method didn't match anything in this module.
 */
export async function handleJobsApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  // ─── /api/jobs ──────────────────────────────────────────────────

  if (p === '/api/jobs' && m === 'GET') {
    await handleListJobs(req, res, url); return true
  }

  // batch-cancel/batch-run before the generic /:id match (pattern-safe but explicit)
  if (p === '/api/jobs/batch-cancel' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleBatchJob(req, res, 'cancel'); return true
  }
  if (p === '/api/jobs/batch-run' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleBatchJob(req, res, 'run'); return true
  }

  const jobIdMatch = p.match(/^\/api\/jobs\/(\d+)$/)
  if (jobIdMatch && m === 'GET') {
    // Admin: full read. Chat/Portal (role=user): single-job read when the
    // job belongs to their web thread (Subagent detail sheet).
    await handleGetJob(req, res, url, parseInt(jobIdMatch[1], 10)); return true
  }
  const jobCancelMatch = p.match(/^\/api\/jobs\/(\d+)\/cancel$/)
  if (jobCancelMatch && m === 'POST') {
    await handleCancelJob(req, res, parseInt(jobCancelMatch[1], 10)); return true
  }
  const jobRunMatch = p.match(/^\/api\/jobs\/(\d+)\/run$/)
  if (jobRunMatch && m === 'POST') {
    await handleRunJob(req, res, parseInt(jobRunMatch[1], 10)); return true
  }
  if (p === '/api/jobs' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleCreateJob(req, res); return true
  }

  // ─── /api/bgjobs ────────────────────────────────────────────────

  if (p === '/api/bgjobs' && m === 'GET') {
    await handleListBgjobs(req, res, url); return true
  }
  const bgjobIdMatch = p.match(/^\/api\/bgjobs\/([\w.-]+)$/)
  if (bgjobIdMatch && m === 'GET') {
    await handleGetBgjob(req, res, bgjobIdMatch[1], url); return true
  }

  // ─── /api/subtasks ──────────────────────────────────────────────

  if (p === '/api/subtasks' && m === 'GET') {
    await handleListSubtasks(req, res, url); return true
  }

  // ─── /api/schedules ─────────────────────────────────────────────

  if (p === '/api/schedules' && m === 'GET') {
    await handleListSchedules(req, res, url); return true
  }

  // ─── /api/reminders ─────────────────────────────────────────────

  if (p === '/api/reminders' && m === 'GET') {
    await handleListReminders(req, res, url); return true
  }
  const reminderCancelMatch = p.match(/^\/api\/reminders\/(\d+)\/cancel$/)
  if (reminderCancelMatch && m === 'POST') {
    await handleCancelReminderApi(req, res, Number.parseInt(reminderCancelMatch[1], 10)); return true
  }
  const reminderSnoozeMatch = p.match(/^\/api\/reminders\/(\d+)\/snooze$/)
  if (reminderSnoozeMatch && m === 'POST') {
    await handleSnoozeReminderApi(req, res, Number.parseInt(reminderSnoozeMatch[1], 10)); return true
  }

  // ─── /api/plans ─────────────────────────────────────────────────

  if (p === '/api/plans' && m === 'GET') {
    await handlePlansList(req, res, url); return true
  }

  return false
}

// ─── handlers ───────────────────────────────────────────────────────

async function handleListJobs(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const jb = await import('../core/job-board.js')
    type JobStatus = import('../core/job-board.js').JobStatus
    type JobKind = import('../core/job-board.js').JobKind
    const scope = await resolveMemberScope(req)
    if (emptyMemberScope(scope)) {
      sendJson(res, 200, { jobs: [], stats: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 } })
      return
    }
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500)
    const validStatuses = new Set<JobStatus>([
      'pending', 'running', 'completed', 'delivered', 'failed',
      'cancelled', 'interrupted', 'replaced', 'abandoned',
    ])
    const statusRaw = url.searchParams.get('status') || ''
    const status = validStatuses.has(statusRaw as JobStatus) ? (statusRaw as JobStatus) : undefined
    const agent = url.searchParams.get('agent') || undefined
    const kindRaw = url.searchParams.get('kind') || ''
    const kind: JobKind | undefined = (kindRaw === 'inline' || kindRaw === 'job') ? kindRaw : undefined
    const opts: { agent?: string; kind?: JobKind; creatorId?: string; threadKeys?: string[] } = {}
    if (agent) opts.agent = agent
    if (kind) opts.kind = kind
    if (scope.kind === 'user') {
      opts.creatorId = scope.userId
      opts.threadKeys = scope.threadKeys
    }
    const jobs = jb.listJobs(limit, status, opts)
    const stats = jb.getJobStats(scope.kind === 'user' ? { creatorId: scope.userId, threadKeys: scope.threadKeys } : {})
    sendJson(res, 200, { jobs, stats })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

const WEB_THREAD_ID_RE = /^web-[A-Za-z0-9_-]{4,64}$/

/** Non-admin may read one job when it is scoped to their owned web thread. */
async function canReadJobAsChatUser(
  req: IncomingMessage,
  url: URL,
  job: { thread_key?: string | null },
): Promise<boolean> {
  const threadId = (url.searchParams.get('threadId') || '').trim()
  if (!threadId || !WEB_THREAD_ID_RE.test(threadId)) return false
  const expectedKey = `web:web:${threadId}`
  if ((job.thread_key || '') !== expectedKey) return false
  const tok = extractToken(req, url)
  const tokenId = tok ? verifyTokenSync(tok) : null
  if (!tokenId) return false
  const { webThreadOwners } = await import('../core/web-thread-owners.js')
  const owner = webThreadOwners.get(threadId)
  // Mirror chat-media: unknown owner (fresh claim / race) allows; mismatch denies.
  if (owner !== undefined && owner !== tokenId) return false
  return true
}

async function handleGetJob(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  id: number,
): Promise<void> {
  try {
    const { getJob } = await import('../core/job-board.js')
    const job = getJob(id)
    if (!job) { sendJson(res, 404, { error: 'Job not found' }); return }
    if (!isRequestAdmin(req)) {
      const scope = await resolveMemberScope(req)
      const owned = jobVisibleToScope(job, scope) || (await canReadJobAsChatUser(req, url, job))
      if (!owned) {
        sendForbidden(res)
        return
      }
    }
    sendJson(res, 200, { job })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function assertJobOwned(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
): Promise<import('../core/job-board.js').Job | null> {
  const { getJob } = await import('../core/job-board.js')
  const job = getJob(id)
  if (!job) {
    sendJson(res, 404, { error: 'Job not found' })
    return null
  }
  if (isRequestAdmin(req)) return job
  const scope = await resolveMemberScope(req)
  if (!jobVisibleToScope(job, scope)) {
    sendForbidden(res)
    return null
  }
  return job
}

async function handleCancelJob(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  try {
    const job = await assertJobOwned(req, res, id)
    if (!job) return
    const { cancelJob } = await import('../core/job-board.js')
    sendJson(res, 200, { ok: cancelJob(id) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleRunJob(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  try {
    const owned = await assertJobOwned(req, res, id)
    if (!owned) return
    const { runJob } = await import('../core/job-board.js')
    const { AgentBase } = await import('../core/agent-base.js')
    const job = owned
    const agent = registry.findAgent(job.agent)
    if (!agent) { sendJson(res, 404, { error: `Agent "${job.agent}" not registered` }); return }

    const traceId = generateTraceId()
    const log = createLogger({ traceId, platform: 'web', component: 'job-run' })
    // Fire and forget — UI polls /api/jobs/:id for status.
    void runJob(id, async function* (j, _logger, signal) {
      const outcomes: Array<{ status: string; error?: string }> = []
      if (agent instanceof AgentBase) {
        const text = await agent.spawnAndCollect(j.prompt, signal, {
          onOutcome: (value) => { outcomes.push(value) },
        })
        if (text) yield text
      } else {
        for await (const chunk of agent.sendPrompt(`web-job-${j.id}`, j.prompt, [], {
          signal,
          onOutcome: (value) => { outcomes.push(value) },
        })) {
          if (signal.aborted) break
          yield chunk
        }
      }
      const outcome = outcomes.at(-1)
      if (outcome && outcome.status !== 'success' && outcome.status !== 'partial') {
        throw new Error(outcome.error ?? outcome.status)
      }
    }, log).catch(() => { /* job-board logs */ })

    sendJson(res, 200, { ok: true, traceId })
  } catch (err) {
    sendError(res, 500, 'JOB_RUN_FAILED', { message: err instanceof Error ? err.message : String(err) })
  }
}

async function handleCreateJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const { agent, prompt } = JSON.parse(body) as { agent?: string; prompt?: string }
    if (!agent || !prompt) {
      sendError(res, 400, 'VALIDATION', { message: 'Missing agent / prompt' })
      return
    }
    if (!registry.findAgent(agent)) {
      sendError(res, 404, 'NOT_FOUND', { message: `Agent "${agent}" not registered`, detail: agent })
      return
    }
    const { createJob } = await import('../core/job-board.js')
    const id = createJob(agent, prompt)
    sendJson(res, 200, { ok: true, id })
  } catch (err) {
    const e = err as Error & { handled?: boolean; statusCode?: number }
    if (e?.handled) return
    if (!res.headersSent) {
      sendError(res, e?.statusCode || 500, 'JOB_CREATE_FAILED', {
        message: e instanceof Error ? e.message : String(err),
      })
    }
  }
}

async function handleListSchedules(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const scope = await resolveMemberScope(req)
    if (emptyMemberScope(scope)) { sendJson(res, 200, { schedules: [] }); return }
    const { listSchedules } = await import('../core/schedule.js')
    const agent = url.searchParams.get('agent') || undefined
    const rows = listSchedules(50, agent ? { agent } : {})
    const schedules = scope.kind === 'admin'
      ? rows
      : rows.filter((s) => (s.creator_id || '') === scope.userId)
    sendJson(res, 200, { schedules })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * GET /api/reminders?status=pending&limit=100
 * Returns a flat list of reminders. status filter is optional; without it
 * we only return pending — that's the 99% UI use-case (the page is a
 * "what's queued up" view, not an audit log).
 */
async function handleListReminders(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const scope = await resolveMemberScope(req)
    if (emptyMemberScope(scope)) { sendJson(res, 200, { reminders: [] }); return }
    const { listReminders, describeRecurrence } = await import('../core/reminders.js')
    const status = url.searchParams.get('status') as
      | 'pending' | 'firing' | 'fired' | 'cancelled' | 'failed' | null
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500)
    const rows = listReminders({ status: status ?? 'pending', limit })
    const visible = scope.kind === 'admin'
      ? rows
      : rows.filter((r) => (r.user_id || '') === scope.userId || scope.threadIds.includes(r.thread_id || ''))
    const annotated = visible.map((r) => ({
      ...r,
      recurrence_label: r.recurrence ? describeRecurrence(r.recurrence) : null,
    }))
    sendJson(res, 200, { reminders: annotated })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function reminderOwned(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
): Promise<boolean> {
  if (isRequestAdmin(req)) return true
  const { getReminder } = await import('../core/reminders.js')
  const row = getReminder(id)
  if (!row) { sendJson(res, 404, { error: 'not found or not cancellable' }); return false }
  const scope = await resolveMemberScope(req)
  if (scope.kind !== 'user') { sendForbidden(res); return false }
  if ((row.user_id || '') === scope.userId || scope.threadIds.includes(row.thread_id || '')) return true
  sendForbidden(res)
  return false
}

async function handleCancelReminderApi(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) { sendJson(res, 400, { error: 'invalid id' }); return }
  try {
    if (!(await reminderOwned(req, res, id))) return
    const { cancelReminder } = await import('../core/reminders.js')
    const ok = cancelReminder(id)
    if (!ok) { sendJson(res, 404, { error: 'not found or not cancellable' }); return }
    sendJson(res, 200, { ok: true, id })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleSnoozeReminderApi(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) { sendJson(res, 400, { error: 'invalid id' }); return }
  try {
    if (!(await reminderOwned(req, res, id))) return
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { duration?: string }
    const duration = parsed.duration?.trim() || ''
    if (!duration) { sendJson(res, 400, { error: 'duration required (e.g. "5m")' }); return }
    const { snoozeReminder, parseDuration, ReminderError } = await import('../core/reminders.js')
    const ms = parseDuration(duration)
    if (ms === null) { sendJson(res, 400, { error: `bad duration "${duration}"` }); return }
    try {
      const newId = snoozeReminder(id, ms)
      sendJson(res, 200, { ok: true, originalId: id, newId, duration })
    } catch (err) {
      if (err instanceof ReminderError) { sendJson(res, 400, { error: err.message }); return }
      throw err
    }
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handlePlansList(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const scope = await resolveMemberScope(req)
    if (emptyMemberScope(scope)) { sendJson(res, 200, { plans: [], total: 0 }); return }
    const { listPlanHistory } = await import('../core/plan-history.js')
    const threadKey = url.searchParams.get('thread_key') || undefined
    if (scope.kind === 'user' && threadKey && !scope.threadKeys.includes(threadKey)) {
      sendJson(res, 200, { plans: [], total: 0 })
      return
    }
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(parseInt(limitRaw, 10) || 50, 500)) : 50
    const rows = listPlanHistory({ threadKey, limit })
    const plans = scope.kind === 'admin'
      ? rows
      : rows.filter((r) => scope.threadKeys.includes(r.threadKey || ''))
    sendJson(res, 200, { plans, total: plans.length })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleListBgjobs(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const scope = await resolveMemberScope(req)
    if (emptyMemberScope(scope)) {
      sendJson(res, 200, { roots: [], groups: [] })
      return
    }
    const { resolveRoots, listJobsForRoot, listAllJobs } = await import('../core/bgjob-reader.js')
    const rootId = url.searchParams.get('root')
    const statusFilter = (url.searchParams.get('status') || '').trim().toLowerCase()
    const threadId = (url.searchParams.get('threadId') || '').trim()
    const platform = (url.searchParams.get('platform') || '').trim()
    const filterJobs = <T extends { status: string; origin?: { platform: string; threadId: string; userId?: string } | null }>(
      jobs: T[],
    ): T[] => {
      let out = jobs
      if (statusFilter) {
        const want = new Set(statusFilter.split(',').map((s) => s.trim()).filter(Boolean))
        out = out.filter((j) => want.has(j.status.toLowerCase()))
      }
      if (threadId) {
        out = out.filter((j) => j.origin?.threadId === threadId
          && (!platform || j.origin?.platform === platform))
      }
      if (scope.kind === 'user') {
        out = out.filter((j) => {
          const origin = j.origin
          if (!origin) return false
          if (origin.userId && origin.userId === scope.userId) return true
          return origin.platform === 'web' && scope.threadIds.includes(origin.threadId)
        })
      }
      return out
    }
    if (rootId) {
      // Single-root view — used by the dashboard's root selector.
      const root = resolveRoots().find((r) => r.id === rootId)
      if (!root) { sendJson(res, 404, { error: `bgjob root "${rootId}" not configured` }); return }
      const jobs = filterJobs(await listJobsForRoot(root))
      sendJson(res, 200, { roots: [{ id: root.id, label: root.label, path: root.path }], jobs })
      return
    }
    // No root specified: return all roots' metadata + jobs grouped by root.
    const all = await listAllJobs()
    sendJson(res, 200, {
      roots: all.map(({ root }) => ({ id: root.id, label: root.label, path: root.path })),
      groups: all.map(({ root, jobs }) => ({ rootId: root.id, jobs: filterJobs(jobs) })),
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleGetBgjob(req: IncomingMessage, res: ServerResponse, id: string, url: URL): Promise<void> {
  try {
    const scope = await resolveMemberScope(req)
    if (emptyMemberScope(scope)) { sendJson(res, 404, { error: 'Job not found' }); return }
    const { findRoot, getJobDetail, resolveRoots, listJobsForRoot } = await import('../core/bgjob-reader.js')
    const tail = Math.min(Math.max(parseInt(url.searchParams.get('tail') || '200', 10) || 200, 1), 5000)
    const rootId = url.searchParams.get('root')
    const allow = (job: { origin?: { platform: string; threadId: string; userId?: string } | null }): boolean => {
      if (scope.kind === 'admin') return true
      if (scope.kind !== 'user') return false
      const origin = job.origin
      if (!origin) return false
      if (origin.userId && origin.userId === scope.userId) return true
      return origin.platform === 'web' && scope.threadIds.includes(origin.threadId)
    }
    if (rootId) {
      const root = findRoot(rootId)
      if (!root) { sendJson(res, 404, { error: `bgjob root "${rootId}" not configured` }); return }
      const job = await getJobDetail(root, id, tail)
      if (!job || !allow(job)) { sendJson(res, 404, { error: 'Job not found' }); return }
      sendJson(res, 200, { job })
      return
    }
    // No root: try every configured root, return first hit.
    for (const root of resolveRoots()) {
      const summaries = await listJobsForRoot(root)
      if (!summaries.some((s) => s.id === id)) continue
      const job = await getJobDetail(root, id, tail)
      if (job && allow(job)) { sendJson(res, 200, { job }); return }
    }
    sendJson(res, 404, { error: 'Job not found' })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleListSubtasks(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const scope = await resolveMemberScope(req)
    if (emptyMemberScope(scope)) { sendJson(res, 200, { subtasks: [] }); return }
    const { sessionManager } = await import('../core/session.js')
    const agent = url.searchParams.get('agent') || undefined
    const subtasks = await sessionManager.listAllSubtasks(agent ? { agent } : {})
    const visible = scope.kind === 'admin'
      ? subtasks
      : subtasks.filter((s) => s.platform === 'web' && scope.threadIds.includes(s.threadId))
    sendJson(res, 200, { subtasks: visible })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleBatchJob(
  req: IncomingMessage,
  res: ServerResponse,
  action: 'cancel' | 'run',
): Promise<void> {
  try {
    const body = await readBody(req, res)
    let parsed: { ids?: unknown }
    try { parsed = JSON.parse(body) as typeof parsed } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    if (!Array.isArray(parsed.ids) || parsed.ids.length === 0) {
      sendJson(res, 400, { error: 'ids must be a non-empty array of numbers' })
      return
    }
    // Cap so a runaway client can't queue thousands of spawns at once. Same
    // ceiling we use elsewhere for batched ops.
    if (parsed.ids.length > 100) {
      sendJson(res, 400, { error: 'Maximum 100 ids per batch' })
      return
    }
    const ids = parsed.ids
      .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (ids.length === 0) {
      sendJson(res, 400, { error: 'No valid ids in array' })
      return
    }

    const { getJob, cancelJob, runJob } = await import('../core/job-board.js')
    const { AgentBase } = await import('../core/agent-base.js')

    const results = await Promise.all(ids.map(async (id) => {
      try {
        if (action === 'cancel') {
          return { id, ok: cancelJob(id) }
        }
        const job = getJob(id)
        if (!job) return { id, ok: false, error: 'Job not found' }
        const agent = registry.findAgent(job.agent)
        if (!agent) return { id, ok: false, error: `Agent "${job.agent}" not registered` }

        const traceId = generateTraceId()
        const log = createLogger({ traceId, platform: 'web', component: 'job-run-batch' })
        // Same fire-and-forget pattern as handleRunJob — the dashboard
        // streams status from /events / /api/jobs.
        void runJob(id, async function* (j, _logger, signal) {
          const outcomes: Array<{ status: string; error?: string }> = []
          if (agent instanceof AgentBase) {
            const text = await agent.spawnAndCollect(j.prompt, signal, {
              onOutcome: (value) => { outcomes.push(value) },
            })
            if (text) yield text
          } else {
            for await (const chunk of agent.sendPrompt(`web-job-${j.id}`, j.prompt, [], {
              signal,
              onOutcome: (value) => { outcomes.push(value) },
            })) {
              if (signal.aborted) break
              yield chunk
            }
          }
          const outcome = outcomes.at(-1)
          if (outcome && outcome.status !== 'success' && outcome.status !== 'partial') {
            throw new Error(outcome.error ?? outcome.status)
          }
        }, log).catch(() => { /* job-board logs */ })
        return { id, ok: true, traceId }
      } catch (err) {
        return { id, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }))

    sendJson(res, 200, { results })
  } catch (err) {
    const e = err as Error & { handled?: boolean; statusCode?: number }
    if (e?.handled) return
    if (!res.headersSent) sendJson(res, e?.statusCode || 500, { error: e instanceof Error ? e.message : String(err) })
  }
}
