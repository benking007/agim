// Web chat server — HTTP + WebSocket for browser-based agent interaction

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { readdir, stat, readFile, writeFile, rename, unlink, realpath, open } from 'node:fs/promises'
import { join, dirname, resolve as resolvePath, sep as pathSep, relative as relativePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseMessage, routeMessage, type RouteContext } from '../core/router.js'
import { sessionManager } from '../core/session.js'
import { registry } from '../core/registry.js'
import { sink, resolveMessenger } from '../core/message-sink.js'
import { generateTraceId, createLogger, logger as rootLogger } from '../core/logger.js'
import { validateConfig } from '../core/config-schema.js'
import { isMasked, maskSecret } from './env-mask.js'
import { consumeToken, peekToken } from '../core/location-token.js'
import { createMemo, updateMemo, getMemo, mapUrls } from '../core/memos.js'
import { normalizeIncomingCoords } from '../core/coord-systems.js'

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

// isMasked + maskSecret extracted to ./env-mask.ts so the bun unit
// suite can verify maskSecret() round-trips through isMasked() — the
// pre-R9 regex didn't, leaving a "lockout via masked-echo" gap.

interface ClientConnection {
  ws: WebSocket
  id: string
  agent: string
}

/** v1.1.10 — paths that never require a web token. */
const PUBLIC_EXACT_PATHS = new Set<string>([
  '/login', '/login.html',
  '/api/auth/login',
  '/api/health',
  '/_app.js',
  '/loc', '/loc.html',
  // POST /api/loc (the bare path, no trailing slash) is the H5 page's
  // "submit my coordinates" endpoint. It's authenticated by the single-use
  // location token in the request body, NOT by the web access token.
  '/api/loc',
  '/favicon.ico', '/favicon.svg',
])
const PUBLIC_PREFIX_PATHS: string[] = ['/l/', '/v/', '/api/loc/', '/vendor/']
const PUBLIC_API_VIEWER_RE = /^\/api\/viewer\/[0-9a-f-]{8,}$/i

function isPublicPath(pathname: string, method: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true
  for (const p of PUBLIC_PREFIX_PATHS) if (pathname.startsWith(p)) return true
  // Single-paste JSON read mirrors /v/:id (same anyone-with-the-url policy);
  // DELETE on the same path still needs a token.
  if (method === 'GET' && PUBLIC_API_VIEWER_RE.test(pathname)) return true
  return false
}

function isLoopbackPeer(req: IncomingMessage): boolean {
  // Treat an empty / missing remoteAddress as untrusted: under exotic
  // transports or post-close sockets the field can read empty, which
  // pre-R9 would silently pass auth. Tighten to exact loopback IPs
  // (with the IPv4-mapped IPv6 form Node uses on dual-stack servers).
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  return ip === '127.0.0.1' || ip === '::1'
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  // 1. Authorization: Bearer <token>
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const v = auth.slice(7).trim()
    if (v) return v
  }
  // 2. Cookie agim_token=<token>
  const cookie = req.headers['cookie']
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=')
      if (k === 'agim_token') return decodeURIComponent(rest.join('=').trim())
    }
  }
  // 3. ?token=...  (last resort, for WS upgrade / iframe)
  const q = url.searchParams.get('token')
  if (q) return q
  return null
}

/** Returns true if the request is authenticated (or auth not required). */
function checkAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  // 1. Disabled by env → pass through.
  if ((process.env.IMHUB_WEB_AUTH || '').toLowerCase() === 'off') return true
  // 2. Loopback → pass through (local CLI / browser-on-same-host).
  if (isLoopbackPeer(req)) return true
  // 3. Public-by-design path → pass through.
  if (isPublicPath(url.pathname, req.method || 'GET')) return true

  // 4. Verify token from header / cookie / query.
  const tok = extractToken(req, url)
  if (tok) {
    // Lazy import avoids loading SQLite-adjacent modules in test stubs etc.
    // The synchronous verifyToken touches the small tokens.json only.
    // We require require()-style top-level access by deferring resolution:
    // but ESM has no require — use a global cache instead.
    const id = verifyTokenSync(tok)
    if (id) return true
  }

  // 5. No / invalid token. /api/* → 401 JSON; static page → 302 to /login.
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unauthorized', loginUrl: '/login' }))
    return false
  }
  if (url.pathname.startsWith('/ws') || req.headers.upgrade === 'websocket') {
    res.writeHead(401)
    res.end()
    return false
  }
  // HTML / static — redirect.
  const next = encodeURIComponent(url.pathname + url.search)
  res.writeHead(302, { Location: `/login?next=${next}` })
  res.end()
  return false
}

// access-token.verifyToken cached lookup. We avoid await in checkAuth by
// pre-loading via a small wrapper. ESM top-level await isn't an option in
// the codebase style, so import on first use and stash the handle.
let _tokenModule: typeof import('../core/access-token.js') | null = null
function verifyTokenSync(raw: string): string | null {
  if (!_tokenModule) {
    // Synchronous resolution via the dist file path. We rely on Node's
    // require-via-createRequire only when running compiled; in production
    // the module is already loaded by bootstrapIfEmpty above so this
    // branch is mostly defensive. Worst case we deny one request while the
    // dynamic import resolves.
    return null
  }
  return _tokenModule.verifyToken(raw)
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
  const clients = new Map<string, ClientConnection>()
  // R9: threadId → tokenId ownership. A WS peer claims a threadId on
  // first connection (verifyClient already verified the token); later
  // `get-history { threadId }` rekey requests must come from a peer
  // holding the same tokenId, otherwise an authenticated operator could
  // adopt and wipe another operator's session. Survives reconnects
  // within the process lifetime so a page refresh still works.
  const threadOwners = new Map<string, string>()

  // v1.1.10+: token-based auth for the web console.
  // ─ loopback peers (127.0.0.1 / ::1) bypass auth (local CLI / curl)
  // ─ public viewer pages (/v/:id, /loc, /l/<token>) remain public
  // ─ IMHUB_WEB_AUTH=off disables the gate entirely (for ops with proxy auth)
  // On first start, bootstrapIfEmpty() generates a one-time bootstrap token
  // and prints it to stdout + the logger so the operator finds it in journalctl.
  const accessTokenModule = await import('../core/access-token.js')
  _tokenModule = accessTokenModule
  const { bootstrapIfEmpty, isAuthEnabled } = accessTokenModule
  try { bootstrapIfEmpty() } catch (err) {
    webLog.warn({ event: 'web.auth_bootstrap_failed', err: String(err) })
  }
  const isPublicBind = bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost'
  if (isPublicBind && !isAuthEnabled()) {
    webLog.warn({
      event: 'web.auth_disabled_on_public_bind',
      bind: bindHost,
    }, 'IMHUB_WEB_AUTH=off + public bind — auth deliberately off, ensure your reverse proxy handles access control')
  }
  webLog.info({
    event: 'web.auth_mode',
    bind: bindHost,
    enabled: isAuthEnabled(),
  }, `Web console auth: ${isAuthEnabled() ? 'token-gated' : 'disabled (IMHUB_WEB_AUTH=off)'}`)

  // HTTP request handler — static files + REST API
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // ─── v1.1.10 auth gate ───────────────────────────────────────────
    // Always run first so unauthenticated requests never reach handlers.
    // Loopback peers + the public paths below bypass.
    if (!checkAuth(req, res, url)) return

    // v2 SPA fallback — opt-in via IMHUB_WEB_V2=1. When enabled, any
    // GET that doesn't match an API / WS / SSE / static-asset path
    // and isn't a public SSR page falls through to serving the v2
    // index.html. The client-side router (react-router) then resolves
    // the path. Anything served from src/web-app/dist/* is built in
    // the M5 PR; until then, set IMHUB_WEB_V2=1 only if you've run
    // `npm --prefix src/web-app run build` and copied dist/* into
    // src/web/public/`.
    //
    // Default IMHUB_WEB_V2=0 → existing behavior unchanged: tasks.html
    // / reminders.html / memos.html / settings.html / index.html are
    // served as before. Zero impact on production deployments.
    if (process.env.IMHUB_WEB_V2 === '1' && req.method === 'GET') {
      const p = url.pathname
      const isApi = p.startsWith('/api/')
      const isWs = p.startsWith('/ws')
      const isSse = p === '/events'
      const isVendor = p.startsWith('/vendor/')
      const isLegacyShared = p === '/_app.js' || p === '/_shell.css'
      const isPublicSsr = p === '/loc' || p === '/loc.html' || p.startsWith('/l/') || p.startsWith('/v/')
      if (!isApi && !isWs && !isSse && !isVendor && !isLegacyShared && !isPublicSsr) {
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
            'application/octet-stream'
          return serveStatic(res, candidate, ct)
        }
        return servePageHtml(res, join(PUBLIC_DIR, 'index.html'))
      }
      // Falls through to API / WS / SSR-page handlers below.
    }

    // Static pages — direct serve, no auth gate. This is the v1
    // routing path; v2 takes precedence when IMHUB_WEB_V2=1 (above).
    if (
      url.pathname === '/' || url.pathname === '/index.html' ||
      url.pathname === '/settings' || url.pathname === '/settings.html' ||
      url.pathname === '/tasks' || url.pathname === '/tasks.html' ||
      url.pathname === '/reminders' || url.pathname === '/reminders.html' ||
      url.pathname === '/memos' || url.pathname === '/memos.html'
    ) {
      const fileMap: Record<string, string> = {
        '/': 'index.html', '/index.html': 'index.html',
        '/settings': 'settings.html', '/settings.html': 'settings.html',
        '/tasks': 'tasks.html', '/tasks.html': 'tasks.html',
        '/reminders': 'reminders.html', '/reminders.html': 'reminders.html',
        '/memos': 'memos.html', '/memos.html': 'memos.html',
      }
      return servePageHtml(res, join(PUBLIC_DIR, fileMap[url.pathname]!))
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

    // Shared web-console utilities (theme manager + i18n + error boundary
    // + auth-aware fetch). Loaded synchronously by every static page in
    // <head> so the theme can apply before first paint. No secrets — safe
    // to serve un-authenticated.
    if (url.pathname === '/_app.js' && req.method === 'GET') {
      return serveStatic(res, join(PUBLIC_DIR, '_app.js'), 'application/javascript; charset=utf-8')
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
      // the 2026-05-12 fix). iOS users in China set IMHUB_H5_COORDS_GCJ02=1
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

    // REST API — open access (no built-in auth). See top-of-function note.

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

    // /api/memos — search / list / delete. List uses the same searchMemos
    // function the MCP tool exposes; query/who/what/has_location/limit
    // come through as URL params.
    if (url.pathname === '/api/memos' && req.method === 'GET') {
      return handleListMemos(req, res, url)
    }
    const memoIdMatch = url.pathname.match(/^\/api\/memos\/(\d+)$/)
    if (memoIdMatch && req.method === 'DELETE') {
      return handleDeleteMemo(req, res, Number.parseInt(memoIdMatch[1], 10))
    }

    // /api/env — read/write SMTP + Baidu AK + IMHUB_WEB_BIND. Values
    // sensitive enough that GET returns them masked (only the last 4 chars
    // visible) unless an explicit ?reveal=1 is passed (still auth-gated).
    if (url.pathname === '/api/env' && req.method === 'GET') {
      return handleGetEnv(req, res, url)
    }
    if (url.pathname === '/api/env' && req.method === 'PUT') {
      return handlePutEnv(req, res)
    }
    if (url.pathname === '/api/messengers/email/test' && req.method === 'POST') {
      return handleEmailTest(req, res)
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
    // v1.1.2 — Outbox tab. List rows by status, plus aggregate stats and
    // a retry endpoint for the giving_up row state.
    if (url.pathname === '/api/outbox' && req.method === 'GET') {
      return handleListOutbox(req, res, url)
    }
    if (url.pathname === '/api/outbox/stats' && req.method === 'GET') {
      return handleOutboxStats(req, res)
    }
    const outboxRetryMatch = url.pathname.match(/^\/api\/outbox\/(\d+)\/retry$/)
    if (outboxRetryMatch && req.method === 'POST') {
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
    const artifactsFileMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)\/file\/([\w.+\-]+)$/)
    if (artifactsFileMatch && req.method === 'GET') {
      return handleArtifactsFile(req, res, parseInt(artifactsFileMatch[1], 10), artifactsFileMatch[2])
    }

    // v1.2 — Viewer pastes (long markdown stash for IM short-link replies).
    // GET /api/viewer        — list pastes (newest first), for the web console.
    // GET /api/viewer/:id    — raw JSON of one paste.
    // DELETE /api/viewer/:id — remove a paste (operator can clean up).
    if (url.pathname === '/api/viewer' && req.method === 'GET') {
      return handleViewerList(req, res, url)
    }
    if (url.pathname === '/api/viewer/tunnel' && req.method === 'GET') {
      return handleViewerTunnelStatus(req, res)
    }
    const viewerIdMatch = url.pathname.match(/^\/api\/viewer\/([0-9a-f-]{8,})$/i)
    if (viewerIdMatch && req.method === 'GET') {
      return handleViewerGet(req, res, viewerIdMatch[1])
    }
    if (viewerIdMatch && req.method === 'DELETE') {
      return handleViewerDelete(req, res, viewerIdMatch[1])
    }
    // PR-B: agent health snapshot (circuit breaker + rate-limiter remaining
    // + latency p50/95/99) consumed by the Health tab in /tasks.
    if (url.pathname === '/api/agent-health' && req.method === 'GET') {
      return handleAgentHealth(req, res)
    }
    // v1.3 — Cost & Health: aggregated metrics from the audit-log used by
    // the new Cost & Health tab. summary returns daily totals + KPI cards;
    // topn returns ranked groups by user / agent / platform / intent.
    if (url.pathname === '/api/health/summary' && req.method === 'GET') {
      return handleHealthSummary(req, res, url)
    }
    if (url.pathname === '/api/health/topn' && req.method === 'GET') {
      return handleHealthTopN(req, res, url)
    }
    // v1.5 — Memory admin: enumerate users, list / delete facts, view /
    // edit / delete persona, export. Backs the Memory tab in /tasks.
    if (url.pathname === '/api/memory/users' && req.method === 'GET') {
      return handleMemoryUsers(req, res)
    }
    if (url.pathname === '/api/memory/facts' && req.method === 'GET') {
      return handleMemoryFacts(req, res, url)
    }
    if (url.pathname === '/api/memory/facts' && req.method === 'DELETE') {
      return handleMemoryBulkDelete(req, res, url)
    }
    const memFactIdMatch = url.pathname.match(/^\/api\/memory\/facts\/(\d+)$/)
    if (memFactIdMatch && req.method === 'DELETE') {
      return handleMemoryDeleteOne(req, res, url, parseInt(memFactIdMatch[1], 10))
    }
    if (url.pathname === '/api/memory/persona' && req.method === 'GET') {
      return handleMemoryPersona(req, res, url)
    }
    if (url.pathname === '/api/memory/persona' && req.method === 'PUT') {
      return handleMemoryPersonaPut(req, res, url)
    }
    if (url.pathname === '/api/memory/persona' && req.method === 'DELETE') {
      return handleMemoryPersonaDelete(req, res, url)
    }
    if (url.pathname === '/api/memory/export' && req.method === 'GET') {
      return handleMemoryExport(req, res, url)
    }
    // v1.6 — vector backend control + index ops.
    if (url.pathname === '/api/memory/vector/status' && req.method === 'GET') {
      return handleVectorStatus(req, res, url)
    }
    if (url.pathname === '/api/memory/vector/test' && req.method === 'POST') {
      return handleVectorTest(req, res)
    }
    if (url.pathname === '/api/memory/vector/download' && req.method === 'POST') {
      return handleVectorDownload(req, res)
    }
    if (url.pathname === '/api/memory/vector/backfill' && req.method === 'POST') {
      return handleVectorBackfill(req, res, url)
    }
    if (url.pathname === '/api/memory/vector/clear' && req.method === 'POST') {
      return handleVectorClear(req, res, url)
    }
    // v1.2.2 — manual trigger for the daily consolidation. Useful when the
    // user just wants a persona summary now without waiting 24h.
    if (url.pathname === '/api/memory/consolidate' && req.method === 'POST') {
      return handleMemoryConsolidate(req, res)
    }
    if (url.pathname === '/api/memory/consolidate/status' && req.method === 'GET') {
      return handleMemoryConsolidateStatus(req, res)
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
      return handleListApprovals(req, res)
    }
    const approvalResolveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/)
    if (approvalResolveMatch && req.method === 'POST') {
      return handleResolveApproval(req, res, approvalResolveMatch[1])
    }
    // PR-D: Agent workspace file browser. Read-only inspection of
    // ~/.agim-workspaces/<agent>/ contents — list dirs, peek small
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
    // pushed real-time so the dashboard stops polling. Open access; same
    // trust model as the REST API.
    if (url.pathname === '/events' && req.method === 'GET') {
      return handleEventsSSE(req, res)
    }
    if (url.pathname === '/api/notify' && req.method === 'POST') {
      return handleNotify(req, res)
    }
    if (url.pathname === '/api/invoke' && req.method === 'POST') {
      return handleInvoke(req, res, options.defaultAgent)
    }

    // WeChat QR login — drives the "扫码登录" button in the web settings
    // page. /qr-start returns the QR image URL + the token used to poll;
    // /qr-status polls one cycle and, on confirmation, persists the
    // credentials to disk AND adds 'wechat-ilink' into config.messengers
    // so the next service restart picks the channel up.
    if (url.pathname === '/api/messengers/wechat/qr-start' && req.method === 'POST') {
      return handleWechatQrStart(res)
    }
    if (url.pathname === '/api/messengers/wechat/qr-status' && req.method === 'GET') {
      return handleWechatQrStatus(res, url)
    }

    // Service management — status / start / stop / restart for the
    // "service controls" card in the web settings page. start/stop are
    // mostly no-ops from the web context (the web server itself IS the
    // service, so the page wouldn't render if nothing was running), but
    // restart is the headline use case: change a setting, click restart,
    // wait ~2s, browser auto-reconnects.
    if (url.pathname === '/api/service/status' && req.method === 'GET') {
      return handleServiceStatus(res)
    }
    if (url.pathname === '/api/service/start' && req.method === 'POST') {
      return handleServiceStart(res)
    }
    if (url.pathname === '/api/service/stop' && req.method === 'POST') {
      return handleServiceStop(res)
    }
    if (url.pathname === '/api/service/restart' && req.method === 'POST') {
      return handleServiceRestart(res)
    }

    // Admin allowlist — list + add/remove via the Safety card. Locally
    // gated: only allowed when bound to 127.0.0.1, since the page has
    // no auth and we don't want random LAN visitors granting themselves
    // admin. See `bindHost` upthread.
    if (url.pathname === '/api/admin-allowlist' && req.method === 'GET') {
      return handleAdminAllowlistGet(res)
    }
    if (url.pathname === '/api/admin-allowlist' && req.method === 'POST') {
      return handleAdminAllowlistAdd(req, res, bindHost)
    }
    if (url.pathname === '/api/admin-allowlist' && req.method === 'DELETE') {
      return handleAdminAllowlistRemove(req, res, bindHost)
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
      // Auth-off / loopback bypass — mirror checkAuth's two short-circuits
      // so dev / local CLI sessions still work without a token.
      if ((process.env.IMHUB_WEB_AUTH || '').toLowerCase() === 'off') return cb(true)
      if (isLoopbackPeer(info.req as IncomingMessage)) return cb(true)

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
    const client: ClientConnection = { ws, id: clientId, agent: options.defaultAgent }
    clients.set(clientId, client)
    // First-claim ownership: this connection's tokenId owns this
    // brand-new threadId until disconnect.
    threadOwners.set(clientId, tokenId)

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
            // Use `client.id` (mutable; updated on session rekey) — not
            // the original `clientId` const — so the threadId we hand
            // to the bus matches the threadId the bus stamped on the
            // pending approval request. Without this, a session that
            // was rekeyed via `get-history` reports the stale id and
            // the bus can't find the open req to resolve.
            const liveId = client.id
            webLog.info({
              event: 'approval.web.click_received',
              clientId: liveId, data: actionData, messageId,
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
              const why = 'approval handler not bound (router not installed?). Restart agim to rebind.'
              webLog.warn({ event: 'approval.web.no_handler', clientId: liveId, data: actionData, messageId }, why)
              sendToClient(ws, { type: 'error', message: why })
              return
            }
            try {
              // Most messengers' ButtonCallback#ack updates a platform-native
              // toast / loading spinner. The web client doesn't have one, so
              // ack is a no-op resolving to the in-page status the page itself
              // chose to render after click.
              await webButtonHandler({
                data: actionData, threadId: liveId, userId: `web:${liveId}`,
                userDisplay: 'Web', messageId, ack: async () => {},
              })
              webLog.info({ event: 'approval.web.click_resolved', clientId: liveId, data: actionData })
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              webLog.error({ event: 'approval.web.click_failed', clientId: liveId, data: actionData, err: errMsg })
              sendToClient(ws, { type: 'error', message: `Approval click failed: ${errMsg}` })
            }
            return
          }
          // Pass an onRekey callback so handleClientMessage can keep
          // the `clients` map in sync when a browser refresh resumes
          // with its persisted threadId. Otherwise the map stays keyed
          // by the WS-assigned id, and the web messenger's outbound
          // approval-card lookup misses the live client.
          await handleClientMessage(
            client, msg, options.defaultAgent,
            (oldId, newId) => {
              // Only reassign if we actually owned `oldId` — defensive
              // against the (impossible-but-cheap-to-guard) case of two
              // clients colliding on the rekey path.
              if (clients.get(oldId) === client) clients.delete(oldId)
              clients.set(newId, client)
              // R9: keep the ownership map aligned with the live id so
              // a subsequent rekey from another connection (same token,
              // e.g. a second tab) succeeds with the new threadId.
              const owner = threadOwners.get(oldId)
              if (owner !== undefined) {
                threadOwners.delete(oldId)
                threadOwners.set(newId, owner)
              }
            },
            tokenId,
            threadOwners,
          )
        } catch (err) {
          webLog.error({ clientId: client.id, err: err instanceof Error ? err.message : String(err) }, 'Error parsing client message')
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
      if (liveId === clientId) threadOwners.delete(liveId)
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
      dingtalk: config.dingtalk
        ? { clientId: config.dingtalk.clientId, clientSecret: mask(config.dingtalk.clientSecret), channelId: config.dingtalk.channelId }
        : undefined,
      discord: config.discord
        ? {
            botToken: mask(config.discord.botToken),
            channelId: config.discord.channelId,
            allowedGuilds: config.discord.allowedGuilds,
            allowedChannels: config.discord.allowedChannels,
          }
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
      if (key === 'dingtalk' && typeof val === 'object' && val !== null) {
        const d = val as Record<string, unknown>
        merged.dingtalk = {
          ...(existing.dingtalk || {}),
          ...d,
          clientSecret: typeof d.clientSecret === 'string' && isMasked(d.clientSecret) ? existing.dingtalk?.clientSecret : d.clientSecret,
        }
        continue
      }
      if (key === 'discord' && typeof val === 'object' && val !== null) {
        const d = val as Record<string, unknown>
        merged.discord = {
          ...(existing.discord || {}),
          ...d,
          botToken: typeof d.botToken === 'string' && isMasked(d.botToken) ? existing.discord?.botToken : d.botToken,
        }
        continue
      }
      if (key === 'acpAgents' && Array.isArray(val)) {
        // R12: match the existing entry by `name`, not by array index.
        // The pre-R12 positional match silently restored the WRONG
        // old token whenever the operator reordered agents in the UI
        // (rows are draggable in /settings/agents): the masked token
        // at the new position `i` mapped to whatever lived at `i` in
        // the prior config, regardless of whether the same agent
        // moved positions. Now: masked → look up the prior entry
        // with the same `name` and reuse its token. Unknown name →
        // leave the masked sentinel through validateConfig, which
        // will reject it loudly (better than a silent wrong-token).
        const existingByName = new Map(
          (existing.acpAgents ?? []).map((a) => [a.name, a]),
        )
        merged.acpAgents = (val as unknown[]).map((item: unknown) => {
          const a = item as Record<string, unknown> | undefined
          if (!a) return a
          const name = typeof a.name === 'string' ? a.name : ''
          const old = existingByName.get(name)
          const auth = a.auth as Record<string, unknown> | undefined
          if (auth && typeof auth.token === 'string' && isMasked(auth.token)) {
            return { ...a, auth: { ...auth, token: old?.auth?.token } }
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
      sendError(res, 400, 'CONFIG_INVALID', {
        message: 'Config validation failed',
        extra: { details: result.errors },
      })
      return
    }

    await saveConfig(result.config as unknown as Config)
    sendJson(res, 200, { ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendError(res, 400, 'CONFIG_SAVE_FAILED', { detail: msg })
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
 * Persist the workspaces array back to ~/.agim/config.json so changes
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
        const cfg = await loadConfig()
        if (!(cfg.messengers || []).includes('wechat-ilink')) {
          const next: Config = {
            ...cfg,
            messengers: [...(cfg.messengers || []), 'wechat-ilink'],
          }
          await saveConfig(next)
        }
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
// Service-management endpoints (start / stop / restart / status)
// ============================================================
//
// The web server itself runs inside the service process, so /stop and
// /restart kill the very process handling the request. We respond
// first, then schedule the kill in a tick so the HTTP reply has time
// to flush. For /restart we additionally spawn a detached "wait + start"
// child so the daemon comes back without manual intervention.

async function handleServiceStatus(res: ServerResponse): Promise<void> {
  try {
    const { detectService, formatUptime, readWebEndpoint } = await import('../cli-ui/service.js')
    const { getBootInfo } = await import('../core/boot-state.js')
    const st = detectService()
    const web = readWebEndpoint()
    const boot = getBootInfo()
    sendJson(res, 200, {
      mode: st.mode,
      pid: st.pid,
      uptimeSec: st.uptimeSec ?? null,
      uptime: typeof st.uptimeSec === 'number' ? formatUptime(st.uptimeSec) : null,
      web,
      // v1.5 — fine-grained boot phase so the web restart-polling UI can
      // wait for full readiness instead of merely "HTTP server is up".
      bootPhase: boot.phase,
      bootMsSinceStart: boot.msSinceStart,
      bootPhaseTimings: boot.phaseTimings,
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleServiceStart(res: ServerResponse): Promise<void> {
  try {
    const { detectService, spawnBackground } = await import('../cli-ui/service.js')
    const st = detectService()
    if (st.mode !== 'none') {
      sendJson(res, 200, { ok: true, alreadyRunning: true, mode: st.mode, pid: st.pid })
      return
    }
    const { fileURLToPath: f } = await import('node:url')
    const __dn = dirname(f(import.meta.url))
    const cliJs = join(__dn, '..', 'cli.js')
    const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
    sendJson(res, 200, { ok: true, started: true, pid })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleServiceStop(res: ServerResponse): Promise<void> {
  const { detectService } = await import('../cli-ui/service.js')
  const st = detectService()
  if (st.mode === 'systemd') {
    // systemctl stop handles the kill for us — no self-exit needed.
    try {
      const { execSync } = await import('node:child_process')
      // Match service.ts's detection: prefer agim.service, fall back.
      const unitName = existsSync('/etc/systemd/system/agim.service') ? 'agim.service' : 'im-hub.service'
      execSync(`systemctl stop ${unitName}`)
      sendJson(res, 200, { ok: true, mode: 'systemd' })
    } catch (err) {
      sendJson(res, 500, { error: 'systemctl stop failed: ' + (err instanceof Error ? err.message : String(err)) })
    }
    return
  }
  // Background / foreground: respond, then SIGTERM self in next tick.
  sendJson(res, 200, { ok: true, mode: st.mode, exiting: true })
  setTimeout(() => {
    try { process.kill(process.pid, 'SIGTERM') } catch { process.exit(0) }
  }, 200)
}

async function handleServiceRestart(res: ServerResponse): Promise<void> {
  const { detectService } = await import('../cli-ui/service.js')
  const st = detectService()
  if (st.mode === 'systemd') {
    try {
      const { spawn } = await import('node:child_process')
      const unitName = existsSync('/etc/systemd/system/agim.service') ? 'agim.service' : 'im-hub.service'
      // v1.5 — fire-and-forget. execSync blocked the HTTP response until
      // systemctl had finished stop+start (5-10s), making the web button
      // look frozen to the user. Detach the child so we can ACK the
      // request immediately and let systemd do its thing.
      const child = spawn('systemctl', ['restart', unitName], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      sendJson(res, 200, { ok: true, mode: 'systemd', restarting: true })
    } catch (err) {
      sendJson(res, 500, { error: 'systemctl restart spawn failed: ' + (err instanceof Error ? err.message : String(err)) })
    }
    return
  }
  if (st.mode === 'foreground') {
    // Can't safely restart someone else's foreground process from the
    // web context — the owning shell still attached to its stdio
    // expects to Ctrl-C it manually.
    sendJson(res, 409, { error: 'foreground service is running in another terminal; restart it manually (Ctrl-C + re-run)' })
    return
  }
  // background or 'none': delegate to the shared restart-flow. The flow
  // runs pre-flight checks, writes restart-pending.json with source='web'
  // (so the new daemon doesn't try to push an IM completion message —
  // browser polling handles that), and spawns the detached helper.
  const { initiateRestart } = await import('../core/restart-flow.js')
  const result = await initiateRestart({ source: 'web' })
  if (!result.ok) {
    sendJson(res, 409, { error: result.message, details: result.errors })
    return
  }
  sendJson(res, 200, { ok: true, mode: st.mode, restarting: true, message: result.message })
}

// ============================================================
// Admin allowlist endpoints (Safety card → Admin Users)
// ============================================================
//
// All three are gated on the server's bindHost being a loopback address.
// The web console has no auth, so we MUST not let a LAN visitor add
// themselves as admin. When bindHost is 0.0.0.0 we hide the editor on
// the frontend AND refuse here as a defense-in-depth.

function isLocalBind(bindHost: string): boolean {
  return bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost'
}

async function handleAdminAllowlistGet(res: ServerResponse): Promise<void> {
  try {
    const { listAdmins, isAllowlistConfigured } = await import('../core/admin-allowlist.js')
    const { BOOTSTRAP_TOKEN_FILE } = await import('../core/admin-bootstrap.js')
    const hasBootstrap = existsSync(BOOTSTRAP_TOKEN_FILE)
    sendJson(res, 200, {
      admins: listAdmins(),
      configured: isAllowlistConfigured(),
      bootstrapAvailable: hasBootstrap,
      bootstrapTokenPath: BOOTSTRAP_TOKEN_FILE,
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleAdminAllowlistAdd(
  req: IncomingMessage,
  res: ServerResponse,
  bindHost: string,
): Promise<void> {
  if (!isLocalBind(bindHost)) {
    sendJson(res, 403, {
      error: 'admin editor disabled when web is bound publicly (no auth on this endpoint).',
    })
    return
  }
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
    const added = await promoteAdmin(platform, userId)
    sendJson(res, 200, { ok: true, added, admins: listAdmins() })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleAdminAllowlistRemove(
  req: IncomingMessage,
  res: ServerResponse,
  bindHost: string,
): Promise<void> {
  if (!isLocalBind(bindHost)) {
    sendJson(res, 403, { error: 'admin editor disabled on public binds' })
    return
  }
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { platform?: string; userId?: string }
    const platform = (parsed.platform || '').trim().toLowerCase()
    const userId = (parsed.userId || '').trim()
    if (!platform || !userId) {
      sendJson(res, 400, { error: 'platform and userId required' })
      return
    }
    const { listAdmins } = await import('../core/admin-allowlist.js')
    const remaining = listAdmins().filter((a) => !(a.platform === platform && a.userId === userId))
    const newRaw = remaining.map((a) => `${a.platform}:${a.userId}`).join(',')
    // Persist to env file. Note this nukes both runtime + env-derived
    // entries — fine for the editor's use case (it round-trips through
    // the full list).
    const { updateEnvFile } = await import('../cli-ui/env-file.js')
    updateEnvFile({ IMHUB_ADMIN_USERS: newRaw || null })
    // Update process.env so getEntries() picks it up next call.
    if (newRaw) process.env.IMHUB_ADMIN_USERS = newRaw
    else delete process.env.IMHUB_ADMIN_USERS
    // Reset the parse cache so the change is visible immediately.
    const { _resetCache } = await import('../core/admin-allowlist.js')
    _resetCache()
    sendJson(res, 200, { ok: true, admins: remaining })
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

async function handleListJobs(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const jb = await import('../core/job-board.js')
    type JobStatus = import('../core/job-board.js').JobStatus
    type JobKind = import('../core/job-board.js').JobKind
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
    const opts: { agent?: string; kind?: JobKind } = {}
    if (agent) opts.agent = agent
    if (kind) opts.kind = kind
    const jobs = jb.listJobs(limit, status, opts)
    const stats = jb.getJobStats()
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

// ─── env file (SMTP + Baidu AK + …) ────────────────────────────────────

const ENV_EDITABLE_KEYS = [
  'IMHUB_SMTP_HOST', 'IMHUB_SMTP_PORT', 'IMHUB_SMTP_USER', 'IMHUB_SMTP_PASS',
  'IMHUB_SMTP_FROM', 'IMHUB_SMTP_SECURE',
  'IMHUB_BAIDU_MAP_AK',
  'IMHUB_LOC_BASE_URL', 'IMHUB_TZ_OFFSET_HOURS',
  // Safety card toggle — drives the Claude --dangerously-skip-permissions
  // branch in plugins/agents/claude-code/index.ts. Not a secret, plain '1'/'0'.
  'IMHUB_DANGEROUSLY_SKIP_PERMISSIONS',
  // Approval Policy card — 'allow' | 'deny' (default deny). Decides what the
  // approval bus does when a tool-use prompt times out with no human reply.
  // Hot-reload: handlePutEnv mutates process.env so approval-bus picks up the
  // new value on the next timer fire, no restart needed.
  'IMHUB_TIMEOUT_DEFAULT',
  // v1.2 — IM long-message viewer. Operator sets the public URL pointing at
  // their reverse-proxied agim web port; thresholds tune when routing kicks
  // in. Hot-reload works because viewer-config reads process.env every call.
  'IMHUB_VIEWER_ENABLED',
  'IMHUB_VIEWER_PUBLIC_BASE_URL',
  'IMHUB_VIEWER_CHARS',
  'IMHUB_VIEWER_LINES',
  'IMHUB_VIEWER_CODE_LINES',
  'IMHUB_VIEWER_MAX_PASTES',
  'IMHUB_VIEWER_TUNNEL_MODE',
  // v1.1.10 — A2A notification settings (see src/core/a2a-notify.ts).
  'IMHUB_A2A_TIMEOUT_DEFAULT_MS',
  'IMHUB_A2A_MAX_TIMEOUT_MS',
  'IMHUB_A2A_NOTIFY_MODE',
  'IMHUB_A2A_NOTIFY_MAX_DEPTH',
  'IMHUB_A2A_HEARTBEAT_MIN',
  // v1.5 — long-term memory (see src/core/memory.ts + persona.ts).
  'IMHUB_MEMORY_ENABLED',
  // v1.6 — vector retrieval (opt-in, OFF by default).
  'IMHUB_MEMORY_VECTOR_BACKEND',
  'IMHUB_MEMORY_VECTOR_LOCAL_MODEL',
  'IMHUB_MEMORY_VECTOR_OPENAI_BASE_URL',
  'IMHUB_MEMORY_VECTOR_OPENAI_MODEL',
  'IMHUB_MEMORY_VECTOR_OPENAI_API_KEY',
  'IMHUB_MEMORY_VECTOR_BATCH_SIZE',
  'IMHUB_MEMORY_VECTOR_HYBRID_WEIGHT',
] as const
const SECRET_KEYS = new Set<string>(['IMHUB_SMTP_PASS', 'IMHUB_BAIDU_MAP_AK', 'IMHUB_MEMORY_VECTOR_OPENAI_API_KEY'])

// maskSecret moved to ./env-mask.ts (imported at the top of this file
// alongside isMasked).

async function handleGetEnv(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { readEnvFile } = await import('../cli-ui/env-file.js')
    const env = readEnvFile()
    const reveal = url.searchParams.get('reveal') === '1'
    const out: Record<string, string> = {}
    for (const key of ENV_EDITABLE_KEYS) {
      const v = env[key]
      if (v === undefined) continue
      out[key] = reveal ? v : (SECRET_KEYS.has(key) ? maskSecret(v) : v)
    }
    sendJson(res, 200, { env: out, secretKeys: Array.from(SECRET_KEYS) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handlePutEnv(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { updates?: Record<string, string | null> }
    const updates = parsed.updates
    if (!updates || typeof updates !== 'object') {
      sendError(res, 400, 'ENV_UPDATES_REQUIRED', { message: 'updates object required' })
      return
    }
    // Filter to whitelist — never let arbitrary keys through.
    const safe: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(updates)) {
      if (!(ENV_EDITABLE_KEYS as readonly string[]).includes(k)) continue
      if (v === null || typeof v === 'string') {
        // Defense in depth: if the client echoes a masked secret value
        // (e.g. "abcd****wxyz") back into PUT, treat it as "no change" and
        // skip the update so the real value isn't overwritten by the mask.
        if (SECRET_KEYS.has(k) && typeof v === 'string' && isMasked(v)) continue
        safe[k] = v
      }
    }
    if (Object.keys(safe).length === 0) {
      sendError(res, 400, 'ENV_NO_EDITABLE_KEYS', { message: 'no editable keys in updates' })
      return
    }
    const { updateEnvFile } = await import('../cli-ui/env-file.js')
    updateEnvFile(safe)
    // Hot-reload: mutate process.env so modules that re-read on use (e.g.
    // approval-bus's isTimeoutDefaultAllow) pick up the change without
    // waiting for a service restart. Modules that capture at module load
    // (most SMTP / Baidu callers) still need a restart to see the new value
    // — that's a per-module decision, not enforced here.
    for (const [k, v] of Object.entries(safe)) {
      if (v === null) delete process.env[k]
      else process.env[k] = v
    }
    sendJson(res, 200, { ok: true, updated: Object.keys(safe) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// POST /api/messengers/email/test — verify SMTP credentials currently in
// process.env by opening a fresh nodemailer transporter and calling
// `verify()`. Doesn't actually send mail. Returns { ok, message } on
// success or { ok: false, error } with a clean error string. Operators
// save first, then click "Test" — same UX as v1's settings page.
//
// R12: per-token rate limit. Each verify spends up to 22s of timeouts
// (8 + 6 + 8). Without a gate, a leaked / shared token could open
// dozens of parallel SMTP connections to the configured host. The
// cooldown is per-tokenId, so multiple admins don't block each other,
// and intentionally NOT shared across the SMTP host so a single user
// can probe their own config back-to-back after they realise they
// fat-fingered the port.
const emailTestCooldown = new Map<string, number>()
const EMAIL_TEST_COOLDOWN_MS = 30_000

async function handleEmailTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Drain body even though we don't use it, so the connection doesn't
    // stall under keep-alive.
    await readBody(req, res)

    // Rate limit check. The R9 verifyClient path attaches _agimTokenId
    // to upgraded requests; for REST checkAuth runs prior and the
    // tokenId is verified but not retained. Re-extract here so we
    // have a key. Loopback / IMHUB_WEB_AUTH=off → 'anon' (one shared
    // bucket; fine for the local-CLI use case).
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const tok = extractToken(req, url)
    const tokenId = (tok ? verifyTokenSync(tok) : null) ?? 'anon'
    const last = emailTestCooldown.get(tokenId)
    if (last !== undefined && Date.now() - last < EMAIL_TEST_COOLDOWN_MS) {
      const waitSec = Math.ceil((EMAIL_TEST_COOLDOWN_MS - (Date.now() - last)) / 1000)
      sendError(res, 429, 'RATE_LIMITED', {
        detail: `Wait ${waitSec}s before testing SMTP again`,
        extra: { retryAfterSec: waitSec },
      })
      return
    }
    emailTestCooldown.set(tokenId, Date.now())

    const host = process.env.IMHUB_SMTP_HOST?.trim()
    const user = process.env.IMHUB_SMTP_USER?.trim()
    const pass = process.env.IMHUB_SMTP_PASS
    if (!host || !user || !pass) {
      sendError(res, 400, 'EMAIL_NOT_CONFIGURED', {
        message: 'SMTP not configured (host / user / pass required)',
      })
      return
    }
    const portRaw = process.env.IMHUB_SMTP_PORT?.trim()
    const portNum = portRaw ? Number.parseInt(portRaw, 10) : 465
    const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 465
    const secureRaw = process.env.IMHUB_SMTP_SECURE?.trim().toLowerCase()
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
    sendError(res, 400, 'EMAIL_VERIFY_FAILED', { detail: msg })
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

// ─── v1.5 Memory admin handlers ──────────────────────────────────────

function readUserKey(url: URL): string | null {
  const k = url.searchParams.get('user_key')
  if (!k || !k.includes(':')) return null
  return k
}

async function handleMemoryUsers(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { listUsers } = await import('../core/memory.js')
    sendJson(res, 200, { users: listUsers() })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
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
let remoteHotCache: { fetchedAt: number; data: unknown } | null = null
const REMOTE_HOT_TTL_MS = 5 * 60_000

async function handleSkillsRemoteHot(_req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const parsed = JSON.parse(body) as { baseUrl?: unknown; register?: unknown }
    const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : ''
    // Strict-boolean: only literal `true` enables auto-registration. A
    // truthy `{}` / 'yes' / 1 won't trip it.
    const register = parsed.register === true
    if (!baseUrl) {
      sendError(res, 400, 'ACP_BASEURL_REQUIRED', { message: 'Missing baseUrl' })
      return
    }
    // Guard SSRF: discovery doesn't forward auth, but a malicious baseUrl
    // can still probe internal services (e.g. cloud metadata).
    const { assertSafeAcpUrl, UnsafeAcpUrlError } = await import('../plugins/agents/acp/url-guard.js')
    try {
      await assertSafeAcpUrl(baseUrl, { forwardsCredentials: false })
    } catch (err) {
      if (err instanceof UnsafeAcpUrlError) {
        sendError(res, 400, 'ACP_URL_BLOCKED', { detail: err.message, extra: { reason: err.reason } })
        return
      }
      throw err
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
    if (!res.headersSent) {
      sendError(res, status, 'ACP_DISCOVER_FAILED', { detail: msg })
    }
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
      sendError(res, 400, 'INVALID_JSON_BODY', { message: 'Invalid JSON body' })
      return
    }
    const { endpoint, auth } = parsed
    if (!endpoint || typeof endpoint !== 'string') {
      sendError(res, 400, 'ACP_ENDPOINT_REQUIRED', { message: 'Missing or invalid "endpoint"' })
      return
    }

    // Guard SSRF + credential exfil: the manifest fetch carries the
    // operator-supplied auth.token in the Authorization header, so a
    // malicious endpoint URL would have it on the wire. Require https
    // when a token would travel.
    const hasAuthToken = !!(
      auth && typeof auth === 'object'
      && typeof (auth as Record<string, unknown>).token === 'string'
      && (auth as Record<string, string>).token.length > 0
    )
    const { assertSafeAcpUrl, UnsafeAcpUrlError } = await import('../plugins/agents/acp/url-guard.js')
    try {
      await assertSafeAcpUrl(endpoint, { forwardsCredentials: hasAuthToken })
    } catch (err) {
      if (err instanceof UnsafeAcpUrlError) {
        sendError(res, 400, 'ACP_URL_BLOCKED', { detail: err.message, extra: { reason: err.reason } })
        return
      }
      throw err
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
    sendError(res, 400, 'ACP_TEST_FAILED', { detail: msg })
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

/**
 * Send a machine-readable error response. The SPA's `lib/api/client.ts`
 * reads `body.code` and maps it through `errors.json` → user-facing text;
 * the legacy `error` string remains as a fallback for tools that don't
 * speak the code dictionary (curl, older clients, tests grepping the
 * response).
 *
 * Convention: codes are UPPER_SNAKE, namespaced by feature when needed
 * (e.g. `EMAIL_NOT_CONFIGURED`, `MEMORY_USER_KEY_REQUIRED`). Bare names
 * like `VALIDATION` / `NOT_FOUND` cover broad buckets. Add new entries
 * to `src/web-app/src/i18n/locales/{en,zh}/errors.json` together with
 * the call site so the SPA picks up the human text.
 *
 * Use `detail` when the human message has variable parts the SPA can
 * interpolate (`{{detail}}` in the i18n template). Use `message` when
 * you want a fully-formed line that's safe to surface verbatim (the
 * SPA fallback path renders this when no per-code key exists).
 */
function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  options?: { message?: string; detail?: string; extra?: Record<string, unknown> },
): void {
  const message = options?.message ?? options?.detail ?? code
  // R12: always include `ok: false` so legacy SPA / curl tooling that
  // grepped the response for that flag keeps working through the
  // mid-migration window. Pre-R12 only the ACP / email subset spliced
  // it via `extra`, leaving CONFIG_* / ENV_* / MEMORY_* paths bare.
  // Listing it first in the body keeps it predictable for line-oriented
  // tools (curl | grep ok=false).
  const body: Record<string, unknown> = { ok: false, error: message, code }
  if (options?.detail !== undefined) body.detail = options.detail
  if (options?.extra) Object.assign(body, options.extra)
  sendJson(res, status, body)
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
  return `agim_token=${value}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`
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
  /** R9: shared threadId → tokenId map. The handler validates
   *  ownership before adopting a client-supplied threadId. */
  threadOwners?: Map<string, string>,
): Promise<void> {
  const { ws } = client
  // Read client.id fresh — `get-history` may rekey it mid-handler so the
  // session lookup matches the client's persisted threadId.
  let clientId = client.id

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
      await sendSessionHistory(ws, clientId, defaultAgent)
      break
    }

    // v1's "New conversation" button in the web chat. Clears the
    // session messages, forks a fresh session id, drops per-agent CLI
    // session bindings (Claude/opencode/codex) and any auto-allow
    // approval rules, so the next prompt starts on a clean slate. The
    // WS client receives a follow-up `history` message with an empty
    // list so the UI repaints the cleared state.
    case 'new-conversation': {
      await sessionManager.resetConversation('web', 'web', clientId)
      sendToClient(ws, { type: 'history', messages: [], agent: client.agent })
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
      "img-src 'self' data:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  })
  res.end(html)
}
