// Web chat server — HTTP + WebSocket for browser-based agent interaction

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { readdir, stat, readFile, writeFile, rename, unlink, realpath, open } from 'node:fs/promises'
import { join, dirname, resolve as resolvePath, sep as pathSep, relative as relativePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseMessage, routeMessage, type RouteContext } from '../core/router.js'
import { sessionManager } from '../core/session.js'
import { registry } from '../core/registry.js'
import { getDefaultAgent } from '../core/live-config.js'
import { sink, resolveMessenger } from '../core/message-sink.js'
import { expandInlineChannelReply, needsFullInlineDelivery } from '../core/inline-delivery.js'
import { defaultAgentCwd, resolveAgentCwd } from '../core/agent-cwd.js'
import { generateTraceId, createLogger, logger as rootLogger, sanitizeUserText } from '../core/logger.js'
import { updateConfigObject } from '../core/config-store.js'
import { isMasked, maskSecret } from './env-mask.js'
import { handleLlmApi } from './llm-api.js'
import { handleMcpApi } from './mcp-api.js'
import { handleBackgroundTasksApi } from './background-tasks-api.js'
import { handleAgimSkillsApi } from './agim-skills-api.js'
import { handleConfigApi, getAgentStatuses } from './config-api.js'
import { handleMemoryApi } from './memory-api.js'
import { handleChatMediaApi } from './chat-media-api.js'
import { handleServiceApi } from './service-api.js'
import { handleJobsApi } from './jobs-api.js'
import { handleEnvApi } from './env-api.js'
import { createSerialQueue } from './serial-queue.js'
import {
  MAX_API_BODY_BYTES,
  MAX_CHAT_MEDIA_BYTES,
  readBody,
  readBinaryBody,
  sendJson,
  sendError,
} from './http-utils.js'
import {
  checkAuth,
  requireAdmin,
  isRequestAdmin,
  getRequestActor,
  extractToken,
  verifyTokenSync,
  isTrustedLoopbackPeer,
  isPublicPath,
  bindTokenModule,
  isEnvOff,
  _tokenModule,
} from './auth.js'
import { consumeToken, peekToken } from '../core/location-token.js'
import { createMemo, updateMemo, getMemo, mapUrls } from '../core/memos.js'
import { normalizeIncomingCoords } from '../core/coord-systems.js'

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
    const viewerMatch = url.pathname.match(/^\/v\/([0-9a-f-]{8,})$/i)
    if (viewerMatch && req.method === 'GET') {
      return handleViewerPage(res, viewerMatch[1])
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
      // navigator.geolocation returns whatever the host engine hands the
      // page. The coord system varies by browser+OS:
      //   - iOS Safari / WebKit in mainland China: GCJ-02 (Apple's PRC
      //     compliance offset baked into Core Location).
      //   - WeChat X5 webview / Android Chrome without GMS: raw WGS-84.
      //   - PC browsers anywhere: WGS-84.
      // Default to WGS-84 pass-through (matches the most common Chinese
      // mobile path — WeChat — which was silently miscalibrated before
      // the 2026-05-12 fix). iOS users in China set AGIM_H5_COORDS_GCJ02=1
      // to restore the GCJ→WGS path.  See core/coord-systems.ts.
      const norm = normalizeIncomingCoords('h5-browser-geolocation', rawLat, rawLng)
      const lat = norm.lat
      const lng = norm.lng
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
      // Route via sink — adapter resolution (e.g. 'wechat' → 'wechat-ilink')
      // happens inside resolveMessenger(). priority='normal': location replies
      // are non-urgent, queue is fine.
      sink.deliver({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        payload: reply,
        kind: 'text',
      }).catch((err) => {
        webLog.warn({ event: 'web.loc.dispatch_failed', threadId: ctx.threadId, err: String(err) })
      })

      sendJson(res, 200, { ok: true, id: memoId, lat, lng })
      return
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

    // /api/memos — search / list / delete. List uses the same searchMemos
    // function the MCP tool exposes; query/who/what/has_location/limit
    // come through as URL params.
    if (url.pathname === '/api/memos' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleListMemos(req, res, url)
    }
    const memoIdMatch = url.pathname.match(/^\/api\/memos\/(\d+)$/)
    if (memoIdMatch && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return
      return handleDeleteMemo(req, res, Number.parseInt(memoIdMatch[1], 10))
    }

    // /api/env + /api/security/diagnostics — env var management + security badges.
    if (url.pathname === '/api/env' || url.pathname === '/api/security/diagnostics') {
      if (await handleEnvApi(req, res, url)) return
    }
    if (url.pathname === '/api/messengers/email/test' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleEmailTest(req, res)
    }
    // v1.2.126 — web_search provider introspection + ping. GET lists
    // every registered provider (name + envKey + current available),
    // POST sends a one-shot test query through a single named
    // provider and reports latency / hit count / error.
    if (url.pathname === '/api/search/providers' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleSearchProviders(req, res)
    }
    if (url.pathname === '/api/search/test' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleSearchTest(req, res)
    }
    // Speech-to-text provider list / whisper model init (admin guards inside dispatcher).
    // v1.2.129 — mobile QR. Admin generates a fresh role=user token with
    // a date-stamped label and gets back a QR data URL + the raw login
    // URL. The token persists until the admin revokes it via the regular
    // /settings/security/tokens UI — there's no auto-expiry in this
    // version (operator-managed lifecycle).
    if (url.pathname === '/api/mobile/qr' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleMobileQR(req, res)
    }
    // Chat media / STT / feedback (admin guards applied inside dispatcher per route).
    if (url.pathname.startsWith('/api/chat/') || url.pathname.startsWith('/api/stt/')) {
      const handled = await handleChatMediaApi(req, res, url)
      if (handled) return
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleListWorkspaces(req, res, url)
    }
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleCreateOrUpdateWorkspace(req, res)
    }
    const workspaceIdMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
    if (workspaceIdMatch && req.method === 'PATCH') {
      if (!requireAdmin(req, res)) return
      return handleCreateOrUpdateWorkspace(req, res, workspaceIdMatch[1])
    }
    if (workspaceIdMatch && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return
      return handleDeleteWorkspace(req, res, workspaceIdMatch[1])
    }
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleMetrics(req, res, url)
    }
    if (url.pathname === '/api/audit' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleAudit(req, res, url)
    }
    // R12 ⑤ — governance audit events (approvals, admin changes, config /
    // env / token / workspace mutations). Separate retention from
    // invocations (default 180d). Admin-only — these rows can expose
    // who promoted whom and which config keys were rotated when.
    if (url.pathname === '/api/audit/events' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleAuditEvents(req, res, url)
    }
    // v1.1.2 — Outbox tab. List rows by status, plus aggregate stats and
    // a retry endpoint for the giving_up row state.
    if (url.pathname === '/api/outbox' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleListOutbox(req, res, url)
    }
    if (url.pathname === '/api/outbox/stats' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleOutboxStats(req, res)
    }
    const outboxRetryMatch = url.pathname.match(/^\/api\/outbox\/(\d+)\/retry$/)
    if (outboxRetryMatch && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleOutboxRetry(req, res, parseInt(outboxRetryMatch[1], 10))
    }
    // v1.1.3 — A2A tab. Stats over inline rows with parent_id; recent
    // calls; and a tree walk rooted at a given jobId.
    if (url.pathname === '/api/a2a/stats' && req.method === 'GET') {
      return handleA2AStats(req, res)
    }
    if (url.pathname === '/api/a2a/recent' && req.method === 'GET') {
      return handleA2ARecent(req, res, url)
    }
    const a2aTreeMatch = url.pathname.match(/^\/api\/a2a\/tree\/(\d+)$/)
    if (a2aTreeMatch && req.method === 'GET') {
      return handleA2ATree(req, res, parseInt(a2aTreeMatch[1], 10))
    }
    // v1.1.3 — Artifacts. List per-job + download single file. The
    // download endpoint also doubles as the binary view for the A2A
    // tab's "📎 commits.txt" link.
    const artifactsListMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)$/)
    if (artifactsListMatch && req.method === 'GET') {
      return handleArtifactsList(req, res, parseInt(artifactsListMatch[1], 10))
    }
    const artifactsFileMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)\/file\/([\w.+-]+)$/)
    if (artifactsFileMatch && req.method === 'GET') {
      return handleArtifactsFile(req, res, parseInt(artifactsFileMatch[1], 10), artifactsFileMatch[2])
    }

    // v1.2 — Viewer pastes (long markdown stash for IM short-link replies).
    // GET /api/viewer        — list pastes (newest first), for the web console.
    // GET /api/viewer/:id    — raw JSON of one paste.
    // DELETE /api/viewer/:id — remove a paste (operator can clean up).
    if (url.pathname === '/api/viewer' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleViewerList(req, res, url)
    }
    if (url.pathname === '/api/viewer/tunnel' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleViewerTunnelStatus(req, res)
    }
    const viewerIdMatch = url.pathname.match(/^\/api\/viewer\/([0-9a-f-]{8,})$/i)
    if (viewerIdMatch && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleViewerGet(req, res, viewerIdMatch[1])
    }
    if (viewerIdMatch && req.method === 'DELETE') {
      // Deleting a viewer paste is a mutation; per the security model all
      // mutation endpoints require admin. Previously this route had no guard,
      // so any authenticated token (incl. role=user, e.g. a mobile-QR token)
      // could delete any paste by its id (ids leak via IM `/v/<uuid>` links).
      if (!requireAdmin(req, res)) return
      return handleViewerDelete(req, res, viewerIdMatch[1])
    }
    // PR-B: agent health snapshot (circuit breaker + rate-limiter remaining
    // + latency p50/95/99) consumed by the Health tab in /tasks.
    if (url.pathname === '/api/agent-health' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleAgentHealth(req, res)
    }
    // v1.3 — Cost & Health: aggregated metrics from the audit-log used by
    // the new Cost & Health tab. summary returns daily totals + KPI cards;
    // topn returns ranked groups by user / agent / platform / intent.
    if (url.pathname === '/api/health/summary' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleHealthSummary(req, res, url)
    }
    if (url.pathname === '/api/health/topn' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleHealthTopN(req, res, url)
    }
    // v1.5/v1.6 — Memory + vector admin (admin guards applied inside dispatcher per route).
    if (url.pathname.startsWith('/api/memory/')) {
      const handled = await handleMemoryApi(req, res, url)
      if (handled) return
    }
    // v1.2.3 — Skills browser. Lists locally-installed claude/opencode
    // skills with frontmatter; modal renders the full SKILL.md markdown.
    if (url.pathname === '/api/skills' && req.method === 'GET') {
      return handleSkillsList(req, res)
    }
    if (url.pathname === '/api/skills/remote/hot' && req.method === 'GET') {
      return handleSkillsRemoteHot(req, res)
    }
    const skillDetailMatch = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)$/)
    if (skillDetailMatch && req.method === 'GET') {
      return handleSkillDetail(req, res, skillDetailMatch[1])
    }
    // PR-B: HITL approvals — global pending list + per-reqId resolve.
    if (url.pathname === '/api/approvals' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleListApprovals(req, res)
    }
    const approvalResolveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/)
    if (approvalResolveMatch && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleResolveApproval(req, res, approvalResolveMatch[1])
    }
    // PR-D: Agent workspace file browser. Read-only inspection of
    // ~/.agim-workspaces/<agent>/ contents — list dirs, peek small
    // text files. PUT path supports inline editing (annotate CLAUDE.md,
    // AGENTS.md, etc.) — same traversal/size guards as GET.
    // GET is available to any authenticated peer so Portal @-mentions can
    // browse the active agent workspace; mutations stay admin-only.
    if (url.pathname === '/api/workspace-files' && req.method === 'GET') {
      return handleWorkspaceFiles(req, res, url)
    }
    if (url.pathname === '/api/workspace-files' && req.method === 'PUT') {
      if (!requireAdmin(req, res)) return
      return handleWorkspaceFileWrite(req, res, url)
    }
    // PR-C: SSE event stream — audit / approval / job / metrics events
    // pushed real-time so the dashboard stops polling. Global control-plane
    // telemetry is admin-only; user/mobile-scoped streams should use a
    // separate endpoint when added.
    if (url.pathname === '/events' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleEventsSSE(req, res)
    }
    if (url.pathname === '/api/notify' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleNotify(req, res)
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
    if (url.pathname === '/api/invoke' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleInvoke(req, res, getDefaultAgent(options.defaultAgent))
    }

    // WeChat QR login — drives the "扫码登录" button in the web settings
    // page. /qr-start returns the QR image URL + the token used to poll;
    // /qr-status polls one cycle and, on confirmation, persists the
    // credentials to disk AND adds 'wechat-ilink' into config.messengers
    // so the next service restart picks the channel up.
    if (url.pathname === '/api/messengers/wechat/qr-start' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleWechatQrStart(res)
    }
    if (url.pathname === '/api/messengers/wechat/qr-status' && req.method === 'GET') {
      // Writes config.messengers on confirm — must match qr-start admin gate.
      if (!requireAdmin(req, res)) return
      return handleWechatQrStatus(res, url)
    }

    // Service management — status / log-tail / start / stop / restart.
    if (url.pathname.startsWith('/api/service/')) {
      if (await handleServiceApi(req, res, url)) return
    }

    // IM admin registry — list + add/remove via Settings → Admins.
    // Web admin token is the single authority in v2 model.
    if (url.pathname === '/api/admin-allowlist' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return handleAdminAllowlistGet(res)
    }
    if (url.pathname === '/api/admin-allowlist' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      return handleAdminAllowlistAdd(req, res)
    }
    if (url.pathname === '/api/admin-allowlist' && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return
      return handleAdminAllowlistRemove(req, res)
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
// REST API handlers
// ============================================

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
 * Persist the workspaces array back to ~/.agim/config.json so changes
 * survive a restart. We do not touch other config fields — the SPA
 * settings page has its own /api/config PUT for that. Best-effort: a write failure is
 * logged but the in-memory registry has already been updated, so the
 * change is live until the next process boot.
 */
async function persistWorkspacesToConfig(workspaces: import('../core/workspace.js').WorkspaceConfig[]): Promise<void> {
  await updateConfigObject((current) => {
    const next = { ...current, tenants: workspaces } as Record<string, unknown>
    // Keep workspaces mirrored for one release so older readers still see it.
    next.workspaces = workspaces
    return { config: next, result: undefined }
  }, {
    fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
  })
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
    // R12 ⑤ — persistent audit. Only id + agent count go into details;
    // member list (potentially identifiers) stays out of the audit row.
    try {
      const { logAuditEvent } = await import('../core/audit-log.js')
      logAuditEvent({
        eventType: 'workspace.add',
        actor: getRequestActor(req),
        target: v.cfg.id,
        outcome: 'ok',
        details: { agents: v.cfg.agents.length, members: v.cfg.members?.length ?? 0 },
      })
    } catch { /* best-effort */ }
    sendJson(res, 200, { ok: true, workspace: v.cfg })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleDeleteWorkspace(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
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
    try {
      const { logAuditEvent } = await import('../core/audit-log.js')
      logAuditEvent({
        eventType: 'workspace.delete',
        actor: getRequestActor(req),
        target: id,
        outcome: 'ok',
      })
    } catch { /* best-effort */ }
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

// ============================================================
// WeChat QR-login endpoints (drive the "扫码登录" web button)
// ============================================================

async function handleWechatQrStart(res: ServerResponse): Promise<void> {
  try {
    const { ILinkWeChatAdapter } = await import('../plugins/messengers/wechat/ilink-adapter.js')
    const adapter = new ILinkWeChatAdapter()
    const { qrUrl, qrToken } = await adapter.startQRLogin()
    // iLink's `qrcode_img_content` field name is misleading — it's a
    // plain WeChat short URL (e.g. https://liteapp.weixin.qq.com/q/...),
    // NOT an image. The user has to scan it with their phone WeChat to
    // authorize the bot. In the CLI we just print it as text; in the
    // browser we need to render it as an actual QR code. Generate a PNG
    // data: URL server-side so the frontend just slots it into <img src>
    // — keeps the page's strict img-src CSP intact.
    const QRCode = (await import('qrcode')).default
    const qrImage = await QRCode.toDataURL(qrUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
    })
    sendJson(res, 200, { qrUrl, qrToken, qrImage })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
  }
}

async function handleWechatQrStatus(res: ServerResponse, url: URL): Promise<void> {
  const qrToken = url.searchParams.get('token') || ''
  if (!qrToken) {
    sendJson(res, 400, { error: 'token query param required' })
    return
  }
  try {
    const { ILinkWeChatAdapter } = await import('../plugins/messengers/wechat/ilink-adapter.js')
    const adapter = new ILinkWeChatAdapter()
    const result = await adapter.pollQRLogin(qrToken)
    if (result.status === 'confirmed') {
      // Add 'wechat-ilink' into config.messengers so the next restart of
      // the service brings the channel up. The credentials file was
      // already written by adapter.pollQRLogin().
      try {
        await updateConfigObject((current) => {
          const messengers = Array.isArray(current.messengers)
            ? current.messengers.filter((item): item is string => typeof item === 'string')
            : []
          return {
            config: messengers.includes('wechat-ilink')
              ? current
              : { ...current, messengers: [...messengers, 'wechat-ilink'] },
            result: undefined,
          }
        }, {
          fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
        })
      } catch (err) {
        webLog.warn({ event: 'wechat.qr.config_persist_failed', err: String(err) })
      }
    }
    sendJson(res, 200, result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
  }
}

// ============================================================
// IM admin registry endpoints (Settings → Admins)
// ============================================================
//
// Web admin token is the single authority. Candidate IM users are auto-
// discovered from inbound messages and surfaced here as knownUsers.
async function handleAdminAllowlistGet(res: ServerResponse): Promise<void> {
  try {
    const {
      listAdmins,
      listKnownImUsers,
      isAllowlistConfigured,
    } = await import('../core/admin-allowlist.js')
    sendJson(res, 200, {
      admins: listAdmins(),
      knownUsers: listKnownImUsers(),
      configured: isAllowlistConfigured(),
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleAdminAllowlistAdd(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { platform?: string; userId?: string }
    const platform = (parsed.platform || '').trim()
    const userId = (parsed.userId || '').trim()
    if (!platform || !userId) {
      sendJson(res, 400, { error: 'platform and userId required' })
      return
    }
    const { promoteAdmin, listAdmins } = await import('../core/admin-allowlist.js')
    const added = await promoteAdmin(platform, userId, { actor: getRequestActor(req) })
    sendJson(res, 200, { ok: true, added, admins: listAdmins() })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleAdminAllowlistRemove(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { platform?: string; userId?: string }
    const platform = (parsed.platform || '').trim().toLowerCase()
    const userId = (parsed.userId || '').trim()
    if (!platform || !userId) {
      sendJson(res, 400, { error: 'platform and userId required' })
      return
    }
    const { revokeAdmin, listAdmins } = await import('../core/admin-allowlist.js')
    const removed = await revokeAdmin(platform, userId, { actor: getRequestActor(req) })
    sendJson(res, 200, { ok: true, removed, admins: listAdmins() })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
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

    // Pre-flight: confirm a messenger exists so we can return a clean 404
    // synchronously. sink will resolve again at delivery time — but the
    // synchronous 404 is part of the API contract.
    const messenger = resolveMessenger(platform)
    if (!messenger) {
      sendJson(res, 404, { error: `Messenger "${platform}" not registered` })
      return
    }

    const traceId = generateTraceId()
    const log = createLogger({ traceId, platform, component: 'notify' })
    log.info({ threadId, hasCard: !!card, textLen: text?.length || 0 }, 'notify in')

    // External /api/notify callers don't know the IM channelId, so we pass
    // 'rest' as a sentinel (consistent with other web-originated rows).
    if (card) {
      await sink.deliver({
        platform, channelId: 'rest', threadId,
        payload: card as object, kind: 'card',
      })
    } else if (text) {
      await sink.deliver({
        platform, channelId: 'rest', threadId,
        payload: text, kind: 'text',
      })
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

// ─── memos ─────────────────────────────────────────────────────────────

async function handleListMemos(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { searchMemos } = await import('../core/memos.js')
    const query = url.searchParams.get('query') || undefined
    const who = url.searchParams.get('who') || undefined
    const what = url.searchParams.get('what') || undefined
    const hasLocation = url.searchParams.get('has_location') === 'true' ? true : undefined
    const includeExpired = url.searchParams.get('include_expired') === 'true' ? true : undefined
    const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
    const rows = searchMemos({ query, who, what, hasLocation, includeExpired, limit })
    // Strip ownership noise but keep everything searchable / displayable.
    // mapUrls is added per-row so the dashboard can render map links.
    const { mapUrls: makeMapUrls } = await import('../core/memos.js')
    const items = rows.map((m) => {
      const out: Record<string, unknown> = {
        id: m.id,
        platform: m.platform,
        userId: m.user_id,
        what: m.what,
        who: m.who,
        whenAt: m.when_at,
        whenText: m.when_text,
        where_lat: m.where_lat,
        where_lng: m.where_lng,
        where_label: m.where_label,
        how: m.how,
        why: m.why,
        memo: m.memo,
        source: m.source,
        expiresAt: m.expires_at,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      }
      if (m.where_lat != null && m.where_lng != null) {
        out.mapUrls = makeMapUrls(m.where_lat, m.where_lng, m.where_label || m.what, '')
      }
      return out
    })
    sendJson(res, 200, { memos: items })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleDeleteMemo(_req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) { sendJson(res, 400, { error: 'invalid id' }); return }
  try {
    const { deleteMemo } = await import('../core/memos.js')
    const ok = deleteMemo(id)
    if (!ok) { sendJson(res, 404, { error: `memo #${id} not found` }); return }
    sendJson(res, 200, { ok: true, id })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// POST /api/messengers/email/test — verify SMTP credentials currently in
// process.env by opening a fresh nodemailer transporter and calling
// `verify()`. Doesn't actually send mail. Returns { ok, message } on
// success or { ok: false, error } with a clean error string. Operators
// save first, then click "Test" — same UX as v1's settings page.
async function handleEmailTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Drain body even though we don't use it, so the connection doesn't
    // stall under keep-alive.
    await readBody(req, res)
    const host = process.env.AGIM_SMTP_HOST?.trim()
    const user = process.env.AGIM_SMTP_USER?.trim()
    const pass = process.env.AGIM_SMTP_PASS
    if (!host || !user || !pass) {
      sendError(res, 400, 'EMAIL_NOT_CONFIGURED', {
        message: 'SMTP not configured (host / user / pass required)',
        extra: { ok: false },
      })
      return
    }
    const portRaw = process.env.AGIM_SMTP_PORT?.trim()
    const portNum = portRaw ? Number.parseInt(portRaw, 10) : 465
    const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 465
    const secureRaw = process.env.AGIM_SMTP_SECURE?.trim().toLowerCase()
    const secure = secureRaw !== undefined
      ? (secureRaw === '1' || secureRaw === 'true' || secureRaw === 'yes')
      : port === 465

    const nodemailer = (await import('nodemailer')).default
    const tx = nodemailer.createTransport({
      host, port, secure,
      auth: { user, pass },
      // Short timeouts — the UI should see a result within ~10s rather
      // than hanging on an unreachable host.
      connectionTimeout: 8000,
      greetingTimeout: 6000,
      socketTimeout: 8000,
    })
    try {
      await tx.verify()
      sendJson(res, 200, { ok: true, message: `Connected to ${host}:${port}` })
    } finally {
      tx.close()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendError(res, 400, 'EMAIL_VERIFY_FAILED', {
      detail: msg,
      extra: { ok: false },
    })
  }
}

// ─── v1.2.126 web_search provider config helpers ────────────────────────

/** GET /api/search/providers — list every registered web_search
 *  backend with its env-key requirement, current availability, and
 *  the resolved chain (the order the dispatcher will try at next
 *  call). The SPA renders this as the search-settings table. */
async function handleSearchProviders(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const { listAllSearchProviders, resolveSearchProviderChain } =
      await import('../core/llm/web-dispatcher.js')
    const providers = listAllSearchProviders()
    const chain = resolveSearchProviderChain().map((p) => p.name)
    sendJson(res, 200, { providers, chain })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

/** POST /api/search/test — `{ provider, query }`. Sends a one-shot
 *  query through a single provider and returns `{ ok, latencyMs, hits, error? }`.
 *  Does NOT walk the fallback chain — operators want to know "is THIS
 *  provider's key working", not "did anything turn up". */
async function handleSearchTest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { provider?: string; query?: string }
    const provider = (parsed.provider || '').trim()
    const query = (parsed.query || '').trim()
    if (!provider) {
      sendError(res, 400, 'SEARCH_TEST_PROVIDER_REQUIRED', { message: 'provider required' })
      return
    }
    if (!query) {
      sendError(res, 400, 'SEARCH_TEST_QUERY_REQUIRED', { message: 'query required' })
      return
    }
    const { getSearchProviderByName } = await import('../core/llm/web-dispatcher.js')
    const p = getSearchProviderByName(provider)
    if (!p) {
      sendError(res, 400, 'SEARCH_TEST_UNKNOWN_PROVIDER', {
        message: `unknown provider "${provider}"`,
      })
      return
    }
    if (!p.available()) {
      sendJson(res, 200, {
        ok: false, provider, latencyMs: 0, hits: 0,
        error: 'provider is not available (missing key?)',
      })
      return
    }
    const controller = new AbortController()
    // Operators expect "test" to either succeed quickly or fail with a
    // clear timeout. 10 s is long enough for most search providers but
    // short enough that a hung backend doesn't hold the request open.
    const tm = setTimeout(() => controller.abort(), 10_000)
    const t0 = Date.now()
    try {
      const hits = await p.search(query, 3, controller.signal)
      sendJson(res, 200, {
        ok: true, provider, latencyMs: Date.now() - t0, hits: hits.length,
      })
    } catch (err) {
      sendJson(res, 200, {
        ok: false, provider, latencyMs: Date.now() - t0, hits: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      clearTimeout(tm)
    }
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

/** POST /api/mobile/qr — admin generates a role=user token + QR data URL
 *  pointing the scanner at /m/login?t=<raw>&next=/m/chat. The token is
 *  long-lived (until the admin revokes it on /settings/security/tokens);
 *  rationale: a 30-min TTL would invalidate the QR before the operator
 *  can show it to anyone, and access-token.ts has no per-token TTL field.
 *
 *  Body: `{ host?: string, baseUrl?: string }` — optional override for
 *  the URL embedded in the QR. Defaults to `<scheme>://<req.host>` so
 *  the QR works on whatever hostname the admin reached the panel on
 *  (loopback / LAN IP / cloudflared tunnel / reverse proxy). */
async function handleMobileQR(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = (() => {
      try { return JSON.parse(body || '{}') as { host?: string; baseUrl?: string } }
      catch { return {} as { host?: string; baseUrl?: string } }
    })()
    // Pick the base URL the QR scanner will hit. Priority:
    //   1) caller-supplied baseUrl (admin can paste a public domain)
    //   2) caller-supplied host (just the host:port, scheme auto-picked)
    //   3) the Host header of THIS admin request (works for cloudflared
    //      tunnels that the admin opened the panel through)
    const isHttps = (req.socket as { encrypted?: boolean }).encrypted === true
      || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
    const scheme = isHttps ? 'https' : 'http'
    let base = (parsed.baseUrl || '').trim().replace(/\/+$/, '')
    if (!base) {
      const host = (parsed.host || req.headers.host || 'localhost').toString()
      base = `${scheme}://${host}`
    }
    // Token label: human-readable + sortable + revoke-friendly.
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
    // URL the scanner hits. /m/login is public; it pulls t out of the
    // URL, POSTs to /api/auth/login, drops the cookie, redirects.
    // encodeURIComponent so a raw token with weird chars wouldn't break
    // the URL — current raw tokens are URL-safe but be defensive.
    const loginUrl = `${base}/m/login?t=${encodeURIComponent(created.raw)}&next=%2Fm%2Fchat`
    const QRCode = (await import('qrcode')).default
    // M error correction is enough for an opaque token; bigger margin
    // helps phone scanners through screen glare.
    const qrDataUrl = await QRCode.toDataURL(loginUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
    })
    // Audit: caller is already logged in admin (requireAdmin); we just
    // emit the create event from createToken. Surface the URL+QR.
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
      revokeHint: '/settings/security/tokens',
    }))
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

/** R12 ⑤ — GET /api/audit/events. Queryable by type, actor, days, limit.
 *  Returns the JSON-encoded `details` field as a string; the client can
 *  JSON.parse on demand (avoids accidental schema coupling). */
async function handleAuditEvents(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { queryAuditEvents } = await import('../core/audit-log.js')
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 1000)
    const days = parseInt(url.searchParams.get('days') || '30', 10) || 30
    const actor = url.searchParams.get('actor') || undefined
    const typesParam = url.searchParams.get('types')
    // Accept comma-separated event types; reject anything not in the
    // known union (defensive against open-ended filters that miss the
    // SQL prepared-statement param check).
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


// v1.2.3 — Skills browser
// ────────────────────────
// Scans ~/.claude/skills/ and ~/.config/opencode/skills/ for SKILL.md
// frontmatter (`name`, `description`). Most installs symlink both dirs
// to a shared source, so we dedupe by slug and tag which adapters each
// skill is visible to. Categories are inferred from the slug prefix
// (fin-data-*, white-pig-*, etc.) — robust across machines that don't
// have a hand-maintained INDEX.md.
//
// Single-flight cache: re-scans on every request, cheap (~5ms for 100
// skills on tmpfs). No watcher; if the user installs a skill they
// refresh the page.

interface SkillMeta {
  slug: string
  name: string
  description: string
  category: string
  agents: ('claude' | 'opencode')[]
  path: string  // canonical path used to read SKILL.md on detail
}

function inferCategory(slug: string): string {
  if (slug.startsWith('fin-data-') || slug.startsWith('mx_') || slug.startsWith('ttfund-')
      || slug.startsWith('ash-') || slug.startsWith('low-position-pick')
      || slug.startsWith('overnight-') || slug.startsWith('garp-')
      || slug.startsWith('gold') || slug === 'precious-metals-report') return '金融数据 / 行情'
  if (slug.startsWith('white-pig-') || slug.startsWith('add-white-pig')
      || slug.startsWith('renew-white-pig') || slug.startsWith('deduct-white-pig')
      || slug.startsWith('delete-white-pig') || slug.startsWith('modify-white-pig')
      || slug.startsWith('add-white-pig-') || slug.startsWith('query-account')
      || slug.startsWith('query-white-pig') || slug.startsWith('set-kol')
      || slug.startsWith('statistics-sales')) return '白猪运营'
  if (slug.startsWith('metaso-') || slug === 'multi-search-engine'
      || slug === 'news-summary' || slug === 'global-financial-headlines'
      || slug.startsWith('qveris')) return '搜索 / 资讯'
  if (slug.startsWith('mailsender') || slug === 'sendmail') return '邮件 / 通讯'
  if (slug.startsWith('claude-api') || slug === 'security-review' || slug === 'review'
      || slug === 'simplify' || slug === 'first-principles-decomposer'
      || slug === 'session_summary' || slug === 'init') return '开发 / 评审'
  if (slug === 'find-skills' || slug === 'update-config' || slug === 'keybindings-help'
      || slug === 'fewer-permission-prompts' || slug === 'loop' || slug === 'schedule'
      || slug === 'yanshen-manual') return '元能力 / 平台'
  return '其他'
}

function readSkillFrontmatter(skillMdPath: string): { name?: string; description?: string } | null {
  try {
    const raw = readFileSync(skillMdPath, 'utf-8')
    if (!raw.startsWith('---')) return null
    const end = raw.indexOf('\n---', 3)
    if (end < 0) return null
    const fm = raw.slice(3, end)
    const out: { name?: string; description?: string } = {}
    for (const line of fm.split('\n')) {
      const m = line.match(/^(\w+)\s*:\s*(.+?)\s*$/)
      if (!m) continue
      const k = m[1].toLowerCase()
      const v = m[2].replace(/^["']|["']$/g, '')
      if (k === 'name') out.name = v
      else if (k === 'description') out.description = v
    }
    return out
  } catch { return null }
}

function scanSkillDir(rootDir: string): Array<{ slug: string; skillMd: string }> {
  try {
    if (!existsSync(rootDir)) return []
    const out: Array<{ slug: string; skillMd: string }> = []
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const md = join(rootDir, entry.name, 'SKILL.md')
      if (existsSync(md)) out.push({ slug: entry.name, skillMd: md })
    }
    return out
  } catch { return [] }
}

const HOME = process.env.HOME || '/root'
const CLAUDE_SKILLS = `${HOME}/.claude/skills`
const OPENCODE_SKILLS = `${HOME}/.config/opencode/skills`

function listSkills(): SkillMeta[] {
  const fromClaude = scanSkillDir(CLAUDE_SKILLS)
  const fromOpencode = scanSkillDir(OPENCODE_SKILLS)
  const map = new Map<string, SkillMeta>()
  for (const { slug, skillMd } of fromClaude) {
    const fm = readSkillFrontmatter(skillMd)
    if (!fm?.name) continue
    map.set(slug, {
      slug,
      name: fm.name,
      description: fm.description || '',
      category: inferCategory(slug),
      agents: ['claude'],
      path: skillMd,
    })
  }
  for (const { slug, skillMd } of fromOpencode) {
    const fm = readSkillFrontmatter(skillMd)
    if (!fm?.name) continue
    const existing = map.get(slug)
    if (existing) {
      if (!existing.agents.includes('opencode')) existing.agents.push('opencode')
    } else {
      map.set(slug, {
        slug,
        name: fm.name,
        description: fm.description || '',
        category: inferCategory(slug),
        agents: ['opencode'],
        path: skillMd,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category)
    return a.slug.localeCompare(b.slug)
  })
}

async function handleSkillsList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const skills = listSkills()
    const byCategory: Record<string, number> = {}
    for (const s of skills) byCategory[s.category] = (byCategory[s.category] || 0) + 1
    sendJson(res, 200, {
      total: skills.length,
      byCategory,
      skills,
      sources: { claude: CLAUDE_SKILLS, opencode: OPENCODE_SKILLS },
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// skillhub.cn proxy with 5-min cache — shows top-50 popular skills so the
// user can discover new ones without leaving the dashboard. The actual
// install still happens via the skillhub CLI on the host (see docs).
//
// Enterprise / air-gapped deployments can disable this endpoint via
// `AGIM_SKILLHUB_ENABLED=0`. When disabled, the API returns a stub
// shape `{ disabled: true, items: [] }` so the UI can show "disabled
// by enterprise policy" without breaking the page. This is the only
// product-default outbound call to a non-IM domain, so the toggle
// matters for organisations doing tcpdump-level egress audits.
let remoteHotCache: { fetchedAt: number; data: unknown } | null = null
const REMOTE_HOT_TTL_MS = 5 * 60_000

function isSkillhubEnabled(): boolean {
  const v = (process.env.AGIM_SKILLHUB_ENABLED ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
}

async function handleSkillsRemoteHot(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isSkillhubEnabled()) {
    // Disabled by enterprise policy. Return an empty-but-valid shape
    // so the SPA can render "disabled" copy without a network error
    // toast. Status 200 because this is a deliberate operator choice,
    // not a transient failure.
    sendJson(res, 200, { disabled: true, items: [], reason: 'AGIM_SKILLHUB_ENABLED=0' })
    return
  }
  try {
    if (remoteHotCache && Date.now() - remoteHotCache.fetchedAt < REMOTE_HOT_TTL_MS) {
      sendJson(res, 200, { ...(remoteHotCache.data as Record<string, unknown>), cached: true, fetchedAt: remoteHotCache.fetchedAt })
      return
    }
    const r = await fetch('https://api.skillhub.cn/api/v1/showcase/hot', {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    })
    if (!r.ok) {
      // Serve stale-while-error if we have any cache
      if (remoteHotCache) {
        sendJson(res, 200, { ...(remoteHotCache.data as Record<string, unknown>), cached: true, fetchedAt: remoteHotCache.fetchedAt, stale: true, upstreamStatus: r.status })
        return
      }
      sendJson(res, 502, { error: `skillhub upstream ${r.status}` })
      return
    }
    const json = await r.json() as Record<string, unknown>
    remoteHotCache = { fetchedAt: Date.now(), data: json }
    sendJson(res, 200, { ...json, cached: false, fetchedAt: remoteHotCache.fetchedAt })
  } catch (err) {
    if (remoteHotCache) {
      sendJson(res, 200, {
        ...(remoteHotCache.data as Record<string, unknown>),
        cached: true, fetchedAt: remoteHotCache.fetchedAt, stale: true,
        upstreamError: err instanceof Error ? err.message : String(err),
      })
      return
    }
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleSkillDetail(_req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  try {
    // Guard against traversal — only allow slug chars (already enforced by
    // the route regex but check again here to be safe).
    if (!/^[A-Za-z0-9._-]+$/.test(slug)) {
      sendJson(res, 400, { error: 'bad slug' })
      return
    }
    const skills = listSkills()
    const meta = skills.find((s) => s.slug === slug)
    if (!meta) {
      sendJson(res, 404, { error: 'skill not found' })
      return
    }
    const raw = readFileSync(meta.path, 'utf-8')
    sendJson(res, 200, { ...meta, content: raw })
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
 * Read-only view of `~/.agim-workspaces/<agent>/`. The Files tab in /tasks
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
    const savedPath = relativePath(base, target)
    if (savedPath === 'MEMORY.md') {
      try {
        const { ensureAgentMemoryLink } = await import('../core/agent-cwd.js')
        await ensureAgentMemoryLink(agent)
      } catch { /* best-effort: memory file itself was saved successfully */ }
    }
    sendJson(res, 200, {
      ok: true,
      agent,
      path: savedPath,
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

  const onEvent = (e: import('../core/event-bus.js').AgimEvent): void => {
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





// ============================================
// Outbox (v1.1.2)
// ============================================

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

// ============================================
// A2A (v1.1.3)
// ============================================

// Open a read-only handle to jobs.db. We do NOT reuse job-board's
// writer handle: web reads are read-only, and a separate connection
// keeps the writer free of long SELECTs (jobs.db is in WAL mode, so
// concurrent reads alongside the writer are fine).
//
// Async because we're under ESM — `require()` isn't available at
// runtime even though the type imports above keep `import('better-sqlite3').Database`
// usable at compile time.
async function openJobsDbReadOnly(): Promise<import('better-sqlite3').Database | null> {
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
    // Walk down (children of rootId, grandchildren, ...). Bounded depth 10
    // to keep the response size sane even on misbehaving runaway chains.
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

// ============================================
// Artifacts (v1.1.3)
// ============================================

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
    // Inputs are read-only-from-caller (just copies). Outputs are what
    // the callee produced. The web caller picks by name; we look in
    // outputs first (the common case for downloads) and fall back to
    // inputs if not found.
    const { readOutput, getArtifactsDir } = await import('../core/artifacts.js')
    let buf = await readOutput(jobId, name)
    if (!buf) {
      // Try inputs dir directly (no helper, reuse fs).
      const { existsSync, promises: fs } = await import('node:fs')
      const path = await import('node:path')
      const { inputDir } = getArtifactsDir(jobId)
      const p = path.join(inputDir, name)
      if (existsSync(p) && !name.includes('/') && name !== '..') {
        buf = await fs.readFile(p)
      }
    }
    if (!buf) { sendJson(res, 404, { error: `artifact ${name} not found for job ${jobId}` }); return }
    // Best-effort MIME — most agim artifacts are text/JSON/code so we
    // default to text/plain and let .json / .md / .csv keep their type.
    const lower = name.toLowerCase()
    const contentType =
      lower.endsWith('.json') ? 'application/json' :
      lower.endsWith('.md')   ? 'text/markdown' :
      lower.endsWith('.csv')  ? 'text/csv' :
      lower.endsWith('.html') ? 'text/html' :
      lower.endsWith('.png')  ? 'image/png' :
      lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' :
      'text/plain; charset=utf-8'
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': buf.length,
      'Content-Disposition': `inline; filename="${name.replace(/"/g, '_')}"`,
    })
    res.end(buf)
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

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

// ─── Viewer handlers ───
// v1.2 — Render a stored paste as an HTML page. URL is unguessable uuidv4
// (32 hex chars including dashes); we still cap the length match to a
// reasonable max in the router to avoid pathological lookups.

async function handleViewerPage(res: ServerResponse, id: string): Promise<void> {
  const { getPaste, bumpViewCount } = await import('../core/viewer-local.js')
  const { renderPasteHtml, renderNotFoundHtml } = await import('./viewer-render.js')
  const row = getPaste(id)
  if (!row) {
    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
    })
    res.end(renderNotFoundHtml())
    return
  }
  bumpViewCount(id)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  })
  res.end(renderPasteHtml(row))
}

async function handleViewerList(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { listPastes, countPastes } = await import('../core/viewer-local.js')
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500)
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0)
  const rows = listPastes({ limit, offset })
  // Strip content from list response to keep payload light; UI loads full row via GET /api/viewer/:id.
  const items = rows.map((r) => ({
    id: r.id,
    content_type: r.content_type,
    title: r.title,
    source: r.source,
    job_id: r.job_id,
    created_at: r.created_at,
    view_count: r.view_count,
    bytes: Buffer.byteLength(r.content, 'utf8'),
  }))
  sendJson(res, 200, { total: countPastes(), limit, offset, items })
}

async function handleViewerGet(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const { getPaste } = await import('../core/viewer-local.js')
  const row = getPaste(id)
  if (!row) { sendJson(res, 404, { error: 'not_found' }); return }
  sendJson(res, 200, row)
}

async function handleViewerDelete(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const { deletePaste } = await import('../core/viewer-local.js')
  const ok = deletePaste(id)
  if (!ok) { sendJson(res, 404, { error: 'not_found' }); return }
  sendJson(res, 200, { ok: true })
}

async function handleViewerTunnelStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { getTunnelStatus } = await import('../core/tunnel.js')
  const { getViewerConfig, getEffectivePublicBaseUrl } = await import('../core/viewer-config.js')
  const cfg = getViewerConfig()
  const tunnel = getTunnelStatus()
  sendJson(res, 200, {
    enabled: cfg.enabled,
    tunnelMode: cfg.tunnelMode,
    staticPublicUrl: cfg.publicBaseUrl,
    effectivePublicUrl: getEffectivePublicBaseUrl(),
    tunnel,
  })
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
