// HTTP side of MCP OAuth.
//
// Unauthenticated MCP calls return 401 with a protected-resource challenge
// so ChatGPT can discover the authorization server. A bridge token is not
// accepted. Poll and webhook delivery are not handled here.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BridgePeer } from '../core/bridge-peers.js'
import { effectiveCallbackMode, loadBridgePeers } from '../core/bridge-peers.js'
import {
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  authorizationServerMetadata,
  evaluateAuthorize,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  mcpResourceIdentifier,
  OAUTH_SCOPE,
  PROTECTED_RESOURCE_PATH,
  protectedResourceMetadata,
  readAccessToken,
  type AuthorizeInput,
} from '../core/bridge-mcp-oauth.js'
import { isBridgeEnabled } from '../core/bridge-switch.js'
import { getRequestUserId, isRequestAdmin } from './auth.js'
import { resolveBridgePublicBase } from './bridge-caller-guide.js'
import { readBody } from './http-utils.js'

const PROTECTED_ROOT = '/.well-known/oauth-protected-resource'

function canonicalPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '')
  return pathname
}

function bearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (typeof auth !== 'string') return null
  if (!auth.startsWith('Bearer ')) return null
  const value = auth.slice('Bearer '.length).trim()
  return value || null
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    ...extra,
  })
  res.end(JSON.stringify(body))
}

function sendOauthError(res: ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description })
}

function sendMcpUnauthorized(res: ServerResponse, metadata: string | null, error: 'invalid_request' | 'invalid_token'): void {
  const description = metadata ? 'You need to login to continue' : 'public origin is not configured'
  const challenge = metadata
    ? `Bearer resource_metadata="${metadata}", scope="${OAUTH_SCOPE}", error="${error}", error_description="${description}"`
    : `Bearer scope="${OAUTH_SCOPE}", error="${error}", error_description="${description}"`
  sendJson(res, 401, {
    error: description,
    code: 'MCP_OAUTH_REQUIRED',
  }, { 'WWW-Authenticate': challenge })
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;'
    if (ch === '<') return '&lt;'
    if (ch === '>') return '&gt;'
    if (ch === '"') return '&quot;'
    return '&#39;'
  })
}

function authorizeInput(url: URL): AuthorizeInput {
  return {
    responseType: url.searchParams.get('response_type') || '',
    clientId: url.searchParams.get('client_id') || '',
    redirectUri: url.searchParams.get('redirect_uri') || '',
    codeChallenge: url.searchParams.get('code_challenge') || '',
    codeChallengeMethod: url.searchParams.get('code_challenge_method') || '',
    resource: url.searchParams.get('resource') || '',
    scope: url.searchParams.get('scope') || '',
    state: url.searchParams.get('state') || '',
  }
}

function redirectLocation(redirectUri: string, issuer: string, fields: Record<string, string>): string {
  const dest = new URL(redirectUri)
  for (const [key, value] of Object.entries(fields)) {
    if (value) dest.searchParams.set(key, value)
  }
  dest.searchParams.set('iss', issuer)
  return dest.toString()
}

function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

async function readForm(req: IncomingMessage, res: ServerResponse): Promise<URLSearchParams | null> {
  try {
    const raw = await readBody(req, res)
    return new URLSearchParams(raw)
  } catch (err) {
    if ((err as { handled?: boolean }).handled || res.headersSent) return null
    sendOauthError(res, 400, 'invalid_request', 'form body is required')
    return null
  }
}

const CONSENT_CSS = `
@font-face {
  font-family: "Agim CJK";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2") format("woff2");
  unicode-range: U+3000-303F, U+4E00-9FFF, U+FF00-FFEF;
}
@font-face {
  font-family: "Agim CJK";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("/fonts/noto-sans-sc-chinese-simplified-700-normal.woff2") format("woff2");
  unicode-range: U+3000-303F, U+4E00-9FFF, U+FF00-FFEF;
}
:root {
  --ag-bg: 210 40% 98%;
  --ag-surface: 0 0% 100%;
  --ag-surface-2: 220 14% 94%;
  --ag-surface-hover: 220 14% 92%;
  --ag-border: 220 13% 90%;
  --ag-text: 220 13% 13%;
  --ag-text-dim: 220 6% 38%;
  --ag-accent: 246 80% 60%;
  --ag-accent-fg: 0 0% 100%;
  --ag-accent-hover: 246 80% 52%;
  --ag-shadow-sm: 0 1px 2px hsl(220 13% 13% / 0.05);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ag-bg: 220 10% 7%;
    --ag-surface: 220 12% 11%;
    --ag-surface-2: 220 12% 14%;
    --ag-surface-hover: 220 12% 16%;
    --ag-border: 220 10% 20%;
    --ag-text: 220 14% 91%;
    --ag-text-dim: 220 8% 68%;
    --ag-accent: 246 90% 72%;
    --ag-accent-fg: 220 30% 5%;
    --ag-accent-hover: 246 90% 80%;
    --ag-shadow-sm: 0 1px 2px hsl(0 0% 0% / 0.4);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem 1rem;
  background: hsl(var(--ag-bg));
  color: hsl(var(--ag-text));
  font-family: "Agim CJK", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.card {
  width: 100%;
  max-width: 28rem;
  padding: 1.25rem 1.25rem 1rem;
  background: hsl(var(--ag-surface));
  border: 1px solid hsl(var(--ag-border));
  border-radius: 0.75rem;
  box-shadow: var(--ag-shadow-sm);
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.4;
}
.lead {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  line-height: 1.5;
  color: hsl(var(--ag-text-dim));
}
.label {
  margin: 0 0 0.25rem;
  font-size: 0.75rem;
  color: hsl(var(--ag-text-dim));
}
.value {
  margin: 0 0 0.75rem;
  padding: 0.5rem 0.625rem;
  overflow-wrap: anywhere;
  word-break: break-word;
  border-radius: 0.375rem;
  background: hsl(var(--ag-surface-2));
  font-family: "Agim CJK", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.75rem;
  line-height: 1.45;
}
form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
button {
  min-height: 2.25rem;
  padding: 0 1.25rem;
  border-radius: 0.375rem;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid hsl(var(--ag-accent));
  outline-offset: 2px;
}
.primary {
  border: 1px solid transparent;
  background: hsl(var(--ag-accent));
  color: hsl(var(--ag-accent-fg));
}
.primary:hover { background: hsl(var(--ag-accent-hover)); }
.secondary {
  border: 1px solid hsl(var(--ag-border));
  background: hsl(var(--ag-surface));
  color: hsl(var(--ag-text));
}
.secondary:hover { background: hsl(var(--ag-surface-hover)); }
`

function consentPage(url: URL, redirectUri: string, clientId: string): string {
  const action = esc(url.pathname + url.search)
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>允许 ChatGPT 连接 Agim</title>
<style>${CONSENT_CSS}</style>
</head>
<body>
  <main class="card">
    <h1>允许 ChatGPT 连接 Agim</h1>
    <p class="lead">允许后，这个插件可以用当前管理员账号调用桥接。桥接令牌不是这次登录。</p>
    <p class="label">回跳地址</p>
    <p class="value">${esc(redirectUri)}</p>
    <p class="label">客户端</p>
    <p class="value">${esc(clientId)}</p>
    <form method="post" action="${action}">
      <button class="primary" type="submit" name="consent" value="allow">允许</button>
      <button class="secondary" type="submit" name="consent" value="deny">拒绝</button>
    </form>
  </main>
</body>
</html>`
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL, origin: string | null): Promise<void> {
  const input = authorizeInput(url)
  const decision = await evaluateAuthorize(input, origin)
  if (!decision.ok) {
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept : ''
    if (accept.includes('text/html') && !accept.includes('application/json')) {
      sendHtml(res, decision.status, `<!DOCTYPE html><html lang="zh"><body><p>${esc(decision.description)}</p></body></html>`)
      return
    }
    sendOauthError(res, decision.status, decision.error, decision.description)
    return
  }
  if (!isRequestAdmin(req)) {
    sendOauthError(res, 403, 'access_denied', 'admin role required')
    return
  }
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'POST') {
    const form = await readForm(req, res)
    if (!form) return
    const consent = form.get('consent')
    if (consent === 'deny') {
      sendRedirect(res, redirectLocation(decision.redirectUri, decision.issuer, {
        error: 'access_denied',
        error_description: 'the admin denied the connection',
        state: input.state,
      }))
      return
    }
    if (consent !== 'allow') {
      sendHtml(res, 200, consentPage(url, decision.redirectUri, input.clientId))
      return
    }
    const subject = getRequestUserId(req) || 'admin'
    const code = await issueAuthorizationCode({
      challenge: input.codeChallenge,
      redirectUri: decision.redirectUri,
      clientId: input.clientId,
      resource: decision.resource,
      scope: decision.scope,
      subject,
    })
    if (!code) {
      sendOauthError(res, 400, 'invalid_request', 'redirect_uri is not allowed')
      return
    }
    sendRedirect(res, redirectLocation(decision.redirectUri, decision.issuer, {
      code,
      state: input.state,
    }))
    return
  }
  if (method !== 'GET') {
    sendOauthError(res, 405, 'invalid_request', 'method not allowed')
    return
  }
  sendHtml(res, 200, consentPage(url, decision.redirectUri, input.clientId))
}

async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const type = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : ''
  if (!type.includes('application/x-www-form-urlencoded')) {
    sendOauthError(res, 400, 'invalid_request', 'content-type must be application/x-www-form-urlencoded')
    return
  }
  const form = await readForm(req, res)
  if (!form) return
  const issued = await exchangeAuthorizationCode({
    grantType: form.get('grant_type') || '',
    code: form.get('code') || '',
    redirectUri: form.get('redirect_uri') || '',
    clientId: form.get('client_id') || '',
    codeVerifier: form.get('code_verifier') || '',
    resource: form.get('resource') || '',
    clientSecret: form.get('client_secret') || '',
    clientAssertion: form.get('client_assertion') || '',
  })
  if (!issued.ok) {
    sendOauthError(res, issued.status, issued.error, issued.description)
    return
  }
  sendJson(res, 200, {
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresIn,
    scope: issued.scope,
  })
}

function mcpEventsPeer(): BridgePeer | null {
  return loadBridgePeers().find((peer) => peer.enabled && effectiveCallbackMode(peer) === 'mcp_events') ?? null
}

function stubPeer(): BridgePeer {
  return {
    peerId: 'mcp-oauth',
    tokenId: 'oauth',
    agents: ['agim'],
    workspaceId: 'default',
    callbackMode: 'mcp_events',
    callbackUrl: null,
    signingSecret: null,
    enabled: true,
    maxConcurrent: 1,
    callbackPinnedHost: null,
  }
}

function withOauthScheme(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const tools = (result as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return result
  return {
    tools: tools.map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool
      return {
        ...(tool as Record<string, unknown>),
        securitySchemes: [{ type: 'oauth2', scopes: [OAUTH_SCOPE] }],
      }
    }),
  }
}

function localMcpResult(method: string, params: unknown): unknown | undefined {
  if (method === 'initialize') {
    const requested = params && typeof params === 'object' && !Array.isArray(params)
      && typeof (params as { protocolVersion?: unknown }).protocolVersion === 'string'
      ? (params as { protocolVersion: string }).protocolVersion
      : ''
    const supported = ['2026-07-28', '2025-06-18', '2025-03-26']
    return {
      protocolVersion: supported.includes(requested) ? requested : '2026-07-28',
      capabilities: { tools: {}, events: {} },
      serverInfo: { name: 'agim', version: 'agim' },
      instructions: 'Use agim_create_run to start work and agim_get_run to read the full result. events/subscribe brings its own delivery URL and secret.',
    }
  }
  if (method === 'server/discover') {
    return {
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, events: {} },
    }
  }
  if (method === 'ping') return {}
  return undefined
}

async function dispatchAuthenticated(method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; code: number; message: string }> {
  const local = localMcpResult(method, params)
  if (local !== undefined) return { ok: true, result: local }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return { ok: true, result: {} }
  if (method === 'tools/call' || method === 'events/subscribe') {
    if (!isBridgeEnabled()) return { ok: false, code: -32000, message: 'bridge is off' }
  }
  const peer = method === 'tools/call' ? mcpEventsPeer() : (mcpEventsPeer() ?? stubPeer())
  if (method === 'tools/call' && !peer) {
    return { ok: false, code: -32024, message: 'an enabled MCP Events caller is required' }
  }
  const { dispatchBridgeMcp } = await import('../core/bridge-mcp-tools.js')
  const dispatched = await dispatchBridgeMcp(method, params, { peer: peer ?? stubPeer() })
  if (method === 'tools/list' && dispatched.ok) return { ok: true, result: withOauthScheme(dispatched.result) }
  return dispatched
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, origin: string | null): Promise<void> {
  const metadata = origin ? `${origin}${PROTECTED_RESOURCE_PATH}` : null
  const resource = origin ? mcpResourceIdentifier(origin) : ''
  const token = bearer(req)
  const access = token && resource ? readAccessToken(token, resource) : null
  if (!access) {
    sendMcpUnauthorized(res, metadata, token ? 'invalid_token' : 'invalid_request')
    return
  }
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readBody(req, res) || 'null') as unknown
  } catch (err) {
    if ((err as { handled?: boolean }).handled || res.headersSent) return
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } })
    return
  }
  const msg = parsed as { method?: unknown; id?: unknown; params?: unknown }
  const hasId = Object.hasOwn(msg, 'id')
  if (typeof msg.method !== 'string' || !msg.method) {
    sendJson(res, 400, { jsonrpc: '2.0', id: hasId ? msg.id ?? null : null, error: { code: -32600, message: 'invalid request' } })
    return
  }
  if (!hasId && msg.method.startsWith('notifications/')) {
    res.writeHead(202, { 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  const dispatched = await dispatchAuthenticated(msg.method, msg.params)
  if (!dispatched.ok) {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      error: { code: dispatched.code, message: dispatched.message },
    })
    return
  }
  sendJson(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, result: dispatched.result })
}

function metadataFor(pathname: string, origin: string): Record<string, unknown> | null {
  if (pathname === PROTECTED_ROOT || pathname === PROTECTED_RESOURCE_PATH) return protectedResourceMetadata(origin)
  if (pathname === AUTHORIZATION_SERVER_PATH) return authorizationServerMetadata(origin)
  return null
}

export async function handleBridgeOauthHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = canonicalPath(url.pathname)
  const m = (req.method || 'GET').toUpperCase()
  const origin = resolveBridgePublicBase(req)
  const metadata = metadataFor(p, origin || '')
  if (metadata) {
    if (!origin) {
      sendOauthError(res, 503, 'server_error', 'public origin is not configured')
      return true
    }
    if (m !== 'GET') {
      sendOauthError(res, 405, 'invalid_request', 'method not allowed')
      return true
    }
    sendJson(res, 200, metadata)
    return true
  }
  if (p === AUTHORIZE_PATH) {
    await handleAuthorize(req, res, url, origin)
    return true
  }
  if (p === '/api/bridge/oauth/token' && m === 'POST') {
    await handleToken(req, res)
    return true
  }
  if (p === '/api/bridge/oauth/token') {
    sendOauthError(res, 405, 'invalid_request', 'method not allowed')
    return true
  }
  if (p === '/api/bridge/mcp' && m === 'POST') {
    await handleMcp(req, res, origin)
    return true
  }
  if (p === '/api/bridge/mcp') {
    await handleMcp(req, res, origin)
    return true
  }
  return false
}
