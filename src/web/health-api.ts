// health-api — Metrics, audit, health snapshots, SSE stream, and mobile QR.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET  /api/health          → agent availability + uptime  — public (k8s probe)
//   GET  /api/metrics         → Prometheus / JSON metrics    — admin only
//   GET  /api/audit           → invocation log               — admin only
//   GET  /api/audit/events    → governance audit events      — admin only
//   GET  /api/health/summary  → daily cost + KPI totals      — admin only
//   GET  /api/health/topn     → top-N ranked groups          — admin only
//   GET  /api/agent-health    → per-agent circuit/rate/perf  — admin only
//   GET  /events              → SSE real-time event stream   — admin only
//   POST /api/mobile/qr       → generate mobile QR token     — admin only

import type { IncomingMessage, ServerResponse } from 'node:http'
import { registry } from '../core/registry.js'
import { readBody, sendJson, sendError } from './http-utils.js'
import { requireAdmin, _tokenModule } from './auth.js'
import { getAgentStatuses } from './config-api.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleHealthApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/health' && m === 'GET') {
    await handleHealth(req, res); return true
  }
  if (p === '/api/metrics' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleMetrics(req, res, url); return true
  }
  if (p === '/api/audit' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleAudit(req, res, url); return true
  }
  if (p === '/api/audit/events' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleAuditEvents(req, res, url); return true
  }
  if (p === '/api/health/summary' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleHealthSummary(req, res, url); return true
  }
  if (p === '/api/health/topn' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleHealthTopN(req, res, url); return true
  }
  if (p === '/api/agent-health' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleAgentHealth(req, res); return true
  }
  if (p === '/events' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleEventsSSE(req, res); return true
  }
  if (p === '/api/mobile/qr' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleMobileQR(req, res); return true
  }
  return false
}

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const status = await getAgentStatuses()
    const anyHealthy = Object.values(status).some(Boolean)
    sendJson(res, anyHealthy ? 200 : 503, {
      ok: anyHealthy,
      agents: status,
      uptimeSec: Math.round(process.uptime()),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { ok: false, error: msg })
  }
}

async function handleMetrics(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const fmt = url.searchParams.get('format') || 'prom'
    const { snapshot, toPrometheus } = await import('../core/metrics.js')
    if (fmt === 'json') {
      sendJson(res, 200, snapshot())
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
    res.end(toPrometheus())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
  }
}

async function handleAudit(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { queryInvocations, getStats } = await import('../core/audit-log.js')
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 1000)
    const days = parseInt(url.searchParams.get('days') || '7', 10) || 7
    const agent = url.searchParams.get('agent') || undefined
    const platform = url.searchParams.get('platform') || undefined
    const userId = url.searchParams.get('user') || undefined
    const intent = url.searchParams.get('intent') || undefined
    const rows = queryInvocations({ limit, days, agent, platform, userId, intent })
    const stats = getStats()
    sendJson(res, 200, { invocations: rows, stats })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleAuditEvents(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { queryAuditEvents } = await import('../core/audit-log.js')
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 1000)
    const days = parseInt(url.searchParams.get('days') || '30', 10) || 30
    const actor = url.searchParams.get('actor') || undefined
    const typesParam = url.searchParams.get('types')
    const KNOWN_TYPES = [
      'approval.allow', 'approval.deny',
      'admin.elevate', 'admin.revoke',
      'config.put', 'env.put',
      'token.create', 'token.revoke',
      'workspace.add', 'workspace.delete',
    ] as const
    type T = (typeof KNOWN_TYPES)[number]
    const types: T[] | undefined = typesParam
      ? typesParam.split(',').map((s) => s.trim()).filter((s): s is T => (KNOWN_TYPES as readonly string[]).includes(s))
      : undefined
    const events = queryAuditEvents({ limit, days, actor, types })
    sendJson(res, 200, { events })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleHealthSummary(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 365)
    const { getHealthSummary } = await import('../core/audit-log.js')
    sendJson(res, 200, getHealthSummary(days))
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleHealthTopN(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const dimRaw = (url.searchParams.get('dim') || 'user').toLowerCase()
    const metricRaw = (url.searchParams.get('by') || 'cost').toLowerCase()
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 365)
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 100)
    const validDims = new Set(['user', 'agent', 'platform', 'intent'])
    const validMetrics = new Set(['cost', 'calls', 'errors', 'avg_latency'])
    if (!validDims.has(dimRaw)) {
      sendJson(res, 400, { error: `dim must be one of ${[...validDims].join(',')}` })
      return
    }
    if (!validMetrics.has(metricRaw)) {
      sendJson(res, 400, { error: `by must be one of ${[...validMetrics].join(',')}` })
      return
    }
    const { getTopN } = await import('../core/audit-log.js')
    const items = getTopN(dimRaw as 'user' | 'agent' | 'platform' | 'intent',
                         metricRaw as 'cost' | 'calls' | 'errors' | 'avg_latency',
                         days, limit)
    sendJson(res, 200, { dim: dimRaw, by: metricRaw, days, items })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleAgentHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { circuitBreaker } = await import('../core/circuit-breaker.js')
    const { agentLimiter } = await import('../core/rate-limiter.js')
    const { snapshot } = await import('../core/metrics.js')
    const snap = snapshot()
    const now = Date.now()
    const agents = registry.listAgents().map((name) => {
      const breaker = circuitBreaker.getStatus(name)
      const cooldownRemainingMs = breaker.openedAt && breaker.phase !== 'closed'
        ? Math.max(0, breaker.cooldownMs - (now - breaker.openedAt))
        : 0
      const rate = agentLimiter.status(name)
      const m = snap.agents.find((a) => a.agent === name)
      return {
        agent: name,
        breaker: {
          phase: breaker.phase,
          failures: breaker.failures,
          cooldownMs: breaker.cooldownMs,
          cooldownRemainingMs,
        },
        rate: {
          remaining: rate.remaining,
          rate: rate.rate,
          intervalSec: rate.intervalSec,
        },
        invocations: m
          ? {
              total: m.total,
              success: m.success,
              failure: m.failure,
              successRate: m.successRate,
              costSum: m.costSum,
              sampleCount: m.sampleCount,
              p50Ms: m.p50Ms,
              p95Ms: m.p95Ms,
              p99Ms: m.p99Ms,
            }
          : null,
      }
    })
    sendJson(res, 200, { agents, uptimeSec: snap.uptimeSec })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleEventsSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { eventBus } = await import('../core/event-bus.js')
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`)

  for (const e of eventBus.getRecent()) {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  }

  const onEvent = (e: import('../core/event-bus.js').AgimEvent): void => {
    try {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    } catch {
      // Likely socket closed; 'close' handler below will clean up.
    }
  }
  eventBus.on('event', onEvent)

  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch { /* socket closed */ }
  }, 25_000)
  if (typeof heartbeat === 'object' && heartbeat && 'unref' in heartbeat) {
    (heartbeat as { unref: () => void }).unref()
  }

  const cleanup = (): void => {
    clearInterval(heartbeat)
    eventBus.off('event', onEvent)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
}

async function handleMobileQR(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = (() => {
      try { return JSON.parse(body || '{}') as { host?: string; baseUrl?: string } }
      catch { return {} as { host?: string; baseUrl?: string } }
    })()
    const isHttps = (req.socket as { encrypted?: boolean }).encrypted === true
      || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
    const scheme = isHttps ? 'https' : 'http'
    let base = (parsed.baseUrl || '').trim().replace(/\/+$/, '')
    if (!base) {
      const host = (parsed.host || req.headers.host || 'localhost').toString()
      base = `${scheme}://${host}`
    }
    const now = new Date()
    const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`
    if (!_tokenModule) {
      sendError(res, 503, 'AUTH_NOT_READY', { message: 'auth module not ready' })
      return
    }
    const { createToken } = _tokenModule
    const created = createToken(`mobile-via-qr-${stamp}`, {
      role: 'user',
      actor: 'mobile-qr',
    })
    // CR P2c — QR carries a short-TTL one-shot exchange code, not the raw token.
    const { issueMobileQrExchange } = await import('../core/mobile-qr-exchange.js')
    const { code, expiresAt } = issueMobileQrExchange(created.raw, created.id)
    const loginUrl = `${base}/m/login?c=${encodeURIComponent(code)}&next=%2Fm%2Fchat`
    const QRCode = (await import('qrcode')).default
    const qrDataUrl = await QRCode.toDataURL(loginUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
    })
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify({
      ok: true,
      tokenId: created.id,
      label: `mobile-via-qr-${stamp}`,
      loginUrl,
      qrDataUrl,
      exchangeExpiresAt: expiresAt,
      revokeHint: '/settings/security/tokens',
    }))
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
