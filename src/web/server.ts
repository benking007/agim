// Web chat server — HTTP + WebSocket for browser-based agent interaction

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { readdir, stat, readFile, writeFile, rename, unlink, realpath, open } from 'node:fs/promises'
import { join, dirname, resolve as resolvePath, sep as pathSep, relative as relativePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseMessage, routeMessage, type RouteContext } from '../core/router.js'
import { sessionManager } from '../core/session.js'
import { registry } from '../core/registry.js'
import { generateTraceId, createLogger, logger as rootLogger } from '../core/logger.js'
import { validateConfig } from '../core/config-schema.js'
import { safeEqual } from '../utils/safe-equal.js'
import { consumeToken, peekToken } from '../core/location-token.js'
import { createMemo, updateMemo, getMemo, mapUrls, gcj02ToWgs84 } from '../core/memos.js'

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

export function createSerialQueue(): (fn: () => Promise<void>) => void {
  let queue: Promise<void> = Promise.resolve()
  return (fn: () => Promise<void>): void => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    void run
  }
}

/**
 * Start the web chat server
 */
export async function startWebServer(options: {
  port?: number
  defaultAgent: string
}): Promise<{ close: () => void; port: number }> {
  const port = options.port || DEFAULT_PORT
  const bindHost = process.env.IMHUB_WEB_BIND || '127.0.0.1'
  const webToken = getOrCreateWebToken()
  const clients = new Map<string, ClientConnection>()

  // Per-process secret for signing session cookies. Not persisted — browser
  // sessions expire on restart, which is acceptable for a dev tool.
  const cookieSecret = randomBytes(32).toString('hex')
  const COOKIE_NAME = 'imhub_session'

  function makeSessionCookie(): string {
    return createHmac('sha256', cookieSecret).update(webToken).digest('hex')
  }
  function isValidSessionCookie(cookie: string): boolean {
    const expected = makeSessionCookie()
    if (cookie.length !== expected.length) return false
    try {
      return timingSafeEqual(Buffer.from(cookie, 'utf8'), Buffer.from(expected, 'utf8'))
    } catch { return false }
  }
  function parseCookies(req: IncomingMessage): Record<string, string> {
    const hdr = req.headers.cookie || ''
    const out: Record<string, string> = {}
    for (const pair of hdr.split(';')) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
    return out
  }
  function hasValidSession(req: IncomingMessage): boolean {
    const cookies = parseCookies(req)
    return isValidSessionCookie(cookies[COOKIE_NAME] || '')
  }
  function setSessionCookie(req: IncomingMessage, res: ServerResponse): void {
    const val = makeSessionCookie()
    const parts = [`${COOKIE_NAME}=${val}`, 'HttpOnly', 'SameSite=Strict', 'Path=/']
    // Mark Secure when we have any signal we're served over TLS:
    //  - public bind (assume reverse proxy will/should terminate TLS)
    //  - X-Forwarded-Proto: https from a trusted reverse proxy
    // For pure localhost dev (no proxy) we omit Secure so plain HTTP works.
    const isPublicBind = bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost'
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
    if (isPublicBind || xfp === 'https') parts.push('Secure')
    res.setHeader('Set-Cookie', parts.join('; '))
  }

  if (bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost') {
    webLog.warn({
      event: 'web.public_bind_warning',
      bind: bindHost,
    }, 'Web server bound to a non-localhost address — front it with a reverse proxy that terminates TLS')
  }

  // HTTP request handler — static files + REST API
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // Login page — always accessible
    if (url.pathname === '/login' || url.pathname === '/login.html') {
      return serveStatic(res, join(PUBLIC_DIR, 'login.html'), 'text/html; charset=utf-8')
    }

    // POST /api/auth/login — validate token, set session cookie
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req, res)
      let parsed: { token?: string }
      try { parsed = JSON.parse(body) } catch {
        sendJson(res, 400, { error: 'Invalid JSON' })
        return
      }
      if (typeof parsed.token === 'string' && safeEqual(parsed.token, webToken)) {
        setSessionCookie(req, res)
        sendJson(res, 200, { ok: true })
      } else {
        sendJson(res, 401, { error: 'Invalid token' })
      }
      return
    }

    // Static pages — require valid session cookie
    if (
      url.pathname === '/' || url.pathname === '/index.html' ||
      url.pathname === '/settings' || url.pathname === '/settings.html' ||
      url.pathname === '/tasks' || url.pathname === '/tasks.html' ||
      url.pathname === '/reminders' || url.pathname === '/reminders.html'
    ) {
      if (!hasValidSession(req)) {
        res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname)}` })
        res.end()
        return
      }
      const fileMap: Record<string, string> = {
        '/': 'index.html', '/index.html': 'index.html',
        '/settings': 'settings.html', '/settings.html': 'settings.html',
        '/tasks': 'tasks.html', '/tasks.html': 'tasks.html',
        '/reminders': 'reminders.html', '/reminders.html': 'reminders.html',
      }
      return servePageHtml(res, join(PUBLIC_DIR, fileMap[url.pathname]!))
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

    // ─── Location capture endpoints (public; auth via single-use token) ───
    // Public on purpose — the user reaches these via a token-bearing link
    // sent into their IM thread. Token (32 hex chars, 10-min TTL, single
    // use) is the credential. Designed to sit behind a CDN that proxies
    // agent.iclaw.host → this port. **CDN MUST whitelist only /loc and
    // /api/loc** — other paths on :3000 (/tasks, /api/*, /reminders) are
    // operator-only and would leak if the CDN catch-all forwards.

    if (url.pathname === '/loc' && req.method === 'GET') {
      return serveStatic(res, join(PUBLIC_DIR, 'loc.html'), 'text/html; charset=utf-8')
    }

    // Short alias: /l/<token> serves the same H5 page. The page auto-detects
    // either ?t= query or /l/<token> path. Lets us issue ~38-char URLs
    // (vs 70+ for /loc?t=<32-hex>) which keeps WeChat chat cleaner.
    if (url.pathname.startsWith('/l/') && req.method === 'GET') {
      return serveStatic(res, join(PUBLIC_DIR, 'loc.html'), 'text/html; charset=utf-8')
    }

    // GET /api/loc/info?t=… — read-only peek for the H5 page to show what
    // is being recorded. Does NOT consume the token — that happens on POST.
    // Returns 410 when the token is expired/unknown so the page can render
    // a hard-stop "link expired" state instead of pretending and failing
    // on the POST.
    if (url.pathname === '/api/loc/info' && req.method === 'GET') {
      const tk = url.searchParams.get('t') || ''
      if (!tk) { sendJson(res, 400, { error: 'missing t' }); return }
      const peek = peekToken(tk)
      if (!peek) { sendJson(res, 410, { error: 'token expired or unknown' }); return }
      // For augment-mode (memo_id present), tell the H5 page so it can show
      // "正在补充'<existing what>'的位置" instead of "正在记录: <what>".
      let augmentLabel: string | undefined
      if (peek.memoId != null) {
        const existing = getMemo(peek.memoId, { userId: peek.ctx.userId })
        if (existing) augmentLabel = existing.what
      }
      sendJson(res, 200, {
        ok: true,
        what: peek.what,
        memoId: peek.memoId ?? undefined,
        augmentLabel,
        expiresAt: new Date(peek.expiresAt).toISOString(),
      })
      return
    }

    if (url.pathname === '/api/loc' && req.method === 'POST') {
      const body = await readBody(req, res)
      let parsed: { t?: string; lat?: number; lng?: number; accuracy?: number }
      try { parsed = JSON.parse(body) } catch {
        sendJson(res, 400, { error: 'invalid JSON' }); return
      }
      const tk = typeof parsed.t === 'string' ? parsed.t : ''
      const rawLat = typeof parsed.lat === 'number' ? parsed.lat : NaN
      const rawLng = typeof parsed.lng === 'number' ? parsed.lng : NaN
      if (!tk || !Number.isFinite(rawLat) || !Number.isFinite(rawLng)) {
        sendJson(res, 400, { error: '请求体缺少 t / lat / lng' }); return
      }
      if (rawLat < -90 || rawLat > 90 || rawLng < -180 || rawLng > 180) {
        sendJson(res, 400, { error: '坐标超出有效范围' }); return
      }
      // navigator.geolocation in browsers running on Apple platforms returns
      // coordinates as Core Location hands them up — and Apple applies the
      // GCJ-02 offset for inside-China coords (PRC compliance requirement,
      // since iOS 7). Same for Google's fused-location on Android in China.
      // So the H5 page typically ships us GCJ-02 even though the JS API name
      // implies WGS-84. Our DB convention is WGS-84 (and the amap/baidu URL
      // builders assume WGS-84 input), so reverse here. gcj02ToWgs84 is a
      // no-op outside the China bbox, so foreign users with clean WGS-84
      // pass through unchanged.
      const wgs = gcj02ToWgs84(rawLat, rawLng)
      const lat = wgs.lat
      const lng = wgs.lng
      const cr = consumeToken(tk)
      if (!cr.ok) {
        const msg = cr.reason === 'expired' ? '链接已过期，请重新让 bot 发起记录' : '链接无效或已被使用'
        sendJson(res, 410, { error: msg }); return
      }
      const ctx = cr.ctx
      const what = cr.what || ''
      const accuracy = typeof parsed.accuracy === 'number' ? parsed.accuracy : 0

      // Two paths:
      //   - cr.memoId set → UPDATE existing memo's where_*
      //   - cr.memoId null → CREATE new memo with what + where_*
      let memoId: number | null = null
      let displayWhat = what
      try {
        if (cr.memoId != null) {
          const existing = getMemo(cr.memoId, { userId: ctx.userId })
          if (existing) {
            updateMemo(cr.memoId, {
              whereLat: lat,
              whereLng: lng,
            }, { userId: ctx.userId })
            memoId = cr.memoId
            displayWhat = existing.what  // memo's own what wins for reply
          } else {
            // Memo got deleted between issue + consume? Fall back to creating
            // a new one with whatever `what` the token had — better than
            // dropping the user's grant.
            memoId = createMemo({
              platform: ctx.platform, channelId: ctx.channelId,
              threadId: ctx.threadId, userId: ctx.userId,
              what: what || '位置',
              whereLat: lat, whereLng: lng,
              source: 'browser',
            })
          }
        } else {
          memoId = createMemo({
            platform: ctx.platform, channelId: ctx.channelId,
            threadId: ctx.threadId, userId: ctx.userId,
            what: what || '位置',
            whereLat: lat, whereLng: lng,
            source: 'browser',
          })
        }
      } catch (err) {
        webLog.warn({ event: 'web.loc.memo_failed', err: String(err) }, 'failed to write/update memo')
      }

      const messengerName = ctx.platform === 'wechat' ? 'wechat-ilink' : ctx.platform
      const messenger = registry.getMessenger(messengerName)
      const idTag = memoId ? `#${memoId}` : ''
      const accTxt = accuracy > 0 ? ` (±${Math.round(accuracy)}m)` : ''
      const headLabel = displayWhat ? `'${displayWhat}'` : ''
      const urls = mapUrls(lat, lng, displayWhat || '当前位置', '')
      const verb = cr.memoId != null ? '已补全' : '已记下'
      const reply = [
        `✅ ${verb}${headLabel} ${idTag}`.trim(),
        `   坐标: ${lat.toFixed(6)}, ${lng.toFixed(6)}${accTxt}`,
        '',
        `   🗺 [百度地图](${urls.baidu}) · [高德地图](${urls.amap}) · [Google](${urls.google})`,
      ].filter(Boolean).join('\n')
      if (messenger) {
        messenger.sendMessage(ctx.threadId, reply).catch((err) => {
          webLog.warn({ event: 'web.loc.dispatch_failed', threadId: ctx.threadId, err: String(err) })
        })
      } else {
        webLog.warn({ event: 'web.loc.no_messenger', platform: ctx.platform })
      }

      sendJson(res, 200, { ok: true, id: memoId, lat, lng })
      return
    }

    // REST API — require auth token (header) or valid session cookie
    if (url.pathname.startsWith('/api/')) {
      const token = req.headers['x-im-hub-token'] as string || ''
      if (!safeEqual(token, webToken) && !hasValidSession(req)) {
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

    // Reminders — list / cancel / snooze. Web-only path (the IM-side path
    // is /remind slash command). Auth via the same web session cookie as
    // every other /api/* endpoint above; no per-user filtering yet, so
    // single-operator deployments only.
    if (url.pathname === '/api/reminders' && req.method === 'GET') {
      return handleListReminders(req, res, url)
    }
    const reminderCancelMatch = url.pathname.match(/^\/api\/reminders\/(\d+)\/cancel$/)
    if (reminderCancelMatch && req.method === 'POST') {
      return handleCancelReminderApi(req, res, Number.parseInt(reminderCancelMatch[1], 10))
    }
    const reminderSnoozeMatch = url.pathname.match(/^\/api\/reminders\/(\d+)\/snooze$/)
    if (reminderSnoozeMatch && req.method === 'POST') {
      return handleSnoozeReminderApi(req, res, Number.parseInt(reminderSnoozeMatch[1], 10))
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      return handleListWorkspaces(req, res, url)
    }
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      return handleCreateOrUpdateWorkspace(req, res)
    }
    const workspaceIdMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
    if (workspaceIdMatch && req.method === 'PATCH') {
      return handleCreateOrUpdateWorkspace(req, res, workspaceIdMatch[1])
    }
    if (workspaceIdMatch && req.method === 'DELETE') {
      return handleDeleteWorkspace(req, res, workspaceIdMatch[1])
    }
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      return handleMetrics(req, res, url)
    }
    if (url.pathname === '/api/audit' && req.method === 'GET') {
      return handleAudit(req, res, url)
    }
    // PR-B: agent health snapshot (circuit breaker + rate-limiter remaining
    // + latency p50/95/99) consumed by the Health tab in /tasks.
    if (url.pathname === '/api/agent-health' && req.method === 'GET') {
      return handleAgentHealth(req, res)
    }
    // PR-B: HITL approvals — global pending list + per-reqId resolve.
    if (url.pathname === '/api/approvals' && req.method === 'GET') {
      return handleListApprovals(req, res)
    }
    const approvalResolveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/)
    if (approvalResolveMatch && req.method === 'POST') {
      return handleResolveApproval(req, res, approvalResolveMatch[1])
    }
    // PR-D: Agent workspace file browser. Read-only inspection of
    // ~/.im-hub-workspaces/<agent>/ contents — list dirs, peek small
    // text files. PUT path supports inline editing (annotate CLAUDE.md,
    // AGENTS.md, etc.) — same traversal/size guards as GET.
    if (url.pathname === '/api/workspace-files' && req.method === 'GET') {
      return handleWorkspaceFiles(req, res, url)
    }
    if (url.pathname === '/api/workspace-files' && req.method === 'PUT') {
      return handleWorkspaceFileWrite(req, res, url)
    }
    // PR-D: Job batch operations. Same semantics as /api/jobs/:id/cancel
    // and /run but accepts an array of ids in one request — saves N
    // round-trips when the user multi-selects a long list.
    if (url.pathname === '/api/jobs/batch-cancel' && req.method === 'POST') {
      return handleBatchJob(req, res, 'cancel')
    }
    if (url.pathname === '/api/jobs/batch-run' && req.method === 'POST') {
      return handleBatchJob(req, res, 'run', options.defaultAgent)
    }
    // PR-C: SSE event stream — audit / approval / job / metrics events
    // pushed real-time so the dashboard stops polling. EventSource has no
    // header API, so the token rides in `?token=<webToken>` (same shape
    // the WS upgrade uses). Auth is validated inside the handler since
    // /events is outside the /api/* token gate above.
    if (url.pathname === '/events' && req.method === 'GET') {
      const evToken = url.searchParams.get('token') || ''
      if (!safeEqual(evToken, webToken) && !hasValidSession(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' })
        res.end('Unauthorized')
        return
      }
      return handleEventsSSE(req, res)
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
    // Verify token from URL query or session cookie before accepting connection
    const wsUrl = new URL(req.url || '/', `http://localhost:${port}`)
    const wsToken = wsUrl.searchParams.get('token') || ''
    if (!safeEqual(wsToken, webToken) && !hasValidSession(req)) {
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

    const enqueueInbound = createSerialQueue()

    ws.on('message', (data: Buffer) => {
      enqueueInbound(async () => {
        try {
          const msg = JSON.parse(data.toString())
          // Approval-button click intercept. The user tapped an in-page
          // approval card button; route it through the web messenger's
          // button handler (registered by approval-router on install) the
          // same way a Telegram inline-keyboard tap is routed. We don't
          // call handleClientMessage for these — they're not chat input.
          if (msg && msg.type === 'approval-action') {
            const actionData: string = String(msg.data || '')
            const messageId: string = String(msg.messageId || '')
            webLog.info({
              event: 'approval.web.click_received',
              clientId, data: actionData, messageId,
              handlerBound: !!webButtonHandler,
            })
            if (!actionData || !messageId) {
              sendToClient(ws, { type: 'error', message: 'approval-action missing data/messageId' })
              return
            }
            if (!webButtonHandler) {
              // Without the handler, a click would silently no-op forever — the
              // failure mode that PR-A's fix patches. Tell the user and the
              // operator (via log) instead of dropping the click.
              const why = 'approval handler not bound (router not installed?). Restart im-hub to rebind.'
              webLog.warn({ event: 'approval.web.no_handler', clientId, data: actionData, messageId }, why)
              sendToClient(ws, { type: 'error', message: why })
              return
            }
            try {
              // Most messengers' ButtonCallback#ack updates a platform-native
              // toast / loading spinner. The web client doesn't have one, so
              // ack is a no-op resolving to the in-page status the page itself
              // chose to render after click.
              await webButtonHandler({
                data: actionData, threadId: clientId, userId: `web:${clientId}`,
                userDisplay: 'Web', messageId, ack: async () => {},
              })
              webLog.info({ event: 'approval.web.click_resolved', clientId, data: actionData })
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              webLog.error({ event: 'approval.web.click_failed', clientId, data: actionData, err: errMsg })
              sendToClient(ws, { type: 'error', message: `Approval click failed: ${errMsg}` })
            }
            return
          }
          await handleClientMessage(client, msg, options.defaultAgent)
        } catch (err) {
          webLog.error({ clientId, err: err instanceof Error ? err.message : String(err) }, 'Error parsing client message')
          sendToClient(ws, { type: 'error', message: 'Invalid message format' })
        }
      })
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

  // Default to loopback; operators can opt into LAN/public exposure with
  // IMHUB_WEB_BIND=0.0.0.0 behind their firewall/reverse proxy.
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(port, bindHost, () => resolve())
  })

  webLog.info({ port, bindHost }, `Chat UI available at http://${bindHost === '0.0.0.0' ? 'localhost' : bindHost}:${port}`)

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
      webLog.info({ event: 'approval.web.handler_bound' },
        'web messenger button-callback handler attached')
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
    if (!webButtonHandler) {
      // bindButtonHandlerForPlatform is a silent no-op when `installed` is
      // null on the router (bus failed to start, or cli skipped install).
      // Log so an operator who's confused why approval clicks don't work
      // sees a clear breadcrumb at startup.
      webLog.warn({ event: 'approval.web.bind_skipped' },
        'approval-router not installed — web approval clicks will fail until restart')
    }
  } catch (err) {
    webLog.warn({ event: 'approval.web.bind_error', err: err instanceof Error ? err.message : String(err) },
      'approval-router button-handler binding threw')
  }

  // PR-C: periodic metrics tick. Publishes a per-agent snapshot every 5s
  // so the dashboard's Health sparkline can advance even when there are
  // no audit events firing. The bus's recent buffer keeps the latest
  // tick available to fresh SSE connections, so a tab opened mid-cycle
  // sees current data without waiting up to 5 s.
  const metricsTick = setInterval(async () => {
    try {
      const { eventBus } = await import('../core/event-bus.js')
      const { snapshot } = await import('../core/metrics.js')
      const snap = snapshot()
      eventBus.publish({
        type: 'metrics',
        ts: new Date().toISOString(),
        agents: snap.agents.map((a) => ({
          agent: a.agent, total: a.total, success: a.success, failure: a.failure,
          p50Ms: a.p50Ms, p95Ms: a.p95Ms, p99Ms: a.p99Ms,
        })),
      })
    } catch { /* swallow — metrics tick must never break the web server */ }
  }, 5_000)
  if (typeof metricsTick === 'object' && metricsTick && 'unref' in metricsTick) {
    (metricsTick as { unref: () => void }).unref()
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
  } catch (_err) {
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
  } catch (_err) {
    sendJson(res, 500, { error: 'Failed to check agents' })
  }
}

async function handleListWorkspaces(_req: IncomingMessage, res: ServerResponse, url?: URL): Promise<void> {
  try {
    const { workspaceRegistry } = await import('../core/workspace.js')
    // ?full=1 returns the full WorkspaceConfig (including member IDs)
    // for the settings editor; default is the summary shape (member count
    // only) used elsewhere.
    const wantFull = url?.searchParams.get('full') === '1'
    sendJson(res, 200, {
      workspaces: wantFull ? workspaceRegistry.listFull() : workspaceRegistry.list(),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
  }
}

/**
 * Validate + sanitize an incoming WorkspaceConfig from the settings
 * editor. Returns a clean object on success or a string error message
 * on failure. Reused by POST and PATCH so behavior is identical.
 */
function validateWorkspacePayload(raw: unknown, expectedId?: string): { ok: true; cfg: import('../core/workspace.js').WorkspaceConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' }
  const o = raw as Record<string, unknown>
  const id = String(o.id || '').trim()
  if (!id) return { ok: false, error: 'id is required' }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, error: 'id must match [a-zA-Z0-9_-]+' }
  if (id === 'default' && expectedId !== 'default') {
    return { ok: false, error: '"default" workspace is reserved (use PATCH to edit)' }
  }
  if (expectedId && expectedId !== id) {
    return { ok: false, error: `id mismatch: URL is ${expectedId}, body is ${id}` }
  }
  const name = String(o.name || id)
  const agents = Array.isArray(o.agents) ? o.agents.filter((a): a is string => typeof a === 'string') : []
  const members = Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === 'string') : undefined
  let rateLimit: { rate: number; intervalSec: number; burst: number } | undefined
  if (o.rateLimit && typeof o.rateLimit === 'object') {
    const r = o.rateLimit as Record<string, unknown>
    const rate = Number(r.rate)
    const intervalSec = Number(r.intervalSec)
    const burst = Number(r.burst)
    if (!Number.isFinite(rate) || rate <= 0
      || !Number.isFinite(intervalSec) || intervalSec <= 0
      || !Number.isFinite(burst) || burst <= 0) {
      return { ok: false, error: 'rateLimit.rate / intervalSec / burst must be positive numbers' }
    }
    rateLimit = { rate, intervalSec, burst }
  }
  return { ok: true, cfg: { id, name, agents, members, rateLimit } }
}

/**
 * Persist the workspaces array back to ~/.im-hub/config.json so changes
 * survive a restart. We do not touch other config fields — settings.html
 * has its own /api/config PUT for that. Best-effort: a write failure is
 * logged but the in-memory registry has already been updated, so the
 * change is live until the next process boot.
 */
async function persistWorkspacesToConfig(workspaces: import('../core/workspace.js').WorkspaceConfig[]): Promise<void> {
  const config = await loadConfig()
  ;(config as Record<string, unknown>).workspaces = workspaces
  await saveConfig(config)
}

async function handleCreateOrUpdateWorkspace(req: IncomingMessage, res: ServerResponse, expectedId?: string): Promise<void> {
  try {
    const body = await readBody(req, res)
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      return
    }
    const v = validateWorkspacePayload(parsed, expectedId)
    if (!v.ok) {
      sendJson(res, 400, { ok: false, error: v.error })
      return
    }
    const { workspaceRegistry } = await import('../core/workspace.js')
    workspaceRegistry.add(v.cfg)
    await persistWorkspacesToConfig(
      workspaceRegistry.listFull().filter((w) => w.id !== 'default')
    )
    sendJson(res, 200, { ok: true, workspace: v.cfg })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleDeleteWorkspace(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  try {
    const { workspaceRegistry } = await import('../core/workspace.js')
    if (id === 'default') {
      sendJson(res, 400, { ok: false, error: 'cannot delete the default workspace' })
      return
    }
    const removed = workspaceRegistry.remove(id)
    if (!removed) {
      sendJson(res, 404, { ok: false, error: `workspace "${id}" not found` })
      return
    }
    await persistWorkspacesToConfig(
      workspaceRegistry.listFull().filter((w) => w.id !== 'default')
    )
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
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

async function handleRunJob(_req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
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

/**
 * GET /api/reminders?status=pending&limit=100
 * Returns a flat list of reminders. status filter is optional; without it
 * we only return pending — that's the 99% UI use-case (the page is a
 * "what's queued up" view, not an audit log).
 */
async function handleListReminders(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { listReminders, describeRecurrence } = await import('../core/reminders.js')
    const status = url.searchParams.get('status') as
      | 'pending' | 'firing' | 'fired' | 'cancelled' | 'failed' | null
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500)
    const rows = listReminders({ status: status ?? 'pending', limit })
    const annotated = rows.map((r) => ({
      ...r,
      recurrence_label: r.recurrence ? describeRecurrence(r.recurrence) : null,
    }))
    sendJson(res, 200, { reminders: annotated })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleCancelReminderApi(_req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) { sendJson(res, 400, { error: 'invalid id' }); return }
  try {
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

/**
 * Per-agent operational health snapshot. Drives the Health tab in /tasks.
 *
 * Combines three independent live data sources:
 *   - circuit breaker phase / cooldown remaining     (core/circuit-breaker.ts)
 *   - rate-limiter remaining tokens & config          (core/rate-limiter.ts agentLimiter)
 *   - latency p50 / p95 / p99 + invocation totals     (core/metrics.ts snapshot)
 *
 * No persistence — pure read of in-memory state. Cheap to call (<1 ms for
 * a typical agent fleet) so the page is happy to poll on a 5 s tick.
 */
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

/**
 * List every currently-pending HITL approval across all sessions /
 * platforms. Used by the global Approvals tab in /tasks so the operator
 * can see at a glance whether something is waiting on a y/n that nobody
 * is around to give.
 */
async function handleListApprovals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { approvalBus } = await import('../core/approval-bus.js')
    const pending = approvalBus.listPending()
    const metrics = approvalBus.getMetrics()
    sendJson(res, 200, { pending, metrics })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Resolve an approval by reqId (admin / dashboard path). Body:
 *   { behavior: 'allow' | 'deny', autoAllowFurther?: boolean, message?: string }
 *
 * Uses resolvePendingByReqId for precise targeting — avoids the FIFO head
 * ambiguity when multiple approvals are queued on the same thread.
 */
async function handleResolveApproval(req: IncomingMessage, res: ServerResponse, reqId: string): Promise<void> {
  try {
    const body = await readBody(req, res)
    let parsed: { behavior?: string; autoAllowFurther?: boolean; message?: string }
    try { parsed = JSON.parse(body) as typeof parsed } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      return
    }
    if (parsed.behavior !== 'allow' && parsed.behavior !== 'deny') {
      sendJson(res, 400, { ok: false, error: 'behavior must be "allow" or "deny"' })
      return
    }
    const { approvalBus } = await import('../core/approval-bus.js')
    const decision = parsed.behavior === 'allow'
      ? { behavior: 'allow' as const, autoAllowFurther: parsed.autoAllowFurther === true }
      : { behavior: 'deny' as const, message: parsed.message || 'denied via dashboard' }
    const resolved = approvalBus.resolvePendingByReqId(reqId, decision)
    if (!resolved) {
      sendJson(res, 404, { ok: false, error: 'Approval not pending (may have already resolved or timed out)' })
      return
    }
    sendJson(res, 200, { ok: true, resolved })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Hard cap on file content we'll ship over the wire — avoids OOM and keeps
 *  the browser responsive. Matches the soft limit our log-tail endpoints use. */
const WORKSPACE_FILE_MAX_BYTES = 1 * 1024 * 1024
/** Bytes scanned for a binary heuristic. Null byte in this window → binary. */
const BINARY_PROBE_BYTES = 8 * 1024

/**
 * Resolve a user-supplied path under a workspace base and verify that the
 * *real* filesystem path (after symlink resolution) still lives under `base`.
 * Returns the validated real path, or null + sends an error response.
 */
async function validateWorkspacePath(
  base: string,
  userPath: string,
  res: ServerResponse,
): Promise<string | null> {
  const target = resolvePath(base, userPath)
  if (target !== base && !target.startsWith(base + pathSep)) {
    sendJson(res, 400, { error: 'Path escapes workspace root' })
    return null
  }
  let real: string
  try {
    real = await realpath(target)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Not found', path: relativePath(base, target) })
      return null
    }
    throw err
  }
  const realBase = await realpath(base)
  if (real !== realBase && !real.startsWith(realBase + pathSep)) {
    sendJson(res, 403, { error: 'Path resolves outside workspace root (symlink escape)' })
    return null
  }
  return real
}

/**
 * Read-only view of `~/.im-hub-workspaces/<agent>/`. The Files tab in /tasks
 * uses it to inspect what an IM-context agent is reading and writing into its
 * pinned workspace (CLAUDE.md, AGENTS.md, scratch notes, etc.).
 *
 * Query params:
 *   agent — required, MUST match a registered agent name. We reject anything
 *           else to keep `agent` from sneaking traversal segments past the
 *           join (e.g. `?agent=../../etc`).
 *   path  — optional relative path under the agent's workspace. Defaults to ''.
 *
 * Response shape:
 *   { type:'dir', entries:[{name,isDir,size,mtime}] }
 *   { type:'file', content, size, encoding:'utf-8'|'base64', truncated }
 *
 * Path-traversal defense: after `resolvePath(base, userPath)` we verify the
 * result is exactly `base` or starts with `base + sep`. A `..`-laden path
 * collapses outside the base and gets rejected before any read.
 *
 * Edits / writes intentionally not exposed; ops use plain ssh.
 */
async function handleWorkspaceFiles(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const agent = url.searchParams.get('agent') || ''
    const userPath = url.searchParams.get('path') || ''

    if (!agent) {
      sendJson(res, 400, { error: 'Missing required ?agent=' })
      return
    }
    // Whitelist agent against the registry. Even an empty registry won't
    // expose anything because a non-registered name fails this check.
    const known = new Set(registry.listAgents())
    if (!known.has(agent)) {
      sendJson(res, 404, { error: `Unknown agent "${agent}"` })
      return
    }

    const { defaultAgentCwd } = await import('../core/agent-cwd.js')
    const base = resolvePath(defaultAgentCwd(agent))
    const target = await validateWorkspacePath(base, userPath, res)
    if (!target) return

    const st = await stat(target)

    if (st.isDirectory()) {
      const realBase = await realpath(base)
      const names = await readdir(target)
      const entries = await Promise.all(names.map(async (name) => {
        try {
          const childPath = join(target, name)
          let childReal: string
          try {
            childReal = await realpath(childPath)
          } catch {
            return { name, isDir: false, size: null, mtime: null, broken: true }
          }
          if (childReal !== realBase && !childReal.startsWith(realBase + pathSep)) {
            return { name, isDir: false, size: null, mtime: null, symlink_escape: true }
          }
          const sub = await stat(childPath)
          return {
            name,
            isDir: sub.isDirectory(),
            size: sub.isDirectory() ? null : sub.size,
            mtime: sub.mtime.toISOString(),
          }
        } catch {
          return { name, isDir: false, size: null, mtime: null, broken: true }
        }
      }))
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      sendJson(res, 200, {
        type: 'dir',
        agent,
        path: relativePath(base, target),
        base,
        entries,
      })
      return
    }

    if (!st.isFile()) {
      sendJson(res, 400, { error: 'Not a regular file' })
      return
    }

    const truncated = st.size > WORKSPACE_FILE_MAX_BYTES
    let buf: Buffer
    if (truncated) {
      const fd = await open(target, 'r')
      try {
        buf = Buffer.alloc(WORKSPACE_FILE_MAX_BYTES)
        const { bytesRead } = await fd.read(buf, 0, WORKSPACE_FILE_MAX_BYTES, 0)
        buf = buf.subarray(0, bytesRead)
      } finally {
        await fd.close()
      }
    } else {
      buf = await readFile(target)
    }
    const probe = buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES))
    const isBinary = probe.includes(0)
    sendJson(res, 200, {
      type: 'file',
      agent,
      path: relativePath(base, target),
      size: st.size,
      mtime: st.mtime.toISOString(),
      encoding: isBinary ? 'base64' : 'utf-8',
      content: isBinary ? buf.toString('base64') : buf.toString('utf-8'),
      truncated,
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Inline edit of a workspace file. UI use-case: annotate the agent's
 * CLAUDE.md / AGENTS.md / scratch notes from the dashboard without
 * shelling into the host.
 *
 * Body: { content: string }   — UTF-8 text only (binary writes refused).
 * Response: { ok: true, size, mtime } on success.
 *
 * Safety:
 * - Same agent + path traversal guards as the GET handler.
 * - 1 MiB hard cap on `content` (matches the read cap so a roundtrip
 *   edit can't grow a file beyond what the read can show).
 * - Atomic write: stage to `<target>.tmp.<rand>` then `rename` so a
 *   crash mid-write can't leave a half-truncated file. The .tmp file
 *   is unlinked on any error path.
 * - Refuses to overwrite a directory; refuses to create a parent dir
 *   that doesn't exist (no implicit mkdir-p — keeps surprises out).
 */
async function handleWorkspaceFileWrite(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const agent = url.searchParams.get('agent') || ''
    const userPath = url.searchParams.get('path') || ''

    if (!agent) {
      sendJson(res, 400, { error: 'Missing required ?agent=' })
      return
    }
    if (!userPath) {
      sendJson(res, 400, { error: 'Missing required ?path=' })
      return
    }
    const known = new Set(registry.listAgents())
    if (!known.has(agent)) {
      sendJson(res, 404, { error: `Unknown agent "${agent}"` })
      return
    }

    const { defaultAgentCwd } = await import('../core/agent-cwd.js')
    const base = resolvePath(defaultAgentCwd(agent))

    // For writes, the file may not yet exist so realpath would fail.
    // Validate the parent directory via realpath and verify the logical
    // path stays under base as a prefix check.
    const logicalTarget = resolvePath(base, userPath)
    if (logicalTarget !== base && !logicalTarget.startsWith(base + pathSep)) {
      sendJson(res, 400, { error: 'Path escapes workspace root' })
      return
    }
    if (logicalTarget === base) {
      sendJson(res, 400, { error: 'Cannot overwrite workspace root' })
      return
    }
    // Verify the parent directory resolves inside the workspace.
    const parentDir = dirname(logicalTarget)
    try {
      const realParent = await realpath(parentDir)
      const realBase = await realpath(base)
      if (realParent !== realBase && !realParent.startsWith(realBase + pathSep)) {
        sendJson(res, 403, { error: 'Parent path resolves outside workspace root (symlink escape)' })
        return
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        sendJson(res, 400, { error: 'Parent directory does not exist' })
        return
      }
      throw err
    }
    // If the file itself already exists, ensure its real path is inside too.
    try {
      const realTarget = await realpath(logicalTarget)
      const realBase = await realpath(base)
      if (realTarget !== realBase && !realTarget.startsWith(realBase + pathSep)) {
        sendJson(res, 403, { error: 'Path resolves outside workspace root (symlink escape)' })
        return
      }
    } catch {
      // ENOENT is fine — the file doesn't exist yet
    }
    const target = logicalTarget

    const body = await readBody(req, res)
    let parsed: { content?: unknown }
    try { parsed = JSON.parse(body) as typeof parsed } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    if (typeof parsed.content !== 'string') {
      sendJson(res, 400, { error: 'content must be a string' })
      return
    }
    const content = parsed.content
    // Encode early so the size check is on bytes, not chars (a single
    // CJK char is 3 bytes UTF-8 — char-count would lie about file size).
    const buf = Buffer.from(content, 'utf-8')
    if (buf.length > WORKSPACE_FILE_MAX_BYTES) {
      sendJson(res, 413, { error: 'Content exceeds 1 MiB cap' })
      return
    }
    // Reject content that contains a NUL byte. UTF-8 text never has one;
    // accidental binary upload here would corrupt the editor on next read.
    if (buf.includes(0)) {
      sendJson(res, 400, { error: 'NUL byte in content — only UTF-8 text accepted' })
      return
    }

    // Existing-target guards: must not be a directory; parent dir must
    // exist (no implicit mkdir-p — too easy to typo a deep path and
    // create a hidden mess).
    try {
      const st = await stat(target)
      if (st.isDirectory()) {
        sendJson(res, 400, { error: 'Target is a directory' })
        return
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
      // Doesn't exist yet — that's fine for new-file writes, but the
      // parent directory must be present.
      const parent = dirname(target)
      try {
        const ps = await stat(parent)
        if (!ps.isDirectory()) {
          sendJson(res, 400, { error: 'Parent path is not a directory' })
          return
        }
      } catch {
        sendJson(res, 400, { error: 'Parent directory does not exist' })
        return
      }
    }

    // Atomic write. crypto.randomBytes is the cheapest unique suffix and
    // already imported up top.
    const tmp = `${target}.tmp.${randomBytes(6).toString('hex')}`
    try {
      await writeFile(tmp, buf, { mode: 0o600 })
      await rename(tmp, target)
    } catch (err) {
      try { await unlink(tmp) } catch { /* tmp may not have been created */ }
      throw err
    }

    const finalSt = await stat(target)
    sendJson(res, 200, {
      ok: true,
      agent,
      path: relativePath(base, target),
      size: finalSt.size,
      mtime: finalSt.mtime.toISOString(),
    })
  } catch (err) {
    const e = err as Error & { handled?: boolean; statusCode?: number }
    if (e?.handled) return
    if (!res.headersSent) sendJson(res, e?.statusCode || 500, { error: e instanceof Error ? e.message : String(err) })
  }
}

/**
 * Run cancel/run across an array of job ids in one request. Saves N round
 * trips when the user multi-selects a long list in the Jobs tab.
 *
 * Body: { ids: number[] }
 * Response: { results: Array<{ id, ok, error?, traceId? }> }
 *
 * Per-id failures don't fail the whole request — each entry carries its own
 * status so the UI can mark partial success.
 */
async function handleBatchJob(
  req: IncomingMessage,
  res: ServerResponse,
  action: 'cancel' | 'run',
  defaultAgent?: string,
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
        return { id, ok: true, traceId }
      } catch (err) {
        return { id, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }))

    // defaultAgent isn't used directly — runJob reads job.agent — but we
    // accept it to keep the call-site symmetric with handleInvoke.
    void defaultAgent
    sendJson(res, 200, { results })
  } catch (err) {
    const e = err as Error & { handled?: boolean; statusCode?: number }
    if (e?.handled) return
    if (!res.headersSent) sendJson(res, e?.statusCode || 500, { error: e instanceof Error ? e.message : String(err) })
  }
}

/**
 * Server-Sent Events stream for real-time dashboard updates. Subscribes
 * to the in-process event-bus and forwards every event as an SSE frame.
 *
 * On connect we replay the last ~200 events from the bus's recent ring
 * so a freshly-opened tab doesn't have to wait for the next event to
 * have any context.
 *
 * Heartbeats every 25 s — Node's default keepalive isn't enough for some
 * proxies (nginx default is 60s idle close, browsers reconnect EventSource
 * automatically but we'd rather avoid the churn).
 *
 * Token-gated like every other /api endpoint via the upstream guard.
 */
async function handleEventsSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { eventBus } = await import('../core/event-bus.js')
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // Tell the client what we count as "now" so it can disambiguate replay
  // from live events.
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`)

  // Replay recent buffer.
  for (const e of eventBus.getRecent()) {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  }

  const onEvent = (e: import('../core/event-bus.js').ImhubEvent): void => {
    try {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    } catch {
      // Likely socket closed. The 'close' handler below will clean up;
      // swallow here so a downstream listener error doesn't propagate.
    }
  }
  eventBus.on('event', onEvent)

  // Periodic keepalive comment so proxies don't close idle connections.
  // SSE comments start with ':' and are ignored by EventSource clients.
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
  return `${value.slice(0, 2)}****${value.slice(-2)}`
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
async function sendSessionHistory(ws: WebSocket, clientId: string, _defaultAgent: string): Promise<void> {
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
 * Serve HTML pages with security headers. Token is no longer injected —
 * the browser authenticates via httpOnly session cookie set at /login.
 */
function servePageHtml(res: ServerResponse, filePath: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  const html = readFileSync(filePath, 'utf-8')
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
