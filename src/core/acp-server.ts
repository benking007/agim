// ACP Server — expose agim as an ACP-compatible Agent
//
// Endpoints (per ACP convention):
//   GET  /agent/card   → Agent Manifest
//   POST /tasks         → Create task (sync or stream via SSE)
//   GET  /tasks/{id}    → Get task status
//
// Runs on a separate port (default 9090). Reuses Web admin token auth.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { parseMessage, routeMessage, type RouteContext } from './router.js'
import { generateTraceId, createLogger, logger as rootLogger } from './logger.js'
import { registry } from './registry.js'
import { getDefaultAgent } from './live-config.js'
import { createJob, getJob, runJob } from './job-board.js'

const DEFAULT_ACP_PORT = 9090
/** Max POST body size (per ACP request). Larger requests get 413. */
const MAX_BODY_BYTES = 1 * 1024 * 1024  // 1 MiB

async function parseAuth(req: IncomingMessage): Promise<{ ok: boolean; status?: number; error?: string }> {
  if ((process.env.IMHUB_WEB_AUTH || '').toLowerCase() === 'off') {
    return { ok: true }
  }
  const auth = String(req.headers.authorization || '')
  if (!auth.startsWith('Bearer ')) return { ok: false, status: 401, error: 'Unauthorized' }
  const raw = auth.slice(7).trim()
  if (!raw) return { ok: false, status: 401, error: 'Unauthorized' }
  try {
    const { verifyToken, isAdminTokenId } = await import('./access-token.js')
    const tokenId = verifyToken(raw)
    if (!tokenId) return { ok: false, status: 401, error: 'Unauthorized' }
    if (!isAdminTokenId(tokenId)) return { ok: false, status: 403, error: 'Forbidden: admin token required' }
    return { ok: true }
  } catch {
    return { ok: false, status: 500, error: 'Auth backend unavailable' }
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Read POST body with a hard cap. When the limit is exceeded we write a
 * 413 response, drain (and discard) the remainder of the request, and
 * reject — letting the caller `return` early. We do NOT destroy the
 * socket because that races with the response flush.
 */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      if (aborted) return
      total += c.length
      if (total > MAX_BODY_BYTES) {
        aborted = true
        if (!res.headersSent) {
          sendJson(res, 413, { error: 'Request body too large' })
        }
        const err = new Error('Request body too large') as Error & { statusCode?: number; handled?: boolean }
        err.statusCode = 413
        err.handled = true
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (err) => {
      if (!aborted) reject(err)
    })
  })
}

/**
 * Map of task id → (job id, last cached status) for quick GET /tasks/:id
 * lookups. The actual durable record lives in the Job Board.
 */
const taskIndex = new Map<string, { jobId: number }>()

export async function startACPServer(options: {
  port?: number
  defaultAgent: string
}): Promise<{ close: () => void; port: number }> {
  const port = options.port || DEFAULT_ACP_PORT
  const agents = registry.listAgents()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // CORS for browser-based ACP clients
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const auth = await parseAuth(req)
    if (!auth.ok) {
      sendJson(res, auth.status || 401, { error: auth.error || 'Unauthorized' })
      return
    }

    // GET /agent/card
    if (req.method === 'GET' && url.pathname === '/agent/card') {
      sendJson(res, 200, {
        name: 'im-hub-gateway',
        description: 'IM Hub — Intelligent multi-agent gateway',
        version: '0.3.0',
        protocols: ['acp/v1'],
        capabilities: {
          streaming: true,
          agents: agents.map(a => ({ name: a, id: a })),
        },
        auth: { type: 'bearer' },
      })
      return
    }

    // POST /tasks
    if (req.method === 'POST' && url.pathname === '/tasks') {
      try {
        const body = await readBody(req, res)
        const parsedBody = JSON.parse(body) as { input?: { prompt?: string }; mode?: string; session_id?: string }
        const input = parsedBody.input
        const mode = parsedBody.mode
        const upstreamSessionId = parsedBody.session_id
        if (!input?.prompt) {
          sendJson(res, 400, { error: 'Missing input.prompt' })
          return
        }

        const taskId = randomBytes(8).toString('hex')
        // Inherit upstream trace id when present so distributed tracing
        // links across the boundary.
        const incomingTrace = String(req.headers['x-trace-id'] || '').trim()
        const traceId = incomingTrace || generateTraceId()
        const logger = createLogger({ traceId, platform: 'acp-server', component: 'acp', taskId })

        // Persist in Job Board so the task survives restarts and shares the
        // /job toolset with messenger-originated jobs. If the board is
        // unavailable (SQLite not loadable) we still serve the request —
        // jobId stays 0 and GET /tasks/:id falls back to "task not found".
        let jobId = 0
        try {
          jobId = createJob('acp:gateway', input.prompt)
          taskIndex.set(taskId, { jobId })
        } catch (err) {
          logger.warn({ event: 'acp.job-board.unavailable', err: err instanceof Error ? err.message : String(err) },
            'Job board unavailable — task will not be persisted')
        }

        const routeCtx: RouteContext = {
          // Use the upstream session_id (when supplied) as the thread key
          // so subsequent calls in the same conversation hit the same
          // agim Session and preserve conversation history.
          threadId: upstreamSessionId ? `acp:session:${upstreamSessionId}` : `acp:${taskId}`,
          channelId: 'acp',
          platform: 'acp',
          defaultAgent: getDefaultAgent(options.defaultAgent),
          traceId,
          logger,
          userId: 'acp-caller',
        }

        const parsed = parseMessage(input.prompt)
        const result = await routeMessage(parsed, routeCtx)

        if (mode === 'stream') {
          // SSE streaming response
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Task-Id': taskId,
          })

          let fullText = ''
          try {
            if (typeof result === 'string') {
              res.write(`data: ${JSON.stringify({ output: { content: result } })}\n\n`)
              fullText = result
            } else {
              for await (const chunk of result) {
                fullText += chunk
                res.write(`data: ${JSON.stringify({ output: { content: chunk } })}\n\n`)
              }
            }
            res.write('data: [DONE]\n\n')
            // Run + complete via Job Board so the same job row carries the
            // result. We push the completed text through a synthetic runner
            // that yields it once, lets job-board flip status to completed.
            if (jobId) {
              await runJob(jobId, async function* () { yield fullText }, logger).catch(() => { /* job board flaky */ })
            }
          } finally {
            res.end()
          }
          return
        }

        // Sync mode
        let fullResponse = ''
        if (typeof result === 'string') {
          fullResponse = result
        } else {
          for await (const chunk of result) {
            fullResponse += chunk
          }
        }
        if (jobId) {
          await runJob(jobId, async function* () { yield fullResponse }, logger).catch(() => { /* job board flaky */ })
        }
        sendJson(res, 200, {
          id: taskId,
          status: 'completed',
          output: { content: fullResponse },
        })
      } catch (err) {
        const e = err as Error & { statusCode?: number; handled?: boolean }
        if (e?.handled) return  // 413 already sent by readBody
        const status = e?.statusCode || 500
        const msg = e instanceof Error ? e.message : String(err)
        if (!res.headersSent) sendJson(res, status, { error: msg })
      }
      return
    }

    // GET /tasks/:id
    const taskMatch = url.pathname.match(/^\/tasks\/([a-z0-9]+)$/)
    if (req.method === 'GET' && taskMatch) {
      const idx = taskIndex.get(taskMatch[1])
      if (!idx) { sendJson(res, 404, { error: 'Task not found' }); return }
      const job = getJob(idx.jobId)
      if (!job) { sendJson(res, 404, { error: 'Task record not found' }); return }
      sendJson(res, 200, {
        id: taskMatch[1],
        status: job.status,
        output: job.result ? { content: job.result } : undefined,
        error: job.error || undefined,
      })
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  })

  // R13 A2 — bind defaults to 127.0.0.1 (loopback only). Operators
  // who run A2A across hosts can opt-in with IMHUB_ACP_BIND=<addr>.
  // We warn loudly when non-loopback so the deployment audit log
  // captures the elevation; the Web admin token gate (parseAuth)
  // remains the only client-facing protection regardless.
  const bind = (process.env.IMHUB_ACP_BIND || '127.0.0.1').trim()
  const isLoopback = bind === '127.0.0.1' || bind === '::1' || bind === 'localhost'
  await new Promise<void>((resolve) => {
    server.listen(port, bind, () => resolve())
  })

  if (!isLoopback) {
    rootLogger.warn({
      component: 'acp',
      event: 'acp.server.non_loopback_bind',
      bind, port,
    }, `⚠️  ACP Server bound to ${bind}:${port} — accessible beyond loopback. `
       + `Ensure your firewall restricts ${bind}:${port} to trusted hosts; `
       + `Web admin token gate is the only client-facing protection.`)
    // Also emit a persistent audit row so the binding decision is
    // visible in /api/audit/events long after the boot log rolls.
    try {
      const { logAuditEvent } = await import('./audit-log.js')
      logAuditEvent({
        eventType: 'config.put',
        actor: 'system',
        target: 'acp-server.bind',
        outcome: 'ok',
        details: { bind, port, loopback: false },
      })
    } catch { /* best-effort */ }
  }
  rootLogger.info({ component: 'acp', port, bind }, `ACP Server listening on http://${bind}:${port}`)

  return {
    port,
    close: () => {
      server.close()
      // R14 — force-drop in-flight connections so port releases
      // immediately (mirror of the web server close behavior). Without
      // this, a long /tasks SSE stream keeps port 9090 bound across
      // restarts.
      try {
        const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections
        if (typeof fn === 'function') fn.call(server)
      } catch { /* ignore */ }
    },
  }
}
