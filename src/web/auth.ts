// auth — web authentication and authorization helpers.
// Extracted from server.ts so handler modules can gate requests without
// importing the full server dependency graph.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { logger as rootLogger } from '../core/logger.js'
import { sendError, sendJson, readBody } from './http-utils.js'

/** v1.1.10 — paths that never require a web token. */
export const PUBLIC_EXACT_PATHS = new Set<string>([
  '/login', '/login.html',
  '/register', '/register.html',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/captcha',
  '/api/auth/bootstrap-state',
  // CR P2c — one-shot exchange of mobile QR code → raw token (no auth yet).
  '/api/auth/exchange-mobile',
  '/api/health',
  '/loc', '/loc.html',
  // POST /api/loc (the bare path, no trailing slash) is the H5 page's
  // "submit my coordinates" endpoint. It's authenticated by the single-use
  // location token in the request body, NOT by the web access token.
  '/api/loc',
  // Mobile QR landing. Prefers short-TTL `?c=<code>` (exchanged server-side);
  // legacy `?t=<raw>` still accepted for old QR images.
  '/m/login', '/m/login.html',
  '/favicon.ico', '/favicon.svg',
])
// v1.2.153 — `/assets/` added so SPA can bootstrap on cookie-expired
// loads: the index.html is public (`/login` exact-path), but it
// references `/assets/index-*.js` and `/assets/index-*.css` via
// vite-built script tags. Without this prefix, the bundle 302's to
// `/login` and the browser parses the redirect HTML as JavaScript → MIME
// error → white screen → user can't even reach the login form. The
// vendor/ prefix has been public for the same reason; assets/ is the
// agim-built sibling. Bundle contents are minified app code with no
// secrets — same trust model as serving the index.html itself.
//
// v1.5.43 — `/fonts/` must be public too. SPA CSS declares @font-face
// pointing at `/fonts/noto-sans-sc-*.woff2` (Agim CJK). When that URL
// 302's to /login (HTML), WKWebView silently fails the webfont and
// Chinese paints as tofu / [?]. Fonts are OFL-licensed static files
// with no secrets — same trust model as /assets/.
export const PUBLIC_PREFIX_PATHS: string[] = ['/l/', '/v/', '/api/loc/', '/vendor/', '/assets/', '/fonts/']

export function isPublicPath(pathname: string, _method: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true
  for (const p of PUBLIC_PREFIX_PATHS) if (pathname.startsWith(p)) return true
  return false
}

export function isLoopbackPeer(req: IncomingMessage): boolean {
  // Treat an empty / missing remoteAddress as untrusted: under exotic
  // transports or post-close sockets the field can read empty, which
  // pre-R9 would silently pass auth. Tighten to exact loopback IPs
  // (with the IPv4-mapped IPv6 form Node uses on dual-stack servers).
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  return ip === '127.0.0.1' || ip === '::1'
}

export function isEnvOff(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false' || v === 'no'
}

export function hasForwardedPeerHeaders(req: IncomingMessage): boolean {
  return req.headers.forwarded !== undefined
    || req.headers['x-forwarded-for'] !== undefined
    || req.headers['x-forwarded-host'] !== undefined
    || req.headers['x-real-ip'] !== undefined
    || req.headers['cf-connecting-ip'] !== undefined
}

export function isTrustedLoopbackPeer(req: IncomingMessage): boolean {
  if (!isLoopbackPeer(req)) return false
  if (isEnvOff('AGIM_TRUST_LOOPBACK')) return false
  // A reverse proxy on the same host makes remote users appear as
  // 127.0.0.1. Treat forwarded requests as network traffic and require
  // the normal token path instead of granting the local bootstrap bypass.
  if (hasForwardedPeerHeaders(req)) return false
  return true
}

/** R13 A5 — track once-per-process whether the deprecated `?token=`
 *  URL fallback has been used, so we warn at most once per service
 *  lifetime instead of spamming the journal. Cleared by tests via
 *  re-importing the module fresh. */
export let _queryTokenWarned = false

export function readCookie(req: IncomingMessage, name: string): string | null {
  const cookie = req.headers.cookie
  if (typeof cookie !== 'string') return null
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) {
      const v = decodeURIComponent(rest.join('=').trim())
      return v || null
    }
  }
  return null
}

export function extractSessionRaw(req: IncomingMessage): string | null {
  return readCookie(req, 'agim_session')
}

export function extractToken(req: IncomingMessage, url: URL): string | null {
  // 1. Authorization: Bearer <token>
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const v = auth.slice(7).trim()
    if (v) return v
  }
  // 2. Cookie agim_token=<token>
  const fromCookie = readCookie(req, 'agim_token')
  if (fromCookie) return fromCookie
  // 3. ?token=...  (deprecated — kept for WS upgrade / iframe compat)
  //
  // R13 A5 — query-string tokens leak to:
  //   * browser history / bookmarks
  //   * Referer headers when the page links to a third party
  //   * any HTTP-proxy / WAF / CDN access log between client and agim
  //
  // We warn loudly the first time it's used per process lifetime
  // (rate-limited so a misbehaving client doesn't fill the journal)
  // + emit a one-shot audit-event row. Operators should migrate
  // callers to Authorization: Bearer or the agim_token cookie.
  const q = url.searchParams.get('token')
  if (q) {
    if (!_queryTokenWarned) {
      _queryTokenWarned = true
      rootLogger.warn({
        component: 'web',
        event: 'web.auth.query_token_used',
        path: url.pathname,
        msg: '?token= URL fallback used; prefer Authorization: Bearer or agim_token cookie '
          + '(query token leaks to browser history / Referer / proxy logs)',
      })
      try {
        void (async () => {
          const { logAuditEvent } = await import('../core/audit-log.js')
          logAuditEvent({
            eventType: 'config.put',
            actor: 'system',
            target: 'web.auth.query_token',
            outcome: 'ok',
            details: { reason: 'query_token_used', path: url.pathname },
          })
        })()
      } catch { /* best-effort */ }
    }
    return q
  }
  return null
}

// access-token.verifyToken cached lookup. We avoid await in checkAuth by
// pre-loading via a small wrapper. ESM top-level await isn't an option in
// the codebase style, so import on first use and stash the handle.
export let _tokenModule: typeof import('../core/access-token.js') | null = null

/** Bind the access-token module. Called by startWebServer after importing it. */
export function bindTokenModule(mod: typeof import('../core/access-token.js') | null): void {
  _tokenModule = mod
}

export function verifyTokenSync(raw: string): string | null {
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

export interface WebIdentity {
  kind: 'auth-off' | 'loopback' | 'session' | 'token'
  role: 'admin' | 'user'
  userId?: string
  tokenId?: string
  username?: string
}

let _accountsMod: typeof import('../core/accounts.js') | null = null

function accountsMod(): typeof import('../core/accounts.js') | null {
  return _accountsMod
}

export function bindAccountsModule(mod: typeof import('../core/accounts.js') | null): void {
  _accountsMod = mod
}

function usersExist(): boolean {
  const mod = accountsMod()
  if (!mod) return false
  try { return mod.hasAnyUser() } catch { return false }
}

export function resolveWebIdentity(req: IncomingMessage, url?: URL): WebIdentity | null {
  if ((process.env.AGIM_WEB_AUTH || '').toLowerCase() === 'off') {
    return { kind: 'auth-off', role: 'admin' }
  }
  let parsed = url
  if (!parsed) {
    try { parsed = new URL(req.url || '', 'http://localhost') } catch { parsed = undefined }
  }
  const acc = accountsMod()
  const sessionRaw = extractSessionRaw(req)
  if (sessionRaw && acc) {
    try {
      const user = acc.verifyLoginSession(sessionRaw)
      if (user) {
        return {
          kind: 'session',
          role: user.role,
          userId: user.id,
          username: user.username,
        }
      }
    } catch { /* ignore corrupt session */ }
  }
  if (parsed) {
    const tok = extractToken(req, parsed)
    if (tok) {
      const id = verifyTokenSync(tok)
      if (id && _tokenModule) {
        const tokenUserId = _tokenModule.getTokenUserId?.(id)
        if (tokenUserId && acc) {
          const user = acc.getUserById(tokenUserId)
          if (user && !user.disabled) {
            return {
              kind: 'token',
              role: user.role,
              userId: user.id,
              tokenId: id,
              username: user.username,
            }
          }
        }
        return {
          kind: 'token',
          role: _tokenModule.getTokenRole(id),
          userId: tokenUserId,
          tokenId: id,
        }
      }
    }
  }
  if (!usersExist() && isTrustedLoopbackPeer(req)) {
    return { kind: 'loopback', role: 'admin' }
  }
  return null
}

/** Returns true if the request is authenticated (or auth not required). */
export function checkAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if ((process.env.AGIM_WEB_AUTH || '').toLowerCase() === 'off') return true
  if (isPublicPath(url.pathname, req.method || 'GET')) return true
  if (resolveWebIdentity(req, url)) return true

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
  const next = encodeURIComponent(url.pathname + url.search)
  const dest = usersExist() ? '/login' : '/register'
  res.writeHead(302, { Location: `${dest}?next=${next}` })
  res.end()
  return false
}

/** Resolve a stable actor string for audit-event rows. Mirrors checkAuth's
 *  identity model:
 *    - auth disabled → 'web:auth-off'
 *    - loopback peer (no auth needed) → 'web:loopback'
 *    - verified token → 'web:<tokenId>'
 *    - otherwise → 'web:unknown' (request should already have been rejected
 *      by checkAuth — this branch exists for defensive logging). */
export function getRequestActor(req: IncomingMessage): string {
  const ident = resolveWebIdentity(req)
  if (!ident) return 'web:unknown'
  if (ident.kind === 'auth-off') return 'web:auth-off'
  if (ident.kind === 'loopback') return 'web:loopback'
  if (ident.userId) return `web:${ident.userId}`
  if (ident.tokenId) return `web:${ident.tokenId}`
  return 'web:unknown'
}

export function getRequestUserId(req: IncomingMessage): string | undefined {
  return resolveWebIdentity(req)?.userId
}

/** Resolve whether the request's actor has admin role. Used to gate
 *  mutation + privileged-read endpoints so a stolen viewer-role token
 *  can't elevate to control plane (R13 A1).
 *
 *  Trust order:
 *    1. AGIM_WEB_AUTH=off  → admin (operator explicitly disabled auth)
 *    2. Trusted loopback    → admin (operator on the host)
 *    3. Bearer token        → token.role === 'admin'
 *    4. Otherwise           → not admin
 *
 *  Note: when no token has been created yet (pre-bootstrap), the
 *  trusted-loopback branch still grants admin so the CLI bootstrap flow
 *  works. Disable it with AGIM_TRUST_LOOPBACK=off. Reverse-proxied
 *  requests with Forwarded / X-Forwarded-* peer headers never qualify. */
export function isRequestAdmin(req: IncomingMessage): boolean {
  const ident = resolveWebIdentity(req)
  return ident?.role === 'admin'
}

/** Send 403 and return false when the actor isn't admin. Use as guard:
 *  `if (!requireAdmin(req, res)) return` */
export function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (isRequestAdmin(req)) return true
  sendError(res, 403, 'AUTH_ADMIN_REQUIRED', {
    message: 'admin role required',
    extra: { loginUrl: '/login' },
  })
  return false
}

export const __webAuthForTesting = {
  isTrustedLoopbackPeer,
  isRequestAdmin,
  isPublicPath,
  resolveWebIdentity,
  setTokenModule(mod: typeof import('../core/access-token.js') | null): void {
    _tokenModule = mod
  },
  setAccountsModule(mod: typeof import('../core/accounts.js') | null): void {
    _accountsMod = mod
  },
}

// ─── Auth login / logout handlers ───────────────────────────────────────────

/** Build the cookie attribute string. When the request looks HTTPS
 *  (req.socket.encrypted OR x-forwarded-proto=https from a reverse
 *  proxy / cloudflared / nginx), include `Secure`. Without `Secure`,
 *  modern Chrome / Safari downgrade or REJECT cookies with
 *  `SameSite=Strict` on HTTPS pages, which manifests as "logged in
 *  works on the same tab once, but a refresh kicks back to /login"
 *  — the symptom the operator reported 2026-05-19.
 *  Also relax SameSite=Strict → Lax so following an external link
 *  back to the dashboard doesn't lose the session. */
function cookieSecureSuffix(req: IncomingMessage): string {
  const isHttps = (req.socket as { encrypted?: boolean }).encrypted === true
    || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
  return isHttps ? '; Secure' : ''
}

export function buildNamedCookie(
  req: IncomingMessage, name: string, token: string | null, maxAgeSec: number,
): string {
  const value = token === null ? '' : encodeURIComponent(token)
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax; HttpOnly${cookieSecureSuffix(req)}`
}

export function buildAuthCookie(req: IncomingMessage, token: string | null, maxAgeSec: number): string {
  return buildNamedCookie(req, 'agim_token', token, maxAgeSec)
}

export function buildSessionCookie(req: IncomingMessage, token: string | null, maxAgeSec: number): string {
  return buildNamedCookie(req, 'agim_session', token, maxAgeSec)
}

const loginFailures = new Map<string, { n: number; until: number }>()

export function loginNeedsCaptcha(key: string): boolean {
  const row = loginFailures.get(key)
  if (!row) return false
  if (Date.now() > row.until) {
    loginFailures.delete(key)
    return false
  }
  return row.n >= 3
}

function noteLoginFailure(key: string): void {
  const now = Date.now()
  const row = loginFailures.get(key)
  if (!row || now > row.until) {
    loginFailures.set(key, { n: 1, until: now + 15 * 60 * 1000 })
    return
  }
  row.n += 1
}

function clearLoginFailure(key: string): void {
  loginFailures.delete(key)
}

function loginKey(req: IncomingMessage, username: string): string {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  return `${ip}:${username.trim().toLowerCase()}`
}

export async function handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as {
      token?: string
      username?: string
      password?: string
      captchaId?: string
      captcha?: string
    }
    const token = (parsed.token || '').trim()
    const username = (parsed.username || '').trim()
    const maxAge = 30 * 24 * 60 * 60

    if (username) {
      const acc = accountsMod()
      if (!acc) { sendError(res, 503, 'AUTH_NOT_READY', { message: 'auth module not ready' }); return }
      const key = loginKey(req, username)
      if (loginNeedsCaptcha(key)) {
        const { consumeCaptcha } = await import('../core/captcha.js')
        if (!consumeCaptcha(parsed.captchaId || '', parsed.captcha || '')) {
          sendError(res, 400, 'AUTH_CAPTCHA', { message: 'captcha required' })
          return
        }
      }
      try {
        const session = acc.loginUser({ username, password: parsed.password || '' })
        clearLoginFailure(key)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': [
            buildSessionCookie(req, session.raw, maxAge),
            buildAuthCookie(req, null, 0),
          ],
        })
        res.end(JSON.stringify({ ok: true, user: session.user }))
        return
      } catch (err) {
        noteLoginFailure(key)
        const code = (err as { code?: string }).code || 'AUTH_INVALID'
        sendError(res, 401, code, { message: err instanceof Error ? err.message : 'invalid credentials' })
        return
      }
    }

    if (!token) { sendError(res, 400, 'AUTH_TOKEN_REQUIRED', { message: 'username/password or token required' }); return }
    if (!_tokenModule) { sendError(res, 503, 'AUTH_NOT_READY', { message: 'auth module not ready' }); return }
    const id = _tokenModule.verifyToken(token)
    if (!id) { sendError(res, 401, 'AUTH_INVALID', { message: 'invalid token' }); return }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': buildAuthCookie(req, token, maxAge),
    })
    res.end(JSON.stringify({ ok: true, tokenId: id }))
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

export function handleAuthLogout(req: IncomingMessage, res: ServerResponse): void {
  const raw = extractSessionRaw(req)
  if (raw) {
    try { accountsMod()?.revokeLoginSession(raw) } catch { /* ignore */ }
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': [
      buildAuthCookie(req, null, 0),
      buildSessionCookie(req, null, 0),
    ],
  })
  res.end(JSON.stringify({ ok: true }))
}

/** POST /api/auth/exchange-mobile — redeem a short-TTL QR exchange code
 *  for the underlying raw access token. Public (code is the capability).
 *  One-shot: second redeem → 401. */
export async function handleAuthExchangeMobile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { code?: string }
    const code = (parsed.code || '').trim()
    if (!code) {
      sendError(res, 400, 'AUTH_CODE_REQUIRED', { message: 'code required' })
      return
    }
    const { consumeMobileQrExchange } = await import('../core/mobile-qr-exchange.js')
    const exchanged = consumeMobileQrExchange(code)
    if (!exchanged) {
      sendError(res, 401, 'AUTH_INVALID', { message: 'invalid or expired code' })
      return
    }
    if (!_tokenModule) {
      sendError(res, 503, 'AUTH_NOT_READY', { message: 'auth module not ready' })
      return
    }
    const id = _tokenModule.verifyToken(exchanged.raw)
    if (!id) {
      sendError(res, 401, 'AUTH_INVALID', { message: 'token revoked' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify({ ok: true, token: exchanged.raw, tokenId: id }))
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
