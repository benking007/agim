// Web chat server — HTTP + WebSocket for browser-based agent interaction

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseMessage, routeMessage, type RouteContext } from '../core/router.js'
import { sessionManager } from '../core/session.js'
import { registry } from '../core/registry.js'
import { generateTraceId, createLogger, logger as rootLogger } from '../core/logger.js'
import { validateConfig } from '../core/config-schema.js'
import { safeEqual } from '../utils/safe-equal.js'

const webLog = rootLogger.child({ component: 'web' })

/**
 * Module-level reference to the button-callback handler that approval-router
 * registers on our synthetic web messenger. The WS message switch dispatches
 * `approval-action` events through this so an in-page approval button click
 * flows back into approvalBus.resolvePending(), same path as a Telegram
 * inline-button tap. Set by the web messenger's `onButtonCallback`; remains
 * undefined until approval-router installs (which happens before this file's
 * exported startWebServer is called from cli.ts).
 */
let webButtonHandler: ((cb: import('../core/types.js').ButtonCallback) => Promise<void>) | undefined

import {
  isAgentAvailableCached,
  loadConfig,
  saveConfig,
  type Config,
} from '../core/onboarding.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')
const DEFAULT_PORT = 3000
const WEB_TOKEN_DIR = join(homedir(), '.im-hub')
const WEB_TOKEN_FILE = join(WEB_TOKEN_DIR, 'web-token')

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function getOrCreateWebToken(): string {
  try {
    return readFileSync(WEB_TOKEN_FILE, 'utf-8').trim()
  } catch {
    const token = generateToken()
    mkdirSync(WEB_TOKEN_DIR, { recursive: true })
    writeFileSync(WEB_TOKEN_FILE, token, { mode: 0o600 })
    return token
  }
}

function isMasked(value: string | undefined): boolean {
  if (!value) return false
  return /^.{0,2}\*{2,}.{0,2}$/.test(value)
}

interface ClientConnection {
  ws: WebSocket
  id: string
  agent: string
}

/**
 * Start the web chat server
 */
export async function startWebServer(options: {
  port?: number
  defaultAgent: string
}): Promise<{ close: () => void; port: number }> {
  const port = options.port || DEFAULT_PORT
  const webToken = getOrCreateWebToken()
  const clients = new Map<string, ClientConnection>()

  // HTTP request handler — static files + REST API
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // Static pages
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveIndexHtml(res, join(PUBLIC_DIR, 'index.html'), webToken)
    }
    if (url.pathname === '/settings' || url.pathname === '/settings.html') {
      return serveIndexHtml(res, join(PUBLIC_DIR, 'settings.html'), webToken)
    }
    if (url.pathname === '/tasks' || url.pathname === '/tasks.html') {
      return serveIndexHtml(res, join(PUBLIC_DIR, 'tasks.html'), webToken)
    }

    // M4: /api/health is intentionally public (k8s liveness probe friendly)
    // — declare it BEFORE the /api/* token gate so callers don't need to
    // know the web token. Returns only operational status, not config.
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return handleHealth(req, res)
    }

    // Shared web-console utilities (theme manager + i18n + error boundary
    // + auth-aware fetch). Loaded synchronously by every static page in
    // <head> so the theme can apply before first paint. No secrets — safe
    // to serve un-authenticated.
    if (url.pathname === '/_app.js' && req.method === 'GET') {
      return serveStatic(res, join(PUBLIC_DIR, '_app.js'), 'application/javascript; charset=utf-8')
    }

    // REST API — require auth token
    if (url.pathname.startsWith('/api/')) {
      const token = req.headers['x-im-hub-token'] as string || ''
      if (!safeEqual(token, webToken)) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    }

    // REST API
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return handleGetConfig(req, res)
    }
    if (url.pathname === '/api/config' && req.method === 'PUT') {
      return handlePutConfig(req, res)
    }
    if (url.pathname === '/api/agents/status' && req.method === 'GET') {
      return handleAgentsStatus(req, res)
    }
    if (url.pathname === '/api/agents/acp/test' && req.method === 'POST') {
      return handleAcpTest(req, res)
    }
    if (url.pathname === '/api/agents/acp/discover' && req.method === 'POST') {
      return handleAcpDiscover(req, res)
    }

    // Jobs
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      return handleListJobs(req, res, url)
    }
    const jobIdMatch = url.pathname.match(/^\/api\/jobs\/(\d+)$/)
    if (jobIdMatch && req.method === 'GET') {
      return handleGetJob(req, res, parseInt(jobIdMatch[1], 10))
    }
    const jobCancelMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/cancel$/)
    if (jobCancelMatch && req.method === 'POST') {
      return handleCancelJob(req, res, parseInt(jobCancelMatch[1], 10))
    }
    const jobRunMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/run$/)
    if (jobRunMatch && req.method === 'POST') {
      return handleRunJob(req, res, parseInt(jobRunMatch[1], 10))
    }
    if (url.pathname === '/api/jobs' && req.method === 'POST') {
      return handleCreateJob(req, res)
    }

    // bgjobs (read-only view of ~/.claude/bgjobs, ~/.config/opencode/bgjobs, ~/.codex/bgjobs)
    if (url.pathname === '/api/bgjobs' && req.method === 'GET') {
      return handleListBgjobs(req, res, url)
    }
    const bgjobIdMatch = url.pathname.match(/^\/api\/bgjobs\/([\w.-]+)$/)
    if (bgjobIdMatch && req.method === 'GET') {
      return handleGetBgjob(req, res, bgjobIdMatch[1], url)
    }

    // Subtasks (flattened view of session.subtasks across all conversations)
    if (url.pathname === '/api/subtasks' && req.method === 'GET') {
      return handleListSubtasks(req, res, url)
    }

    // Schedules
    if (url.pathname === '/api/schedules' && req.method === 'GET') {
      return handleListSchedules(req, res, url)
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      return handleListWorkspaces(req, res)
    }
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      return handleMetrics(req, res, url)
    }
    if (url.pathname === '/api/audit' && req.method === 'GET') {
      return handleAudit(req, res, url)
    }
    // /api/health handled above the token gate (M4) — keep this comment so
    // future contributors don't re-add the route inside the auth block.
    if (url.pathname === '/api/notify' && req.method === 'POST') {
      return handleNotify(req, res)
    }
    if (url.pathname === '/api/invoke' && req.method === 'POST') {
      return handleInvoke(req, res, options.defaultAgent)
    }

    res.writeHead(404)
    res.end('Not found')
  })

  // WebSocket server
  const wss = new WebSocketServer({ server: httpServer })

  // M3: cap concurrent WS clients so a leaked / shared web token can't OOM
  // the host by opening unbounded connections. Default 100 is generous for
  // a single-user / small-team setup; production multi-tenant should set
  // IMHUB_MAX_WS_CLIENTS to a higher value.
  const maxWsClients = (() => {
    const raw = process.env.IMHUB_MAX_WS_CLIENTS
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n) && n > 0) return n
    }
    return 100
  })()

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (clients.size >= maxWsClients) {
      // 1013 = "Try Again Later" per RFC 6455. Slightly nicer than a flat
      // close — clients with reconnect logic will back off.
      webLog.warn({
        event: 'ws.cap_reached',
        active: clients.size,
        cap: maxWsClients,
      }, 'WS connection refused (cap)')
      ws.close(1013, 'Server too busy')
      return
    }
    // Verify token from URL query before accepting connection
    const wsUrl = new URL(req.url || '/', `http://localhost:${port}`)
    const wsToken = wsUrl.searchParams.get('token') || ''
    if (!safeEqual(wsToken, webToken)) {
      ws.close(1008, 'Unauthorized')
      return
    }

    const clientId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const client: ClientConnection = { ws, id: clientId, agent: options.defaultAgent }
    clients.set(clientId, client)

    webLog.info({ clientId }, 'Client connected')

    // Send available agents list
    sendToClient(ws, {
      type: 'init',
      agents: registry.listAgents(),
      defaultAgent: options.defaultAgent,
      clientId,
    })

    // Load existing session history if available
    sendSessionHistory(ws, clientId, options.defaultAgent)

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        // Approval-button click intercept. The user tapped an in-page
        // approval card button; route it through the web messenger's
        // button handler (registered by approval-router on install) the
        // same way a Telegram inline-keyboard tap is routed. We don't
        // call handleClientMessage for these — they're not chat input.
        if (msg && msg.type === 'approval-action' && webButtonHandler) {
          const data: string = String(msg.data || '')
          const messageId: string = String(msg.messageId || '')
          if (!data || !messageId) {
            sendToClient(ws, { type: 'error', message: 'approval-action missing data/messageId' })
            return
          }
          // Most messengers' ButtonCallback#ack updates a platform-native
          // toast / loading spinner. The web client doesn't have one, so
          // ack is a no-op resolving to the in-page status the page itself
          // chose to render after click.
          await webButtonHandler({
            data, threadId: clientId, userId: `web:${clientId}`,
            userDisplay: 'Web', messageId, ack: async () => {},
          })
          return
        }
        await handleClientMessage(client, msg, options.defaultAgent)
      } catch (err) {
        webLog.error({ clientId, err: err instanceof Error ? err.message : String(err) }, 'Error parsing client message')
        sendToClient(ws, { type: 'error', message: 'Invalid message format' })
      }
    })

    ws.on('close', () => {
      webLog.info({ clientId }, 'Client disconnected')
      clients.delete(clientId)
    })

    ws.on('error', (err) => {
      webLog.error({ clientId, err: err instanceof Error ? err.message : String(err) }, 'Client WebSocket error')
      clients.delete(clientId)
    })
  })

  // Start listening on all interfaces
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(port, '0.0.0.0', () => resolve())
  })

  webLog.info({ port }, `Chat UI available at http://localhost:${port}`)

  // ============================================================
  // Web messenger registration (HITL approval bridge)
  // ============================================================
  // Register a synthetic messenger named 'web' so approval-router (which
  // resolves the target messenger by platform name) can deliver approval
  // prompts AND outcome edits to the matching browser tab over the
  // existing WebSocket. Chat ingress is unaffected — incoming chat
  // messages still flow through handleClientMessage / routeMessage as
  // before; this messenger only forwards what the bus wants to push.
  //
  // threadId is the WS clientId (RouteContext.threadId === client.id for
  // the web platform). We resolve the matching client at delivery time;
  // if the client has disconnected the send is a no-op and the bus's own
  // auto-deny / sidecar-disconnect path takes over.
  let cardSeq = 0
  const webMessenger: import('../core/types.js').MessengerAdapter = {
    name: 'web',
    start: async () => {},
    stop: async () => {},
    onMessage: () => { /* chat ingress is handled by the WS-message switch above */ },
    async sendMessage(threadId, text) {
      const c = clients.get(threadId)
      if (!c || c.ws.readyState !== c.ws.OPEN) return
      sendToClient(c.ws, { type: 'approval-text', text })
    },
    async sendApprovalCard(threadId, prompt) {
      const c = clients.get(threadId)
      const messageId = `web-card-${++cardSeq}-${Date.now().toString(36)}`
      if (c && c.ws.readyState === c.ws.OPEN) {
        sendToClient(c.ws, { type: 'approval-card', messageId, prompt })
      }
      return { messageId }
    },
    async editApprovalCard(threadId, messageId, outcome) {
      const c = clients.get(threadId)
      if (!c || c.ws.readyState !== c.ws.OPEN) return
      sendToClient(c.ws, { type: 'approval-card-edit', messageId, outcome })
    },
    onButtonCallback(handler) {
      webButtonHandler = handler
    },
  }
  registry.registerMessenger(webMessenger)
  // approval-router's install() loop bound buttonCallback only for messengers
  // registered BEFORE install. Our web messenger was just registered (after
  // install), so we have to wire it ourselves — otherwise in-page approval
  // card clicks fire WS 'approval-action' messages with no handler on the
  // server side and silently do nothing. bindButtonHandlerForPlatform is a
  // no-op if approval-router hasn't been install()'d yet (e.g. degraded
  // mode where the bus failed to start).
  try {
    const { bindButtonHandlerForPlatform } = await import('../core/approval-router.js')
    bindButtonHandlerForPlatform('web')
  } catch (err) {
    webLog.warn({ err: err instanceof Error ? err.message : String(err) },
      'approval-router button-handler binding skipped (router not installed)')
  }

  return {
    port,
    close: () => {
      // Close all WebSocket connections
      for (const [id, client] of clients) {
        client.ws.close()
        clients.delete(id)
      }
      wss.close()
      httpServer.close()
    },
  }
}

// ============================================
// REST API handlers
// ============================================

async function handleGetConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const config = await loadConfig()
    const agentStatus = await getAgentStatuses()

    sendJson(res, 200, {
      messengers: config.messengers,
      agents: config.agents,
      defaultAgent: config.defaultAgent,
      telegram: config.telegram
        ? { botToken: mask(config.telegram.botToken), channelId: config.telegram.channelId }
        : undefined,
      feishu: config.feishu
        ? { appId: config.feishu.appId, appSecret: mask(config.feishu.appSecret) }
        : undefined,
      acpAgents: config.acpAgents?.map(a => ({
        ...a,
        auth: a.auth
          ? { ...a.auth, token: a.auth.token ? mask(a.auth.token) : undefined }
          : undefined,
      })),
      webPort: config.webPort,
      agentStatus,
    })
  } catch (err) {
    sendJson(res, 500, { error: 'Failed to load config' })
  }
}

async function handlePutConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const incoming = JSON.parse(body) as Record<string, unknown>
    const existing = await loadConfig()

    const merged: Record<string, unknown> = { ...existing }

    for (const key of Object.keys(incoming)) {
      const val = incoming[key]

      // Deep-protect nested known-masked paths so `ab****yz` never overwrites true value
      if (key === 'telegram' && typeof val === 'object' && val !== null) {
        const t = val as Record<string, unknown>
        merged.telegram = {
          ...(existing.telegram || {}),
          ...t,
          botToken: typeof t.botToken === 'string' && isMasked(t.botToken) ? existing.telegram?.botToken : t.botToken,
        }
        continue
      }
      if (key === 'feishu' && typeof val === 'object' && val !== null) {
        const f = val as Record<string, unknown>
        merged.feishu = {
          ...(existing.feishu || {}),
          ...f,
          appSecret: typeof f.appSecret === 'string' && isMasked(f.appSecret) ? existing.feishu?.appSecret : f.appSecret,
        }
        continue
      }
      if (key === 'acpAgents' && Array.isArray(val)) {
        merged.acpAgents = (val as unknown[]).map((item: unknown, i: number) => {
          const a = item as Record<string, unknown> | undefined
          const old = existing.acpAgents?.[i]
          if (a?.auth && typeof a.auth === 'object' && typeof (a.auth as Record<string, unknown>).token === 'string' && isMasked((a.auth as Record<string, unknown>).token as string)) {
            return { ...a, auth: { ...(a.auth as Record<string, unknown>), token: old?.auth?.token } }
          }
          return a
        })
        continue
      }

      if (typeof val === 'string' && isMasked(val)) {
        continue
      }
      merged[key] = val
    }

    const result = validateConfig(merged)
    if (!result.ok) {
      sendJson(res, 400, { error: 'Config validation failed', details: result.errors })
      return
    }

    await saveConfig(result.config as unknown as Config)
    sendJson(res, 200, { ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 400, { error: msg })
  }
}

async function handleAgentsStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const agentStatus = await getAgentStatuses()
    sendJson(res, 200, agentStatus)
  } catch (err) {
    sendJson(res, 500, { error: 'Failed to check agents' })
  }
}

async function handleListWorkspaces(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { workspaceRegistry } = await import('../core/workspace.js')
    sendJson(res, 200, { workspaces: workspaceRegistry.list() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
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

/**
 * POST /api/notify  → push a message to an IM thread.
 *
 * Body: { platform, threadId, text, card? }
 * Use case: external systems (CI / monitoring / cron) pushing notices
 * back to a chat thread without going through the Agent layer.
 */
async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const { platform, threadId, text, card } = JSON.parse(body) as {
      platform?: string; threadId?: string; text?: string; card?: unknown
    }
    if (!platform || !threadId || (!text && !card)) {
      sendJson(res, 400, { error: 'Missing platform / threadId / (text|card)' })
      return
    }

    // Map platform name to messenger plugin name.
    const messengerName = platform === 'wechat' ? 'wechat-ilink' : platform
    const messenger = registry.getMessenger(messengerName)
    if (!messenger) {
      sendJson(res, 404, { error: `Messenger "${platform}" not registered` })
      return
    }

    const traceId = generateTraceId()
    const log = createLogger({ traceId, platform, component: 'notify' })
    log.info({ threadId, hasCard: !!card, textLen: text?.length || 0 }, 'notify in')

    if (card && typeof messenger.sendCard === 'function') {
      await messenger.sendCard(threadId, card)
    } else if (text) {
      await messenger.sendMessage(threadId, text)
    } else {
      sendJson(res, 400, { error: 'card requires sendCard support, otherwise text is required' })
      return
    }

    sendJson(res, 200, { ok: true, traceId })
  } catch (err) {
    const e = err as Error & { statusCode?: number; handled?: boolean }
    if (e?.handled) return
    const status = e?.statusCode || 500
    const msg = e instanceof Error ? e.message : String(err)
    if (!res.headersSent) sendJson(res, status, { error: msg })
  }
}

/**
 * POST /api/invoke  → run an agent prompt as if it came from a user.
 *
 * Body: { prompt, agent?, userId?, platform? }
 * Returns a JSON response with the full text (for streaming use the ACP
 * server's POST /tasks?mode=stream instead).
 */
async function handleInvoke(req: IncomingMessage, res: ServerResponse, defaultAgent: string): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body) as {
      prompt?: string; agent?: string; userId?: string; platform?: string
    }
    if (!parsed.prompt) {
      sendJson(res, 400, { error: 'Missing prompt' })
      return
    }
    const agentName = parsed.agent || defaultAgent
    const promptText = parsed.agent ? `/${parsed.agent} ${parsed.prompt}` : parsed.prompt

    const traceId = generateTraceId()
    const platform = parsed.platform || 'rest'
    const log = createLogger({ traceId, platform, component: 'invoke' })
    log.info({ agent: agentName, promptLen: parsed.prompt.length }, 'invoke in')

    const routeCtx = {
      threadId: `rest:${traceId}`,
      channelId: 'rest',
      platform,
      defaultAgent: agentName,
      traceId,
      logger: log,
      userId: parsed.userId || 'rest-caller',
    }

    const parsedMsg = parseMessage(promptText)
    const result = await routeMessage(parsedMsg, routeCtx)
    let fullText = ''
    if (typeof result === 'string') {
      fullText = result
    } else {
      for await (const chunk of result) fullText += chunk
    }
    sendJson(res, 200, { ok: true, traceId, output: { content: fullText } })
  } catch (err) {
    const e = err as Error & { statusCode?: number; handled?: boolean }
    if (e?.handled) return
    const status = e?.statusCode || 500
    const msg = e instanceof Error ? e.message : String(err)
    if (!res.headersSent) sendJson(res, status, { error: msg })
  }
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Quick check: agent availability snapshot. Already used by settings UI;
  // exposing it under /api/health gives ops a stable URL.
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

async function handleListJobs(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { listJobs, getJobStats } = await import('../core/job-board.js')
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500)
    const status = url.searchParams.get('status') as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | null
    const agent = url.searchParams.get('agent') || undefined
    const jobs = listJobs(limit, status || undefined, agent ? { agent } : {})
    const stats = getJobStats()
    sendJson(res, 200, { jobs, stats })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleGetJob(_req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  try {
    const { getJob } = await import('../core/job-board.js')
    const job = getJob(id)
    if (!job) { sendJson(res, 404, { error: 'Job not found' }); return }
    sendJson(res, 200, { job })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleCancelJob(_req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  try {
    const { cancelJob } = await import('../core/job-board.js')
    sendJson(res, 200, { ok: cancelJob(id) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleRunJob(req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  try {
    const { getJob, runJob } = await import('../core/job-board.js')
    const { AgentBase } = await import('../core/agent-base.js')
    const job = getJob(id)
    if (!job) { sendJson(res, 404, { error: 'Job not found' }); return }
    const agent = registry.findAgent(job.agent)
    if (!agent) { sendJson(res, 404, { error: `Agent "${job.agent}" not registered` }); return }

    const traceId = generateTraceId()
    const log = createLogger({ traceId, platform: 'web', component: 'job-run' })
    // Fire and forget — UI polls /api/jobs/:id for status.
    void runJob(id, async function* (j, _logger, signal) {
      if (agent instanceof AgentBase) {
        const text = await agent.spawnAndCollect(j.prompt, signal)
        if (text) yield text
      } else {
        for await (const chunk of agent.sendPrompt(`web-job-${j.id}`, j.prompt, [])) {
          if (signal.aborted) break
          yield chunk
        }
      }
    }, log).catch(() => { /* job-board logs */ })

    sendJson(res, 200, { ok: true, traceId })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleCreateJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const { agent, prompt } = JSON.parse(body) as { agent?: string; prompt?: string }
    if (!agent || !prompt) {
      sendJson(res, 400, { error: 'Missing agent / prompt' })
      return
    }
    if (!registry.findAgent(agent)) {
      sendJson(res, 404, { error: `Agent "${agent}" not registered` })
      return
    }
    const { createJob } = await import('../core/job-board.js')
    const id = createJob(agent, prompt)
    sendJson(res, 200, { ok: true, id })
  } catch (err) {
    const e = err as Error & { handled?: boolean; statusCode?: number }
    if (e?.handled) return
    if (!res.headersSent) sendJson(res, e?.statusCode || 500, { error: e instanceof Error ? e.message : String(err) })
  }
}

async function handleListSchedules(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { listSchedules } = await import('../core/schedule.js')
    const agent = url.searchParams.get('agent') || undefined
    sendJson(res, 200, { schedules: listSchedules(50, agent ? { agent } : {}) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleListBgjobs(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { resolveRoots, listJobsForRoot, listAllJobs } = await import('../core/bgjob-reader.js')
    const rootId = url.searchParams.get('root')
    if (rootId) {
      // Single-root view — used by the dashboard's root selector.
      const root = resolveRoots().find((r) => r.id === rootId)
      if (!root) { sendJson(res, 404, { error: `bgjob root "${rootId}" not configured` }); return }
      const jobs = await listJobsForRoot(root)
      sendJson(res, 200, { roots: [{ id: root.id, label: root.label, path: root.path }], jobs })
      return
    }
    // No root specified: return all roots' metadata + jobs grouped by root.
    const all = await listAllJobs()
    sendJson(res, 200, {
      roots: all.map(({ root }) => ({ id: root.id, label: root.label, path: root.path })),
      groups: all.map(({ root, jobs }) => ({ rootId: root.id, jobs })),
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleGetBgjob(_req: IncomingMessage, res: ServerResponse, id: string, url: URL): Promise<void> {
  try {
    const { findRoot, getJobDetail, resolveRoots, listJobsForRoot } = await import('../core/bgjob-reader.js')
    const tail = Math.min(Math.max(parseInt(url.searchParams.get('tail') || '200', 10) || 200, 1), 5000)
    const rootId = url.searchParams.get('root')
    if (rootId) {
      const root = findRoot(rootId)
      if (!root) { sendJson(res, 404, { error: `bgjob root "${rootId}" not configured` }); return }
      const job = await getJobDetail(root, id, tail)
      if (!job) { sendJson(res, 404, { error: 'Job not found' }); return }
      sendJson(res, 200, { job })
      return
    }
    // No root: try every configured root, return first hit.
    for (const root of resolveRoots()) {
      const summaries = await listJobsForRoot(root)
      if (!summaries.some((s) => s.id === id)) continue
      const job = await getJobDetail(root, id, tail)
      if (job) { sendJson(res, 200, { job }); return }
    }
    sendJson(res, 404, { error: 'Job not found' })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleListSubtasks(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { sessionManager } = await import('../core/session.js')
    const agent = url.searchParams.get('agent') || undefined
    const subtasks = await sessionManager.listAllSubtasks(agent ? { agent } : {})
    sendJson(res, 200, { subtasks })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
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

async function handleAcpDiscover(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const { baseUrl, register } = JSON.parse(body) as { baseUrl?: string; register?: boolean }
    if (!baseUrl) {
      sendJson(res, 400, { error: 'Missing baseUrl' })
      return
    }
    const { discoverAgents } = await import('../plugins/agents/acp/discovery.js')
    const result = await discoverAgents(baseUrl)
    if (register) {
      await registry.loadACPAgents(result.agents)
    }
    sendJson(res, 200, { ok: true, baseUrl: result.baseUrl, agents: result.agents })
  } catch (err) {
    const e = err as Error & { statusCode?: number; handled?: boolean }
    if (e?.handled) return
    const status = e?.statusCode || 500
    const msg = e instanceof Error ? e.message : String(err)
    if (!res.headersSent) sendJson(res, status, { ok: false, error: msg })
  }
}

async function handleAcpTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    // M11: bare JSON.parse threw a SyntaxError that bubbled out into the
    // outer catch and surfaced as a "500-ish 400" with the parser's raw
    // message. Validate explicitly so malformed bodies get a clean 400.
    let parsed: { endpoint?: string; auth?: unknown }
    try {
      parsed = JSON.parse(body) as { endpoint?: string; auth?: unknown }
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      return
    }
    const { endpoint, auth } = parsed
    if (!endpoint || typeof endpoint !== 'string') {
      sendJson(res, 400, { ok: false, error: 'Missing or invalid "endpoint"' })
      return
    }

    // Dynamic import to avoid circular deps
    const { ACPClient } = await import('../plugins/agents/acp/acp-client.js')
    const client = new ACPClient({ name: 'test', endpoint, auth: auth as never })
    const manifest = await client.fetchManifest()

    sendJson(res, 200, {
      ok: true,
      name: manifest.name,
      description: manifest.description,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 400, { ok: false, error: msg })
  }
}

// ============================================
// Helpers
// ============================================

async function getAgentStatuses(): Promise<Record<string, boolean>> {
  const agents = registry.listAgents()
  const status: Record<string, boolean> = {}
  await Promise.all(
    agents.map(async (name) => {
      const agent = registry.findAgent(name)
      if (agent) {
        try {
          status[name] = await agent.isAvailable()
        } catch {
          status[name] = false
        }
      }
    })
  )
  return status
}

function mask(value: string | undefined): string {
  if (!value) return ''
  if (value.length <= 4) return '****'
  return value.slice(0, 2) + '****' + value.slice(-2)
}

/** Hard cap on inbound JSON bodies for the Web REST API. */
const MAX_API_BODY_BYTES = 1 * 1024 * 1024  // 1 MiB

function readBody(req: IncomingMessage, res?: ServerResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > MAX_API_BODY_BYTES) {
        aborted = true
        if (res && !res.headersSent) {
          sendJson(res, 413, { error: 'Request body too large' })
        }
        const err = new Error('Request body too large') as Error & { statusCode?: number; handled?: boolean }
        err.statusCode = 413
        err.handled = !!res
        reject(err)
        return
      }
      chunks.push(chunk)
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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// ============================================
// WebSocket chat handlers
// ============================================

/**
 * Handle a message from a web client
 */
async function handleClientMessage(
  client: ClientConnection,
  msg: { type: string; text?: string; agent?: string },
  defaultAgent: string
): Promise<void> {
  const { ws, id: clientId } = client

  switch (msg.type) {
    case 'message': {
      if (!msg.text?.trim()) return

      const text = msg.text.trim()
      const traceId = generateTraceId()
      const logger = createLogger({ traceId, platform: 'web', component: 'web' })

      if (msg.agent && msg.agent !== client.agent) {
        client.agent = msg.agent
      }

      const parsed = parseMessage(text)

      try {
        const routeCtx: RouteContext = {
          threadId: clientId,
          channelId: 'web',
          platform: 'web',
          defaultAgent: client.agent,
          traceId,
          logger,
          userId: `web:${clientId}`,
        }

        logger.info({ event: 'message.received', text: text.substring(0, 120) })

        const result = await routeMessage(parsed, routeCtx)

        // String response (built-in commands, errors)
        if (typeof result === 'string') {
          sendToClient(ws, { type: 'done', text: result })
          return
        }

        // Streaming response (agent responses)
        let fullText = ''
        for await (const chunk of result) {
          fullText += chunk
          // L1: defer when the per-socket send buffer is full. Without
          // this, a slow client lets the chunk producer keep allocating
          // frames into the kernel + ws-internal queue, which can grow
          // to GBs for a long agent response.
          await awaitWsDrain(ws)
          if (ws.readyState !== ws.OPEN) break
          sendToClient(ws, { type: 'chunk', text: chunk })
        }
        sendToClient(ws, { type: 'done', text: fullText })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        logger.error({ event: 'web.handle.error', err: errorMsg, stack }, 'Error handling client message')
        sendToClient(ws, { type: 'error', message: `Agent error: ${errorMsg}` })
      }
      break
    }

    case 'switch-agent': {
      if (!msg.agent) return
      const agent = registry.findAgent(msg.agent)
      if (!agent) {
        sendToClient(ws, { type: 'error', message: `Agent "${msg.agent}" not found` })
        return
      }
      if (!(await isAgentAvailableCached(agent.name))) {
        sendToClient(ws, { type: 'error', message: `Agent "${agent.name}" is not available` })
        return
      }
      client.agent = agent.name
      await sessionManager.switchAgent('web', 'web', clientId, agent.name)
      sendToClient(ws, { type: 'agent-switched', agent: agent.name })
      break
    }

    case 'get-agents': {
      const agents = registry.listAgents()
      sendToClient(ws, { type: 'agents', agents })
      break
    }

    case 'get-history': {
      await sendSessionHistory(ws, clientId, defaultAgent)
      break
    }
  }
}

/**
 * Send session history to a client
 */
async function sendSessionHistory(ws: WebSocket, clientId: string, defaultAgent: string): Promise<void> {
  const history = await sessionManager.getSessionWithHistory('web', 'web', clientId)
  if (history && history.messages.length > 0) {
    sendToClient(ws, {
      type: 'history',
      messages: history.messages,
      agent: history.session.agent,
    })
  }
}

/** L1: backpressure threshold for the WS send path. When `ws.bufferedAmount`
 *  exceeds this, the streaming chunk loop awaits a tick instead of piling up
 *  more frames. 4 MiB tolerates a few seconds of slow client without
 *  unbounded memory growth — Node's WebSocket impl honors the kernel
 *  send buffer behind this number. */
const WS_BACKPRESSURE_HIGHWATER_BYTES = 4 * 1024 * 1024

/**
 * Send a JSON message to a WebSocket client
 */
function sendToClient(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

/**
 * Wait until `ws.bufferedAmount` drops below the highwater mark, or the
 * socket closes, or the timeout fires. Used by the streaming chunk loop to
 * stop piling up frames at slow clients.
 *
 * Polls every 50 ms — node's `ws` doesn't emit a `drain` event we can hook,
 * but the buffered amount drops monotonically once the kernel ACKs flush.
 * Bounded by IMHUB_WS_BACKPRESSURE_TIMEOUT_MS (default 5 s) so a frozen
 * client can't wedge the agent's chunk producer indefinitely.
 */
async function awaitWsDrain(ws: WebSocket): Promise<void> {
  if (ws.bufferedAmount < WS_BACKPRESSURE_HIGHWATER_BYTES) return
  const timeoutMs = (() => {
    const raw = process.env.IMHUB_WS_BACKPRESSURE_TIMEOUT_MS
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n) && n > 0) return n
    }
    return 5_000
  })()
  const startedAt = Date.now()
  while (
    ws.readyState === ws.OPEN
    && ws.bufferedAmount >= WS_BACKPRESSURE_HIGHWATER_BYTES
    && Date.now() - startedAt < timeoutMs
  ) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Serve a static file (no token injection needed)
 */
function serveStatic(res: ServerResponse, filePath: string, contentType: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  const content = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(content)
}

/**
 * Serve index/settings HTML with injected web token for API auth
 */
function serveIndexHtml(res: ServerResponse, filePath: string, token: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  let html = readFileSync(filePath, 'utf-8')
  // JSON.stringify produces a safely quoted JS string literal — prevents
  // breakout if the token ever contains ' or </script>.
  html = html.replace('</head>', `<script>window.IMHUB_TOKEN=${JSON.stringify(token)};</script></head>`)
  // No-cache so dashboard updates land for users without forcing a hard refresh.
  // The HTML is small (<30KB) and the round-trip is cheap; correctness wins.
  //
  // M1: defense-in-depth response headers. CSP keeps 'unsafe-inline' on
  // script/style because the IMHUB_TOKEN bootstrap and a few inline event
  // handlers in the static pages still rely on it; tightening to a nonce
  // is tracked separately. Outside that, lock everything down: no framing,
  // no MIME sniffing, no Referer leak to third parties, no third-party
  // resources at all.
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, must-revalidate',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'self'",
      "connect-src 'self' ws: wss:",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  })
  res.end(html)
}
