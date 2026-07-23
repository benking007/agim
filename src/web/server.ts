// Web chat server — HTTP + WebSocket for browser-based agent interaction

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseMessage, routeMessage, type RouteContext } from '../core/router.js'
import { sessionManager } from '../core/session.js'
import { registry } from '../core/registry.js'
import { getDefaultAgent } from '../core/live-config.js'
import { expandInlineChannelReply, needsFullInlineDelivery } from '../core/inline-delivery.js'
import { defaultAgentCwd, resolveAgentCwd } from '../core/agent-cwd.js'
import { generateTraceId, createLogger, logger as rootLogger, sanitizeUserText } from '../core/logger.js'
import { isMasked, maskSecret } from './env-mask.js'
import { handleLlmApi } from './llm-api.js'
import { handleMcpApi } from './mcp-api.js'
import { handleBackgroundTasksApi } from './background-tasks-api.js'
import { handleAgimSkillsApi } from './agim-skills-api.js'
import { handleConfigApi } from './config-api.js'
import { handleMemoryApi } from './memory-api.js'
import { handleChatMediaApi } from './chat-media-api.js'
import { handleServiceApi } from './service-api.js'
import { handleJobsApi } from './jobs-api.js'
import { handleEnvApi } from './env-api.js'
import { createSerialQueue } from './serial-queue.js'
import { handleWorkspacesApi } from './workspaces-api.js'
import { handleWorkspaceFilesApi } from './workspace-files-api.js'
import { handleMessengersApi } from './messengers-api.js'
import { handleViewerApi } from './viewer-api.js'
import { handleOutboxA2AApi } from './outbox-a2a-api.js'
import { handleHealthApi, handleHealth } from './health-api.js'
import { handleApprovalsApi } from './approvals-api.js'
import { handleSearchApi } from './search-api.js'
import { handleWorkspaceSkillsApi } from './workspace-skills-api.js'
import { handleMemosApi, handleLocInfo, handleLocPost } from './memos-api.js'
import {
  readBody,
  sendJson,
  sendError,
} from './http-utils.js'
import {
  checkAuth,
  requireAdmin,
  extractToken,
  verifyTokenSync,
  isTrustedLoopbackPeer,
  bindTokenModule,
  isEnvOff,
  _tokenModule,
} from './auth.js'

const webLog = rootLogger.child({ component: 'web' })

/**
 * Module-level reference to the button-callback handler that approval-router
 * registers on our synthetic web messenger. The WS message switch dispatches
 * `approval-action` AND `choice-action` events through it: approval-router is
 * the unified button dispatcher and already routes both `apv:` (approvals)
 * and `ask:` (ask_user choice cards) callbacks, so a single handler covers
 * both card types — same path as a Telegram inline-button tap. Set by the web
 * messenger's `onButtonCallback`; remains undefined until approval-router
 * installs (which happens before this file's exported startWebServer is
 * called from cli.ts).
 */
let webButtonHandler: ((cb: import('../core/types.js').ButtonCallback) => Promise<void>) | undefined

import {
  formatAgentNotAvailableError,
  isAgentAvailableCached,
} from '../core/onboarding.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')
const DEFAULT_PORT = 3000

// isMasked + maskSecret extracted to ./env-mask.ts so the bun unit
// suite can verify maskSecret() round-trips through isMasked() — the
// pre-R9 regex didn't, leaving a "lockout via masked-echo" gap.

interface ClientConnection {
  ws: WebSocket
  id: string
  agent: string
}

/** In-flight web chat runs — Stop button aborts the matching controller. */
const webRunAborts = new Map<string, AbortController>()

const USER_INTERRUPTED_TEXT = '用户打断了执行'

function formatWebAgentUnavailableMessage(agentName: string): string {
  if ((agentName === 'native' || agentName === 'agim')) {
    return [
      'Agim Agent is not configured yet.',
      '请粘贴 DeepSeek API Key 一键启用（也可切换其他厂商），或到 /settings/llm 配置。',
    ].join(' ')
  }
  return formatAgentNotAvailableError(agentName)
}

export { createSerialQueue } from './serial-queue.js'
export { __webAuthForTesting } from './auth.js'

/**
 * Start the web chat server
 */
async function assertPortCanListen(port: number, bindHost: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createNetServer()
    const cleanup = (): void => {
      probe.off('error', onError)
      probe.off('listening', onListening)
    }
    const onError = (err: Error): void => {
      cleanup()
      try { probe.close() } catch { /* not listening */ }
      reject(err)
    }
    const onListening = (): void => {
      cleanup()
      probe.close(() => resolve())
    }
    probe.once('error', onError)
    probe.once('listening', onListening)
    try {
      probe.listen(port, bindHost)
    } catch (err) {
      cleanup()
      try { probe.close() } catch { /* not listening */ }
      reject(err)
    }
  })
}

export async function startWebServer(options: {
  port?: number
  defaultAgent: string
}): Promise<{ close: () => void; port: number }> {
  const port = options.port || DEFAULT_PORT
  const bindHost = process.env.AGIM_WEB_BIND || '127.0.0.1'
  await assertPortCanListen(port, bindHost)
  const clients = new Map<string, ClientConnection>()
  // R9: threadId → tokenId ownership. A WS peer claims a threadId on
  // first connection (verifyClient already verified the token); later
  // `get-history { threadId }` rekey requests must come from a peer
  // holding the same tokenId, otherwise an authenticated operator could
  // adopt and wipe another operator's session. Persisted to
  // ~/.agim/web-thread-owners.json so a process restart cannot reset
  // first-claim and let another token hijack a thread.
  const { webThreadOwners: threadOwners } = await import('../core/web-thread-owners.js')

  // v1.1.10+: token-based auth for the web console.
  // ─ loopback peers (127.0.0.1 / ::1) bypass auth (local CLI / curl)
  // ─ public viewer pages (/v/:id, /loc, /l/<token>) remain public
  // ─ AGIM_WEB_AUTH=off disables the gate entirely (for ops with proxy auth)
  // On first start, bootstrapIfEmpty() generates a one-time bootstrap token
  // and writes the raw value to ~/.agim/web-bootstrap-token (chmod 600).
  // Retrieve with `agim token bootstrap` — never logged to journald (R13).
  const accessTokenModule = await import('../core/access-token.js')
  bindTokenModule(accessTokenModule)
  const { bootstrapIfEmpty, isAuthEnabled } = accessTokenModule
  try { bootstrapIfEmpty() } catch (err) {
    webLog.warn({ event: 'web.auth_bootstrap_failed', err: String(err) })
  }
  const isPublicBind = bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost'
  if (isPublicBind && !isAuthEnabled()) {
    webLog.warn({
      event: 'web.auth_disabled_on_public_bind',
      bind: bindHost,
    }, 'AGIM_WEB_AUTH=off + public bind — auth deliberately off, ensure your reverse proxy handles access control')
  }
  // R13 C2 — when binding to a non-loopback address, the operator
  // almost certainly intends to put a TLS-terminating reverse proxy
  // in front of agim. We can't reliably detect from inside whether
  // that's been done (X-Forwarded-Proto could be forged), so we
  // surface a one-time banner + audit row at boot. Suppress with
  // AGIM_WEB_TLS_ACK=1 for the operator who's already done the
  // checklist and wants quiet logs.
  if (isPublicBind && process.env.AGIM_WEB_TLS_ACK !== '1') {
    const banner = [
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `⚠️  WEB SERVER BOUND TO ${bindHost}:${port} (non-loopback)`,
      '',
      '   Tokens travel as Bearer headers / cookies — if any leg between',
      '   client and agim is HTTP, they go on the wire in cleartext.',
      '   Confirm a TLS-terminating reverse proxy fronts this listener',
      '   (nginx, caddy, traefik, k8s ingress, …) before exposing it to',
      '   any network you do not control.',
      '',
      '   Silence this banner once your terminator is verified:',
      '       AGIM_WEB_TLS_ACK=1',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ].join('\n')
    process.stdout.write(banner)
    webLog.warn({
      event: 'web.public_bind_no_tls_ack',
      bind: bindHost,
      port,
    }, `non-loopback bind without AGIM_WEB_TLS_ACK=1 — confirm reverse-proxy TLS termination`)
    try {
      void (async () => {
        const { logAuditEvent } = await import('../core/audit-log.js')
        logAuditEvent({
          eventType: 'config.put',
          actor: 'system',
          target: 'web.bind',
          outcome: 'ok',
          details: { bind: bindHost, port, tls_ack: false },
        })
      })()
    } catch { /* best-effort */ }
  }
  webLog.info({
    event: 'web.auth_mode',
    bind: bindHost,
    enabled: isAuthEnabled(),
    trustLoopback: !isEnvOff('AGIM_TRUST_LOOPBACK'),
  }, `Web console auth: ${isAuthEnabled() ? 'token-gated' : 'disabled (AGIM_WEB_AUTH=off)'}`)

  // HTTP request handler — static files + REST API
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // ─── v1.1.10 auth gate ───────────────────────────────────────────
    // Always run first so unauthenticated requests never reach handlers.
    // Loopback peers + the public paths below bypass.
    if (!checkAuth(req, res, url)) return

    // v1.2.72 — SPA is the only web admin. The retired v1 HTML admin
    // bundle and the old `AGIM_WEB_V2` gate are gone; this branch serves
    // SPA assets and falls back to `index.html` for client-side routes.
    //
    // Without it a fresh install hits a white screen because
    // `<script src="/assets/…js">` 404s — no other handler claims that path.
    if (req.method === 'GET') {
      const p = url.pathname
      const isApi = p.startsWith('/api/')
      const isWs = p.startsWith('/ws')
      const isSse = p === '/events'
      const isVendor = p.startsWith('/vendor/')
      const isPublicSsr = p === '/loc' || p === '/loc.html' || p.startsWith('/l/') || p.startsWith('/v/')
      // v1.2.129 — /m/login is a static HTML handed back below; don't let
      // the SPA fallback swallow it (the SPA can't auto-submit the token).
      const isMobileLogin = p === '/m/login' || p === '/m/login.html'
      if (!isApi && !isWs && !isSse && !isVendor && !isPublicSsr && !isMobileLogin) {
        // SPA static asset (assets/index-xxx.js, /manifest.webmanifest,
        // /favicon.svg) → return the file if it exists in PUBLIC_DIR.
        // Otherwise fall back to /index.html so the router handles it.
        const trimmed = p.replace(/^\//, '')
        const candidate = join(PUBLIC_DIR, trimmed)
        if (trimmed && existsSync(candidate) && !candidate.endsWith('.html')) {
          // Best-effort content-type guess; serveStatic handles binary
          // + sets cache headers.
          const ct =
            candidate.endsWith('.js')    ? 'application/javascript; charset=utf-8' :
            candidate.endsWith('.css')   ? 'text/css; charset=utf-8' :
            candidate.endsWith('.svg')   ? 'image/svg+xml' :
            candidate.endsWith('.webmanifest') ? 'application/manifest+json' :
            candidate.endsWith('.json')  ? 'application/json; charset=utf-8' :
            candidate.endsWith('.woff2') ? 'font/woff2' :
            candidate.endsWith('.woff')  ? 'font/woff' :
            candidate.endsWith('.ttf')   ? 'font/ttf' :
            candidate.endsWith('.otf')   ? 'font/otf' :
            'application/octet-stream'
          const isFont = candidate.endsWith('.woff2') || candidate.endsWith('.woff')
            || candidate.endsWith('.ttf') || candidate.endsWith('.otf')
          return serveStatic(res, candidate, ct, isFont
            ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
            : undefined)
        }
        return servePageHtml(res, join(PUBLIC_DIR, 'index.html'))
      }
      // Falls through to API / WS / SSR-page handlers below.
    }

    // M4: /api/health is intentionally public (k8s liveness probe friendly)
    // — declare it BEFORE the /api/* token gate so callers don't need to
    // know the web token. Returns only operational status, not config.
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return handleHealth(req, res)
    }


    // v1.1.10 — auth endpoints. /login is a public path; the auth gate
    // above lets it through. These do the actual validation + cookie set.
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      return handleAuthLogin(req, res)
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      return handleAuthLogout(req, res)
    }
    if (url.pathname === '/login' && req.method === 'GET') {
      return serveStatic(res, join(PUBLIC_DIR, 'login.html'), 'text/html; charset=utf-8')
    }
    // v1.2.129 — mobile QR landing. Static page reads ?t=<raw>, POSTs
    // to /api/auth/login, then redirects to ?next=/m/chat. Public so the
    // scanner doesn't bounce through /login first.
    if ((url.pathname === '/m/login' || url.pathname === '/m/login.html') && req.method === 'GET') {
      return serveStatic(res, join(PUBLIC_DIR, 'm', 'login.html'), 'text/html; charset=utf-8')
    }

    // v1.2.3 — vendored third-party assets (Chart.js etc). Whitelist by
    // filename pattern to keep the static surface tight. Public on
    // purpose — no auth gate (third-party libs aren't secrets).
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      const fname = url.pathname.slice('/vendor/'.length)
      // Only allow plain filenames (no traversal, no nested dirs).
      if (!/^[A-Za-z0-9._-]+\.(js|css|map)$/.test(fname)) {
        res.statusCode = 404
        res.end('vendor file not whitelisted')
        return
      }
      const ct = fname.endsWith('.css') ? 'text/css; charset=utf-8'
        : fname.endsWith('.map') ? 'application/json; charset=utf-8'
        : 'application/javascript; charset=utf-8'
      return serveStatic(res, join(PUBLIC_DIR, 'vendor', fname), ct)
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

    // v1.2 — Viewer: rendered markdown for long IM messages. URL is
    // unguessable uuidv4; same trust model as /loc (public-on-purpose,
    // operator fronts the web with their reverse proxy / tunnel).
    // Content stays in ~/.agim/viewer.db on this host — the public URL
    // is just a proxy back to here. See src/core/viewer-local.ts.
    if (url.pathname.match(/^\/v\/([0-9a-f-]{8,})$/i) && req.method === 'GET') {
      const handled = await handleViewerApi(req, res, url)
      if (handled) return
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
      return handleLocInfo(req, res, url)
    }

    if (url.pathname === '/api/loc' && req.method === 'POST') {
      return handleLocPost(req, res)
    }

    // REST API — authenticated via checkAuth above. Mutating / sensitive
    // read surfaces additionally require admin (role=user tokens from
    // mobile QR must not enumerate jobs, config, or other operators' data).

    // Config + agent status + ACP endpoints (admin guards are inside the dispatcher).
    if (url.pathname === '/api/config'
        || url.pathname === '/api/agents/status'
        || url.pathname.startsWith('/api/agents/acp/')) {
      const handled = await handleConfigApi(req, res, url)
      if (handled) return
    }

    // Jobs, bgjobs, subtasks, schedules, reminders, plans
    if (url.pathname === '/api/jobs' || url.pathname.startsWith('/api/jobs/')
        || url.pathname === '/api/bgjobs' || url.pathname.startsWith('/api/bgjobs/')
        || url.pathname === '/api/subtasks'
        || url.pathname === '/api/schedules'
        || url.pathname === '/api/reminders' || url.pathname.startsWith('/api/reminders/')
        || url.pathname === '/api/plans') {
      if (await handleJobsApi(req, res, url)) return
    }

    // /api/memos — search / list / delete.
    if (url.pathname === '/api/memos' || url.pathname.startsWith('/api/memos/')) {
      if (await handleMemosApi(req, res, url)) return
    }

    // /api/env + /api/security/diagnostics — env var management + security badges.
    if (url.pathname === '/api/env' || url.pathname === '/api/security/diagnostics') {
      if (await handleEnvApi(req, res, url)) return
    }
    // v1.2.126 — web_search provider introspection + ping.
    if (url.pathname.startsWith('/api/search/')) {
      if (await handleSearchApi(req, res, url)) return
    }
    // Speech-to-text provider list / whisper model init (admin guards inside dispatcher).
    // Health, metrics, audit, SSE, mobile QR.
    if (url.pathname === '/api/metrics'
        || url.pathname === '/api/audit'
        || url.pathname === '/api/audit/events'
        || url.pathname.startsWith('/api/health/')
        || url.pathname === '/api/agent-health'
        || url.pathname === '/events'
        || url.pathname === '/api/mobile/qr') {
      if (await handleHealthApi(req, res, url)) return
    }
    // Chat media / STT / feedback (admin guards applied inside dispatcher per route).
    if (url.pathname.startsWith('/api/chat/') || url.pathname.startsWith('/api/stt/')) {
      const handled = await handleChatMediaApi(req, res, url)
      if (handled) return
    }
    // Workspace CRUD — GET/POST /api/workspaces, PATCH/DELETE /api/workspaces/:id
    if (url.pathname === '/api/workspaces' || url.pathname.startsWith('/api/workspaces/')) {
      if (await handleWorkspacesApi(req, res, url)) return
    }
    // v1.1.2 — Outbox tab + v1.1.3 A2A tab + Artifacts.
    if (url.pathname.startsWith('/api/outbox')
        || url.pathname.startsWith('/api/a2a/')
        || url.pathname.startsWith('/api/artifacts/')) {
      if (await handleOutboxA2AApi(req, res, url)) return
    }
    // v1.2 — Viewer pastes (long markdown stash for IM short-link replies).
    if (url.pathname === '/api/viewer'
        || url.pathname === '/api/viewer/tunnel'
        || url.pathname.startsWith('/api/viewer/')) {
      if (await handleViewerApi(req, res, url)) return
    }
    // v1.5/v1.6 — Memory + vector admin (admin guards applied inside dispatcher per route).
    if (url.pathname.startsWith('/api/memory/')) {
      const handled = await handleMemoryApi(req, res, url)
      if (handled) return
    }
    // v1.2.3 — Skills browser (locally-installed claude/opencode skills).
    if (url.pathname === '/api/skills'
        || url.pathname === '/api/skills/remote/hot'
        || url.pathname.startsWith('/api/skills/')) {
      if (await handleWorkspaceSkillsApi(req, res, url)) return
    }
    // PR-B: HITL approvals — global pending list + per-reqId resolve.
    if (url.pathname === '/api/approvals' || url.pathname.startsWith('/api/approvals/')) {
      if (await handleApprovalsApi(req, res, url)) return
    }
    // PR-D: Agent workspace file browser.
    if (url.pathname === '/api/workspace-files') {
      if (await handleWorkspaceFilesApi(req, res, url)) return
    }
    // Stage 4 — native LLM backend admin. GET is open (no secret
    // VALUES surfaced — only source); writes require admin.
    if (url.pathname === '/api/llm' || url.pathname.startsWith('/api/llm/')) {
      const writeMethod = req.method !== 'GET'
      if (writeMethod && !requireAdmin(req, res)) return
      const handled = await handleLlmApi(req, res, url)
      if (handled) return
    }
    // Stage 6 — external MCP servers admin. Headers may contain bearer
    // tokens; require admin even on GET.
    if (url.pathname === '/api/mcp' || url.pathname.startsWith('/api/mcp/')) {
      if (!requireAdmin(req, res)) return
      const handled = await handleMcpApi(req, res, url)
      if (handled) return
    }
    // P1 follow-up — admin overview of the three per-thread background
    // primitives (heartbeat bindings / goals / pending asks). Cross-
    // thread, user-typed content — require admin on every method.
    if (url.pathname.startsWith('/api/heartbeat/')
        || url.pathname === '/api/goals' || url.pathname.startsWith('/api/goals/')
        || url.pathname.startsWith('/api/asks/')) {
      if (!requireAdmin(req, res)) return
      const handled = await handleBackgroundTasksApi(req, res, url)
      if (handled) return
    }
    // P1 follow-up — agim skills editor (SKILL.md CRUD). Mutations stay
    // admin-gated (bodies inject into every agent prompt). GET list/detail
    // are readable by any authenticated peer so Portal `/` skill picker works.
    if (url.pathname === '/api/agim-skills' || url.pathname.startsWith('/api/agim-skills/')) {
      const method = (req.method || 'GET').toUpperCase()
      if (method !== 'GET' && !requireAdmin(req, res)) return
      const handled = await handleAgimSkillsApi(req, res, url)
      if (handled) return
    }
    // WeChat QR login, allowlist, notify, invoke, email test.
    if (url.pathname.startsWith('/api/messengers/')
        || url.pathname === '/api/admin-allowlist'
        || url.pathname === '/api/notify'
        || url.pathname === '/api/invoke') {
      if (await handleMessengersApi(req, res, url, getDefaultAgent(options.defaultAgent))) return
    }

    // Service management — status / log-tail / start / stop / restart.
    if (url.pathname.startsWith('/api/service/')) {
      if (await handleServiceApi(req, res, url)) return
    }


    res.writeHead(404)
    res.end('Not found')
  })

  // WebSocket server with auth + same-origin gate. Before R9 the WS
  // upgrade event bypassed checkAuth entirely (the upgrade path isn't
  // a normal HTTP request handler), leaving every chat / approval-card
  // socket open to anyone reachable on the port. verifyClient runs the
  // same token check as the REST path and locks Origin to the request's
  // host so a third-party page can't open a cross-site WS.
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, cb) => {
      // R13 A4 — per-IP rate limit runs BEFORE auth so an attacker
      // hammering verifyClient with bad tokens can't burn CPU on
      // sha256-hashing every attempt.
      const limit = checkWsIpRateLimit(info.req as IncomingMessage)
      if (!limit.ok) {
        webLog.warn({
          event: 'ws.rate_limited',
          ip: peerIp(info.req as IncomingMessage),
          reason: limit.reason,
        }, 'WS upgrade refused (per-IP rate limit)')
        return cb(false, 429, 'rate limited')
      }

      // Auth-off / trusted-loopback bypass — mirror checkAuth's two short-circuits
      // so dev / local CLI sessions still work without a token.
      if ((process.env.AGIM_WEB_AUTH || '').toLowerCase() === 'off') return cb(true)
      if (isTrustedLoopbackPeer(info.req as IncomingMessage)) return cb(true)

      // Origin check: cookie SameSite=Lax handles most of the CSWSH
      // surface, but defence-in-depth — reject when Origin's host
      // doesn't match the request Host header. Origin can be absent
      // (non-browser clients); we allow that since they can't carry a
      // browser cookie anyway and must supply Bearer.
      const origin = info.origin || info.req.headers.origin
      if (typeof origin === 'string' && origin) {
        try {
          if (new URL(origin).host !== info.req.headers.host) {
            return cb(false, 403, 'origin mismatch')
          }
        } catch {
          return cb(false, 400, 'invalid origin')
        }
      }

      // Auth: token from Authorization / Cookie / ?token=.
      try {
        const url = new URL(info.req.url || '/ws', `http://${info.req.headers.host}`)
        const tok = extractToken(info.req as IncomingMessage, url)
        const tokenId = tok ? verifyTokenSync(tok) : null
        if (!tokenId) return cb(false, 401, 'auth required')
        // Attach the verified tokenId to the request — the connection
        // handler reads it from here so we don't re-parse on every msg.
        ;(info.req as IncomingMessage & { _agimTokenId?: string })._agimTokenId = tokenId
        cb(true)
      } catch {
        cb(false, 500, 'auth error')
      }
    },
  })

  // M3: cap concurrent WS clients so a leaked / shared web token can't OOM
  // the host by opening unbounded connections. Default 100 is generous for
  // a single-user / small-team setup; production multi-tenant should set
  // AGIM_MAX_WS_CLIENTS to a higher value.
  const maxWsClients = (() => {
    const raw = process.env.AGIM_MAX_WS_CLIENTS
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n) && n > 0) return n
    }
    return 100
  })()

  // R13 A4 — per-IP rate limit. The per-token cap above protects
  // memory but not connection rate; one attacker IP with a valid
  // token can still spawn N parallel browser tabs / processes and
  // saturate the file-descriptor pool.
  //
  //   AGIM_WS_MAX_PER_IP            active connections per IP (default 20)
  //   AGIM_WS_MAX_NEW_PER_IP_PER_MIN  new connections per IP per minute (default 30)
  //
  // Trusted loopback bypasses both — local dev / CLI tooling makes many
  // short connections legitimately. Reverse-proxied loopback traffic is
  // still counted as network traffic.
  const wsMaxPerIp = (() => {
    const raw = process.env.AGIM_WS_MAX_PER_IP
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n) && n > 0) return n
    }
    return 20
  })()
  const wsMaxNewPerIpPerMin = (() => {
    const raw = process.env.AGIM_WS_MAX_NEW_PER_IP_PER_MIN
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n) && n > 0) return n
    }
    return 30
  })()
  /** Per-IP active count + recent connection timestamps for sliding-window
   *  rate limiting. We don't periodically prune unused entries — at
   *  reasonable defaults the map size is bounded by the number of distinct
   *  client IPs in any 60-second window, far below memory concerns. */
  const wsPerIp = new Map<string, { active: number; recent: number[] }>()
  function peerIp(req: IncomingMessage): string {
    return (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  }
  /** Returns {ok:true} when the IP may open a new WS, else {ok:false, reason}. */
  function checkWsIpRateLimit(req: IncomingMessage): { ok: true } | { ok: false; reason: string } {
    if (isTrustedLoopbackPeer(req)) return { ok: true }
    const ip = peerIp(req)
    if (!ip) return { ok: false, reason: 'empty peer ip' }  // defensive — matches isLoopbackPeer policy
    const now = Date.now()
    const cutoff = now - 60_000
    const slot = wsPerIp.get(ip) ?? { active: 0, recent: [] }
    slot.recent = slot.recent.filter((t) => t > cutoff)
    if (slot.active >= wsMaxPerIp) {
      return { ok: false, reason: `per-IP active cap (${slot.active}/${wsMaxPerIp})` }
    }
    if (slot.recent.length >= wsMaxNewPerIpPerMin) {
      return { ok: false, reason: `per-IP new-conn cap (${slot.recent.length}/${wsMaxNewPerIpPerMin}/min)` }
    }
    return { ok: true }
  }
  function recordWsIpOpen(req: IncomingMessage): void {
    if (isTrustedLoopbackPeer(req)) return
    const ip = peerIp(req)
    if (!ip) return
    const slot = wsPerIp.get(ip) ?? { active: 0, recent: [] }
    slot.active++
    slot.recent.push(Date.now())
    wsPerIp.set(ip, slot)
  }
  function recordWsIpClose(req: IncomingMessage): void {
    if (isTrustedLoopbackPeer(req)) return
    const ip = peerIp(req)
    if (!ip) return
    const slot = wsPerIp.get(ip)
    if (!slot) return
    slot.active = Math.max(0, slot.active - 1)
    // GC empty slots so the map doesn't grow unboundedly across the
    // lifetime of the process. A slot is "empty" iff no active conn
    // AND no recent connection within the window.
    if (slot.active === 0 && slot.recent.filter((t) => t > Date.now() - 60_000).length === 0) {
      wsPerIp.delete(ip)
    }
  }

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
    // R13 A4 — book the per-IP slot now that we know the upgrade
    // succeeded. The matching close hook decrements below.
    recordWsIpOpen(req)
    // R9: token verified at upgrade time by verifyClient; we read the
    // tokenId here so get-history can enforce ownership when the client
    // wants to rekey to a persisted threadId. 'anon' is the loopback /
    // auth-off path — still safe because those paths trust the peer.
    const tokenId =
      (req as IncomingMessage & { _agimTokenId?: string })._agimTokenId ?? 'anon'

    // R9: crypto.randomBytes(12) → 96 bits of base64url entropy
    // (~16 chars). The pre-R9 `Date.now() + Math.random().slice(2,8)`
    // gave ~30 bits and a publicly enumerable timestamp prefix — enough
    // for an authenticated peer to brute-force another live session's
    // id. With H2 ownership-by-tokenId the impact is bounded to
    // same-tokenId tabs (which is fine), but the stronger id closes the
    // pre-rekey race window.
    const clientId = `web-${randomBytes(12).toString('base64url')}`
    const client: ClientConnection = { ws, id: clientId, agent: getDefaultAgent(options.defaultAgent) }
    clients.set(clientId, client)
    // First-claim ownership: this connection's tokenId owns this
    // brand-new threadId until disconnect.
    threadOwners.set(clientId, tokenId)

    webLog.info({ clientId }, 'Client connected')

    // Send available agents list
    sendToClient(ws, {
      type: 'init',
      agents: registry.listAgents(),
      defaultAgent: getDefaultAgent(options.defaultAgent),
      clientId,
    })

    // Load existing session history if available (usually empty for a
    // freshly minted clientId; the SPA's get-history rekey is the real
    // restore path). Also replays ActiveRun when present.
    void sendSessionHistory(ws, client, getDefaultAgent(options.defaultAgent))

    const enqueueInbound = createSerialQueue()

    // v1.2.114 — approval-action clicks MUST bypass the serial queue.
    //
    // Pre-fix: every inbound WS frame went through `enqueueInbound`, which
    // serialised everything against `handleClientMessage`. A chat message
    // kicked off an agent run that could run for the full 30-min hard
    // timeout; any approval-card click during that window was QUEUED
    // behind the still-running chat handler. Result: deadlock — agent
    // waits for approval, approval waits for agent. The clicks finally
    // drained the queue at minute 30 when the agent aborted, but by then
    // the run was dead and the user's card UI had been stuck at
    // "已发送，等待结果…" the whole time.
    //
    // Fix: parse the frame inline first; if it's an `approval-action` (or a
    // `choice-action` from an ask_user card), dispatch directly to the click
    // handler (no queue). Both are the agent's UNBLOCKING input — they have no
    // ordering dependency on chat input. All other types (chat, switch-agent,
    // get-history, …) still go through enqueueInbound to preserve their
    // per-client FIFO ordering.
    async function handleButtonAction(msg: { data?: unknown; messageId?: unknown }): Promise<void> {
      const actionData: string = String(msg.data || '')
      const messageId: string = String(msg.messageId || '')
      // Use `client.id` (mutable; updated on session rekey) — not the
      // original `clientId` const — so the threadId we hand to the bus
      // matches the threadId the bus stamped on the pending request.
      // Without this, a session that was rekeyed via `get-history` reports
      // the stale id and the bus can't find the open req to resolve.
      const liveId = client.id
      webLog.info({
        event: 'button.web.click_received',
        clientId: liveId, data: actionData, messageId,
        handlerBound: !!webButtonHandler,
      })
      if (!actionData || !messageId) {
        sendToClient(ws, { type: 'error', message: 'button action missing data/messageId' })
        return
      }
      if (!webButtonHandler) {
        const why = 'button handler not bound (router not installed?). Restart agim to rebind.'
        webLog.warn({ event: 'button.web.no_handler', clientId: liveId, data: actionData, messageId }, why)
        sendToClient(ws, { type: 'error', message: why })
        return
      }
      try {
        // Web client doesn't have a platform-native toast, so ack is a
        // no-op resolving to the in-page status the page itself chose
        // to render after click. approval-router dispatches both `apv:`
        // and `ask:` data, so one handler serves approvals and asks.
        await webButtonHandler({
          data: actionData, threadId: liveId, userId: `web:${liveId}`,
          userDisplay: 'Web', messageId, ack: async () => {},
        })
        webLog.info({ event: 'button.web.click_resolved', clientId: liveId, data: actionData })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        webLog.error({ event: 'button.web.click_failed', clientId: liveId, data: actionData, err: errMsg })
        sendToClient(ws, { type: 'error', message: `Button click failed: ${errMsg}` })
      }
    }

    ws.on('message', (data: Buffer) => {
      // Parse once, here, so we can route approval-action around the
      // serial queue. Bad JSON falls through to the error branch below
      // (we still need to surface a parse error to the client).
      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch (err) {
        webLog.error({ clientId: client.id, err: err instanceof Error ? err.message : String(err) }, 'Error parsing client message')
        sendToClient(ws, { type: 'error', message: 'Invalid message format' })
        return
      }
      const msgType = msg && typeof msg === 'object' ? (msg as { type?: unknown }).type : undefined
      if (msgType === 'approval-action' || msgType === 'choice-action') {
        // Fast path — bypass enqueueInbound. Errors are surfaced to the
        // client inside handleButtonAction.
        void handleButtonAction(msg as { data?: unknown; messageId?: unknown })
        return
      }
      if (msgType === 'stop') {
        // Same class of bug as approval-action (v1.2.114): the chat
        // handler awaits the full agent run, so a queued `stop` never
        // reaches webRunAborts.abort() until the run already ended.
        // Abort must fire immediately while the run is in flight.
        const liveId = client.id
        const ac = webRunAborts.get(liveId)
        if (!ac) {
          sendToClient(ws, { type: 'error', message: '当前没有正在执行的任务' })
          return
        }
        ac.abort()
        return
      }
      enqueueInbound(async () => {
        try {
          // Pass an onRekey callback so handleClientMessage can keep
          // the `clients` map in sync when a browser refresh resumes
          // with its persisted threadId. Otherwise the map stays keyed
          // by the WS-assigned id, and the web messenger's outbound
          // approval-card lookup misses the live client.
          // handleClientMessage validates the message shape itself; we
          // pass the parsed value through as the typed shape it expects
          // (cast is safe because validation runs on the receiver side).
          await handleClientMessage(
            client, msg as Parameters<typeof handleClientMessage>[1],
            getDefaultAgent(options.defaultAgent),
            (oldId, newId) => {
              // Only reassign if we actually owned `oldId` — defensive
              // against the (impossible-but-cheap-to-guard) case of two
              // clients colliding on the rekey path.
              if (clients.get(oldId) === client) clients.delete(oldId)
              clients.set(newId, client)
              // R9: keep the ownership map aligned with the live id so
              // a subsequent rekey from another connection (same token,
              // e.g. a second tab) succeeds with the new threadId.
              threadOwners.rekey(oldId, newId)
            },
            tokenId,
            threadOwners,
            clients,
          )
        } catch (err) {
          webLog.error({ clientId: client.id, err: err instanceof Error ? err.message : String(err) }, 'Error in client message handler')
          sendToClient(ws, { type: 'error', message: 'Invalid message format' })
        }
      })
    })

    ws.on('close', () => {
      // Use `client.id` rather than the closure-captured `clientId` so
      // we delete whichever key the map is actually using after a
      // potential rekey. The map maintenance on rekey deletes the old
      // key, so this just covers the live one.
      const liveId = client.id
      webLog.info({ clientId: liveId }, 'Client disconnected')
      clients.delete(liveId)
      recordWsIpClose(req)  // R13 A4
      // R9: drop the ownership entry only for server-generated ids that
      // were never rekeyed to a persistent client-side threadId. Rekeyed
      // ids stay registered so the operator's next reconnect with the
      // same localStorage id finds its previous owner.
      if (liveId === clientId) threadOwners.delete(liveId)
    })

    ws.on('error', (err) => {
      const liveId = client.id
      webLog.error({ clientId: liveId, err: err instanceof Error ? err.message : String(err) }, 'Client WebSocket error')
      clients.delete(liveId)
      recordWsIpClose(req)  // R13 A4
      if (liveId === clientId) threadOwners.delete(liveId)
    })
  })

  // Default to loopback; operators can opt into LAN/public exposure with
  // AGIM_WEB_BIND=0.0.0.0 behind their firewall/reverse proxy.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.off('listening', onListening)
      try { httpServer.close() } catch { /* not listening yet */ }
      reject(err)
    }
    const onListening = (): void => {
      httpServer.off('error', onError)
      resolve()
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    try {
      httpServer.listen(port, bindHost)
    } catch (err) {
      httpServer.off('error', onError)
      httpServer.off('listening', onListening)
      try { httpServer.close() } catch { /* not listening yet */ }
      reject(err)
    }
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
    async sendChoiceCard(threadId, prompt) {
      const c = clients.get(threadId)
      const messageId = `web-card-${++cardSeq}-${Date.now().toString(36)}`
      if (c && c.ws.readyState === c.ws.OPEN) {
        sendToClient(c.ws, { type: 'choice-card', messageId, prompt })
      }
      return { messageId }
    },
    async editChoiceCard(threadId, messageId, finalText) {
      const c = clients.get(threadId)
      if (!c || c.ws.readyState !== c.ws.OPEN) return
      sendToClient(c.ws, { type: 'choice-card-edit', messageId, finalText })
    },
    onButtonCallback(handler) {
      webButtonHandler = handler
      webLog.info({ event: 'button.web.handler_bound' },
        'web messenger button-callback handler attached')
    },
  }
  registry.registerMessenger(webMessenger)
  // approval-router's install() loop bound buttonCallback only for messengers
  // registered BEFORE install. Our web messenger was just registered (after
  // install), so we wire it ourselves — otherwise in-page approval/choice
  // card clicks fire WS messages with no handler on the server side and
  // silently do nothing. approval-router is the unified dispatcher: it routes
  // `apv:` (approvals) and `ask:` (ask_user) callbacks alike, so this single
  // binding covers both card types. bindButtonHandlerForPlatform is a no-op
  // if approval-router hasn't been install()'d yet (e.g. degraded mode where
  // the bus failed to start).
  try {
    const { bindButtonHandlerForPlatform } = await import('../core/approval-router.js')
    bindButtonHandlerForPlatform('web')
    if (!webButtonHandler) {
      // bindButtonHandlerForPlatform is a silent no-op when `installed` is
      // null on the router (bus failed to start, or cli skipped install).
      // Log so an operator who's confused why card clicks don't work sees
      // a clear breadcrumb at startup.
      webLog.warn({ event: 'button.web.bind_skipped' },
        'approval-router not installed — web card clicks will fail until restart')
    }
  } catch (err) {
    webLog.warn({ event: 'button.web.bind_error', err: err instanceof Error ? err.message : String(err) },
      'web button-handler binding threw')
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
      // R14 — force-drop in-flight HTTP connections so the listening
      // port releases immediately. httpServer.close() alone only stops
      // accepting NEW connections; existing keep-alive sockets keep
      // port 3000 bound until they drain, which races a `systemctl
      // restart` and produces EADDRINUSE on the new process.
      // closeAllConnections is Node 18.2+; older runtimes get the
      // legacy (slower) behavior.
      try {
        const fn = (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections
        if (typeof fn === 'function') fn.call(httpServer)
      } catch { /* ignore */ }
    },
  }
}

// ============================================
// REST API handlers (remaining — not yet extracted to dedicated modules)
// ============================================




// ─── v1.1.10 auth handlers ───
/** Build the cookie attribute string. When the request looks HTTPS
 *  (req.socket.encrypted OR x-forwarded-proto=https from a reverse
 *  proxy / cloudflared / nginx), include `Secure`. Without `Secure`,
 *  modern Chrome / Safari downgrade or REJECT cookies with
 *  `SameSite=Strict` on HTTPS pages, which manifests as "logged in
 *  works on the same tab once, but a refresh kicks back to /login"
 *  — the symptom the operator reported 2026-05-19.
 *  Also relax SameSite=Strict → Lax so following an external link
 *  back to the dashboard doesn't lose the session. */
function buildAuthCookie(req: IncomingMessage, token: string | null, maxAgeSec: number): string {
  const isHttps = (req.socket as { encrypted?: boolean }).encrypted === true
    || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
  const secure = isHttps ? '; Secure' : ''
  const value = token === null ? '' : encodeURIComponent(token)
  // HttpOnly: SPA auth uses localStorage + Authorization; cookie is for
  // EventSource / same-origin fetches. Keep raw token out of document.cookie.
  return `agim_token=${value}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax; HttpOnly${secure}`
}

async function handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { token?: string }
    const token = (parsed.token || '').trim()
    if (!token) { sendError(res, 400, 'AUTH_TOKEN_REQUIRED', { message: 'token required' }); return }
    if (!_tokenModule) { sendError(res, 503, 'AUTH_NOT_READY', { message: 'auth module not ready' }); return }
    const id = _tokenModule.verifyToken(token)
    if (!id) { sendError(res, 401, 'AUTH_INVALID', { message: 'invalid token' }); return }
    // 30-day cookie. SameSite=Lax + conditional Secure — see buildAuthCookie.
    const maxAge = 30 * 24 * 60 * 60
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': buildAuthCookie(req, token, maxAge),
    })
    res.end(JSON.stringify({ ok: true, tokenId: id }))
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

function handleAuthLogout(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': buildAuthCookie(req, null, 0),
  })
  res.end(JSON.stringify({ ok: true }))
}


// ============================================
// WebSocket chat handlers
// ============================================

/**
 * Handle a message from a web client
 */
async function handleClientMessage(
  client: ClientConnection,
  msg: { type: string; text?: string; agent?: string; threadId?: string },
  defaultAgent: string,
  /** Notify the caller that the client's id changed mid-handler so the
   *  WS handler can keep its `clients` map keyed by the live id. Without
   *  this the approval-card sender (which does clients.get(threadId))
   *  silently misses the rekeyed client and the approval lands only in
   *  the global /approvals tab. */
  onRekey?: (oldId: string, newId: string) => void,
  /** R9: token id of the connecting peer (or 'anon' on loopback /
   *  auth-off). Used to enforce thread ownership on get-history rekey. */
  tokenId?: string,
  /** R9: shared threadId → tokenId store (persisted). The handler
   *  validates ownership before adopting a client-supplied threadId. */
  threadOwners?: {
    get(threadId: string): string | undefined
    set(threadId: string, tokenId: string): void
    delete(threadId: string): void
    rekey?(oldId: string, newId: string): void
  },
  /** Live client registry — used to retarget chunk/activity frames after
   *  a reconnect (the closure `ws` may already be CLOSED). */
  clients?: Map<string, ClientConnection>,
): Promise<void> {
  const { ws } = client
  // Read client.id fresh — `get-history` may rekey it mid-handler so the
  // session lookup matches the client's persisted threadId.
  let clientId = client.id

  /** Prefer the currently-connected socket for this thread (post-rekey /
   *  reconnect), falling back to the handler's original `ws`. */
  const emit = (data: Record<string, unknown>): void => {
    const live = clients?.get(clientId)
    sendToClient(live?.ws ?? ws, data)
  }

  switch (msg.type) {
    case 'message': {
      if (!msg.text?.trim()) return

      const text = msg.text.trim()
      const runId = `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
      const runStartedAt = Date.now()
      const traceId = generateTraceId()
      const logger = createLogger({ traceId, platform: 'web', component: 'web' })
      // Stable session key for ActiveRun + live emit (survives WS replace).
      const sessionThreadId = clientId

      if (msg.agent && msg.agent !== client.agent) {
        client.agent = msg.agent
      }

      const parsed = parseMessage(text)

      // Agent-switch command (/agim, /cc, /pi, …): routeMessage persists
      // the session switch, but the WS client + the chat dropdown only learn
      // about a switch via the explicit `switch-agent` path. Mirror it here so
      // a command switch keeps the picker in sync. Gated on availability like
      // the switch-agent handler so we don't advertise an unusable agent.
      if (parsed.type === 'agent') {
        const sw = registry.findAgent(parsed.agent)
        if (sw && sw.name !== client.agent && (await isAgentAvailableCached(sw.name))) {
          client.agent = sw.name
          emit({ type: 'agent-switched', agent: sw.name })
        }
      }

      const {
        startActiveRun,
        upsertActiveRunStep,
        appendActiveRunChunk,
        setActiveRunPartialText,
        finishActiveRun,
        getActiveRun,
        snapshotToPersistedActivity,
      } = await import('./active-runs.js')

      const persistFinishedActivity = async (matchContent?: string): Promise<void> => {
        const snap = getActiveRun(sessionThreadId)
        if (!snap || snap.status === 'running') return
        // Persist even with empty steps so "已完成 · Xs" survives refresh.
        const activity = snapshotToPersistedActivity(snap)
        try {
          let ok = await sessionManager.patchLastAssistantActivity(
            'web', 'web', sessionThreadId, activity, matchContent,
          )
          if (!ok && matchContent !== undefined) {
            ok = await sessionManager.patchLastAssistantActivity(
              'web', 'web', sessionThreadId, activity,
            )
          }
          if (!ok) {
            webLog.warn({
              event: 'web.activity.persist_miss',
              threadId: sessionThreadId,
              runId: snap.runId,
            }, 'No assistant message to attach activity to')
          }
        } catch (err) {
          webLog.warn({
            event: 'web.activity.persist_failed',
            threadId: sessionThreadId,
            err: err instanceof Error ? err.message : String(err),
          }, 'Failed to persist chat activity')
        }
      }

      startActiveRun({
        threadId: sessionThreadId,
        runId,
        agent: client.agent,
        startedAt: runStartedAt,
      })
      emit({
        type: 'run-start',
        runId,
        agent: client.agent,
        startedAt: new Date(runStartedAt).toISOString(),
      })

      // Abort any previous in-flight run on this thread, then bind a fresh
      // controller so the Stop button (WS `stop`) can interrupt the CLI.
      webRunAborts.get(sessionThreadId)?.abort()
      const runAbort = new AbortController()
      webRunAborts.set(sessionThreadId, runAbort)

      try {
        const routeCtx: RouteContext = {
          threadId: clientId,
          channelId: 'web',
          platform: 'web',
          defaultAgent: client.agent,
          traceId,
          logger,
          userId: `web:${clientId}`,
          webRunId: runId,
          signal: runAbort.signal,
          onToolActivity: (step) => {
            upsertActiveRunStep(sessionThreadId, {
              id: step.id,
              kind: step.kind,
              label: step.label,
              status: step.status,
              startedAt: step.startedAt,
              finishedAt: step.finishedAt,
              preview: step.preview,
              ...(step.todoItems ? { todoItems: step.todoItems } : {}),
            })
            // Drop steps after finishActiveRun — late MCP/approval cleanup
            // must not reopen a Running accordion on the SPA (CLI agents).
            const snap = getActiveRun(sessionThreadId)
            if (!snap || snap.status !== 'running') return
            emit({ type: 'activity-step', runId, step })
          },
        }

        logger.info({ event: 'message.received', ...sanitizeUserText(text) })

        const result = await routeMessage(parsed, routeCtx)

        if (runAbort.signal.aborted) {
          const finishedAt = Date.now()
          const durationMs = Math.max(0, finishedAt - runStartedAt)
          finishActiveRun(sessionThreadId, {
            status: 'error', finishedAt, durationMs, error: USER_INTERRUPTED_TEXT,
          })
          try {
            await sessionManager.addMessage('web', 'web', sessionThreadId, {
              role: 'assistant',
              content: USER_INTERRUPTED_TEXT,
              agent: client.agent,
              timestamp: new Date(),
            })
          } catch { /* best-effort */ }
          await persistFinishedActivity(USER_INTERRUPTED_TEXT)
          emit({
            type: 'done',
            text: USER_INTERRUPTED_TEXT,
            runId,
            messageId: await latestWebAssistantMessageId(sessionThreadId),
          })
          emit({
            type: 'run-finish',
            runId,
            status: 'error',
            finishedAt: new Date(finishedAt).toISOString(),
            durationMs,
            error: USER_INTERRUPTED_TEXT,
          })
          return
        }

        // String response (built-in commands, errors)
        if (typeof result === 'string') {
          const finishedAt = Date.now()
          const durationMs = Math.max(0, finishedAt - runStartedAt)
          setActiveRunPartialText(sessionThreadId, result)
          finishActiveRun(sessionThreadId, {
            status: 'success', finishedAt, durationMs, finalText: result,
          })
          await persistFinishedActivity(result)
          emit({
            type: 'done',
            text: result,
            runId,
            messageId: await latestWebAssistantMessageId(sessionThreadId),
          })
          if (parsed.type === 'plan') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({ type: 'plan-mode', enabled: !!sess?.planMode })
          }
          if (parsed.type === 'think') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({ type: 'think-mode', variant: sess?.variant || 'auto' })
          }
          if (parsed.type === 'ctx') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({ type: 'compact-rate', rate: sess?.compactRate || 'auto' })
          }
          if (parsed.type === 'model') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({ type: 'session-model', model: sess?.model || '' })
          }
          emit({
            type: 'usage',
            runId,
            durationMs,
            outputChars: result.length,
          })
          emit({
            type: 'run-finish',
            runId,
            status: 'success',
            finishedAt: new Date(finishedAt).toISOString(),
            durationMs,
          })
          return
        }

        // Streaming response (agent responses)
        let fullText = ''
        for await (const chunk of result) {
          if (runAbort.signal.aborted) break
          fullText += chunk
          appendActiveRunChunk(sessionThreadId, chunk)
          // L1: defer when the per-socket send buffer is full. Without
          // this, a slow client lets the chunk producer keep allocating
          // frames into the kernel + ws-internal queue, which can grow
          // to GBs for a long agent response.
          const liveWs = clients?.get(sessionThreadId)?.ws ?? ws
          await awaitWsDrain(liveWs)
          // Keep producing even if the original socket died — a reconnect
          // may have registered under sessionThreadId. Only stop if there
          // is still no live peer AND the original is closed (avoid
          // unbounded buffering into ActiveRun alone for hours).
          const peer = clients?.get(sessionThreadId)
          if (!peer && liveWs.readyState !== liveWs.OPEN) break
          if (peer) emit({ type: 'chunk', text: chunk, runId })
          else if (liveWs.readyState === liveWs.OPEN) emit({ type: 'chunk', text: chunk, runId })
        }

        if (runAbort.signal.aborted) {
          const finishedAt = Date.now()
          const durationMs = Math.max(0, finishedAt - runStartedAt)
          const text = fullText.trim()
            ? `${fullText.trimEnd()}\n\n${USER_INTERRUPTED_TEXT}`
            : USER_INTERRUPTED_TEXT
          setActiveRunPartialText(sessionThreadId, text)
          finishActiveRun(sessionThreadId, {
            status: 'error', finishedAt, durationMs, error: USER_INTERRUPTED_TEXT, finalText: text,
          })
          await persistFinishedActivity(text)
          emit({
            type: 'done',
            text,
            runId,
            messageId: await latestWebAssistantMessageId(sessionThreadId),
          })
          emit({
            type: 'run-finish',
            runId,
            status: 'error',
            finishedAt: new Date(finishedAt).toISOString(),
            durationMs,
            error: USER_INTERRUPTED_TEXT,
          })
          return
        }

        const finishedAt = Date.now()
        const durationMs = Math.max(0, finishedAt - runStartedAt)
        // Hard constraint: Web / Portal (/m/chat, macOS·iOS shells) never
        // deliver summary-only (envelope or 落盘+要点). SPA replaces the
        // streamed bubble with done.text.
        let deliveredText = fullText
        if (needsFullInlineDelivery('web') && fullText.trim()) {
          const cwd = resolveAgentCwd(client.agent, {
            platform: 'web',
            channelId: 'web',
            threadId: sessionThreadId,
          }) || defaultAgentCwd(client.agent)
          deliveredText = expandInlineChannelReply(fullText, { workspaceRoot: cwd })
        }
        setActiveRunPartialText(sessionThreadId, deliveredText)
        finishActiveRun(sessionThreadId, {
          status: 'success', finishedAt, durationMs, finalText: deliveredText,
        })
        await persistFinishedActivity(deliveredText)
        emit({
          type: 'done',
          text: deliveredText,
          runId,
          messageId: await latestWebAssistantMessageId(sessionThreadId),
        })
        emit({
          type: 'usage',
          runId,
          durationMs,
          outputChars: deliveredText.length,
        })
        emit({
          type: 'run-finish',
          runId,
          status: 'success',
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs,
        })
      } catch (err) {
        const aborted = runAbort.signal.aborted
          || (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
        const errorMsg = aborted
          ? USER_INTERRUPTED_TEXT
          : (err instanceof Error ? err.message : String(err))
        const stack = err instanceof Error ? err.stack : undefined
        if (!aborted) {
          logger.error({ event: 'web.handle.error', err: errorMsg, stack }, 'Error handling client message')
        } else {
          logger.info({ event: 'web.handle.aborted', runId }, 'Web chat run aborted by user')
        }
        const finishedAt = Date.now()
        const durationMs = Math.max(0, finishedAt - runStartedAt)
        finishActiveRun(sessionThreadId, {
          status: 'error', finishedAt, durationMs, error: errorMsg,
        })
        if (aborted) {
          try {
            await sessionManager.addMessage('web', 'web', sessionThreadId, {
              role: 'assistant',
              content: USER_INTERRUPTED_TEXT,
              agent: client.agent,
              timestamp: new Date(),
            })
          } catch { /* best-effort */ }
          await persistFinishedActivity(USER_INTERRUPTED_TEXT)
          emit({
            type: 'done',
            text: USER_INTERRUPTED_TEXT,
            runId,
            messageId: await latestWebAssistantMessageId(sessionThreadId),
          })
        } else {
          await persistFinishedActivity()
        }
        emit({
          type: 'run-finish',
          runId,
          status: 'error',
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs,
          error: errorMsg,
        })
        if (!aborted) emit({ type: 'error', message: `Agent error: ${errorMsg}` })
      } finally {
        if (webRunAborts.get(sessionThreadId) === runAbort) {
          webRunAborts.delete(sessionThreadId)
        }
      }
      break
    }

    case 'stop': {
      const ac = webRunAborts.get(clientId)
      if (!ac) {
        sendToClient(ws, { type: 'error', message: '当前没有正在执行的任务' })
        break
      }
      ac.abort()
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
        sendToClient(ws, {
          type: 'error',
          message: formatWebAgentUnavailableMessage(agent.name),
        })
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
      // 2026-05-19: support client-supplied threadId so a browser refresh
      // (or returning to the chat after a navigation) resumes the existing
      // conversation instead of starting fresh. Client persists the id in
      // localStorage; if it provides one, we treat it as the authoritative
      // session key going forward. We update client.id (so subsequent
      // `message` / `switch-agent` ops use the persisted thread) but leave
      // the clients map alone — push-by-clientId is a separate code path
      // that doesn't rely on the persisted id today.
      //
      // R9: before adopting the threadId, validate ownership. The
      // pre-R9 path accepted any well-formed `web-*` id, letting an
      // authenticated peer enumerate Date.now()-based ids and hijack
      // (or wipe via new-conversation) another peer's chat session.
      // Now the threadId is owned by the tokenId that first claimed it;
      // a rekey from a different tokenId is refused.
      const wantedThreadId = typeof msg.threadId === 'string' ? msg.threadId.trim() : ''
      if (wantedThreadId && /^web-[A-Za-z0-9_-]{4,64}$/.test(wantedThreadId) && wantedThreadId !== clientId) {
        const peer = tokenId ?? 'anon'
        const owner = threadOwners?.get(wantedThreadId)
        if (owner !== undefined && owner !== peer) {
          webLog.warn({
            event: 'web.session.rekey_denied',
            clientId, wantedThreadId, peer,
          }, 'WS get-history rekey refused — threadId owned by a different token')
          sendToClient(ws, { type: 'error', message: 'thread not owned by this session' })
          return
        }
        // First-claim OK (owner === undefined) or same-owner reconnect.
        const oldId = clientId
        client.id = wantedThreadId
        clientId = wantedThreadId
        if (threadOwners && owner === undefined) {
          threadOwners.set(wantedThreadId, peer)
        }
        onRekey?.(oldId, wantedThreadId)
        webLog.info({ clientId, oldId, event: 'web.session.rekey' }, 'WS client adopted persisted threadId')
      }
      await sendSessionHistory(ws, client, defaultAgent)
      break
    }

    // v1's "New conversation" button in the web chat. Clears the
    // session messages, forks a fresh session id, drops per-agent CLI
    // session bindings (Claude/opencode/codex) and any auto-allow
    // approval rules, so the next prompt starts on a clean slate. The
    // WS client receives a follow-up `history` message with an empty
    // list so the UI repaints the cleared state.
    case 'new-conversation': {
      const { clearActiveRun } = await import('./active-runs.js')
      clearActiveRun(clientId)
      await sessionManager.resetConversation('web', 'web', clientId)
      sendToClient(ws, { type: 'history', messages: [], agent: client.agent })
      break
    }
  }
}

/**
 * Send session history to a client.
 *
 * Always emit a `history` frame when a session exists — including an empty
 * message list — so the SPA can adopt the sticky agent after MESSAGES_TTL
 * cleared the transcript. Previously we skipped empty histories, which left
 * the agent picker on the process default after refresh.
 *
 * After history, replay any in-flight (or recently finished) ActiveRun so
 * tab-switch / refresh can restore the activity accordion and "接收中".
 */
/** Latest durable assistant message id for a web thread (for done → SPA). */
async function latestWebAssistantMessageId(threadId: string): Promise<string | undefined> {
  try {
    const history = await sessionManager.getSessionWithHistory('web', 'web', threadId)
    if (!history) return undefined
    for (let i = history.messages.length - 1; i >= 0; i--) {
      const m = history.messages[i]
      if (m?.role === 'assistant' && m.id) return m.id
    }
  } catch { /* ignore */ }
  return undefined
}

async function sendSessionHistory(
  ws: WebSocket,
  client: ClientConnection,
  _defaultAgent: string,
): Promise<void> {
  const history = await sessionManager.getSessionWithHistory('web', 'web', client.id)
  if (history) {
    if (history.session.agent) {
      client.agent = history.session.agent
    }
    try {
      const { listMessageFeedback, resolveFeedbackVote } = await import('../core/message-feedback.js')
      const feedbackEntries = await listMessageFeedback('web', 'web', client.id)
      sendToClient(ws, {
        type: 'history',
        messages: history.messages.map((m, i) => ({
          ...m,
          feedback: resolveFeedbackVote(feedbackEntries, {
            messageId: m.id,
            messageIndex: i,
          }),
        })),
        agent: history.session.agent,
        planMode: !!history.session.planMode,
        thinkVariant: history.session.variant || 'auto',
        sessionModel: history.session.model || '',
        compactRate: history.session.compactRate || 'auto',
      })
    } catch {
      sendToClient(ws, {
        type: 'history',
        messages: history.messages,
        agent: history.session.agent,
        planMode: !!history.session.planMode,
        thinkVariant: history.session.variant || 'auto',
        sessionModel: history.session.model || '',
        compactRate: history.session.compactRate || 'auto',
      })
    }
  }
  const { getActiveRun } = await import('./active-runs.js')
  const active = getActiveRun(client.id)
  if (active) {
    const alreadyOnHistory = history?.messages.some(
      (m) => m.activity?.runId === active.runId,
    )
    // Always replay in-flight runs. Replay finished ones only when the
    // durable patch hasn't landed on history yet (rare race).
    if (active.status === 'running' || !alreadyOnHistory) {
      sendToClient(ws, {
        type: 'active-run',
        runId: active.runId,
        agent: active.agent,
        startedAt: new Date(active.startedAt).toISOString(),
        status: active.status,
        steps: active.steps,
        partialText: active.partialText,
        finishedAt: active.finishedAt != null
          ? new Date(active.finishedAt).toISOString()
          : undefined,
        durationMs: active.durationMs,
        error: active.error,
      })
    }
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
 * Bounded by AGIM_WS_BACKPRESSURE_TIMEOUT_MS (default 5 s) so a frozen
 * client can't wedge the agent's chunk producer indefinitely.
 */
async function awaitWsDrain(ws: WebSocket): Promise<void> {
  if (ws.bufferedAmount < WS_BACKPRESSURE_HIGHWATER_BYTES) return
  const timeoutMs = (() => {
    const raw = process.env.AGIM_WS_BACKPRESSURE_TIMEOUT_MS
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
function serveStatic(
  res: ServerResponse,
  filePath: string,
  contentType: string,
  extraHeaders?: Record<string, string>,
): void {
  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  const content = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': contentType, ...extraHeaders })
  res.end(content)
}

/**
 * Serve HTML pages with security headers.
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
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  })
  res.end(html)
}
