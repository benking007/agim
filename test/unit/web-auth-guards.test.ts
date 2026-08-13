import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { __webAuthForTesting } from '../../src/web/server.js'

function req(opts: {
  remoteAddress?: string
  headers?: Record<string, string>
  url?: string
} = {}): IncomingMessage {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    headers: opts.headers ?? {},
    url: opts.url ?? '/api/jobs',
  } as unknown as IncomingMessage
}

describe('web auth guard hardening', () => {
  let tmpHome = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agim-web-auth-test-'))
    saved.AGIM_HOME = process.env.AGIM_HOME
    saved.AGIM_HOME = process.env.AGIM_HOME
    saved.AGIM_WEB_AUTH = process.env.AGIM_WEB_AUTH
    saved.AGIM_TRUST_LOOPBACK = process.env.AGIM_TRUST_LOOPBACK
    process.env.AGIM_HOME = tmpHome
    delete process.env.AGIM_HOME
    delete process.env.AGIM_WEB_AUTH
    delete process.env.AGIM_TRUST_LOOPBACK
  })

  afterEach(() => {
    __webAuthForTesting.setTokenModule(null)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('trusts direct loopback by default for local CLI/browser use', () => {
    expect(__webAuthForTesting.isTrustedLoopbackPeer(req())).toBe(true)
  })

  it('does not trust loopback when proxy peer headers are present', () => {
    expect(__webAuthForTesting.isTrustedLoopbackPeer(req({
      headers: { 'x-forwarded-for': '203.0.113.10' },
    }))).toBe(false)
  })

  it('honors AGIM_TRUST_LOOPBACK=off', () => {
    process.env.AGIM_TRUST_LOOPBACK = 'off'
    expect(__webAuthForTesting.isTrustedLoopbackPeer(req())).toBe(false)
  })

  it('does not treat role=user tokens as admin on proxied requests', async () => {
    const tokenModule = await import('../../src/core/access-token.js')
    __webAuthForTesting.setTokenModule(tokenModule)
    const userToken = tokenModule.createToken('mobile-via-qr-test', { role: 'user' })

    expect(__webAuthForTesting.isRequestAdmin(req({
      headers: {
        authorization: `Bearer ${userToken.raw}`,
        'x-forwarded-for': '203.0.113.10',
      },
    }))).toBe(false)
  })

  it('accepts role=admin tokens on proxied requests', async () => {
    const tokenModule = await import('../../src/core/access-token.js')
    __webAuthForTesting.setTokenModule(tokenModule)
    const adminToken = tokenModule.createToken('admin-test', { role: 'admin' })

    expect(__webAuthForTesting.isRequestAdmin(req({
      headers: {
        authorization: `Bearer ${adminToken.raw}`,
        'x-forwarded-for': '203.0.113.10',
      },
    }))).toBe(true)
  })
})

// v1.2.153 — regression test for the cookie-expired white-screen bug.
// Pre-1.2.153 the SPA bundle under `/assets/` required a token, so a
// reverse-proxied user with no cookie got 302'd to /login when fetching
// the JS — but the JS request returned login HTML, breaking module MIME
// and never letting them reach the login form. /assets/ is now public.
describe('v1.2.153: isPublicPath — SPA bundle bootstrap', () => {
  it('treats /assets/<vite-hash>.{js,css} as public so SPA can boot uncookied', () => {
    expect(__webAuthForTesting.isPublicPath('/assets/index-BihXHOze.js', 'GET')).toBe(true)
    expect(__webAuthForTesting.isPublicPath('/assets/index-uKzGZ_Df.css', 'GET')).toBe(true)
    expect(__webAuthForTesting.isPublicPath('/assets/react-C9F3QeMB.js', 'GET')).toBe(true)
  })

  it('keeps API + admin paths gated — the fix scopes to /assets/ (+ /fonts/)', () => {
    expect(__webAuthForTesting.isPublicPath('/api/agim-skills', 'GET')).toBe(false)
    expect(__webAuthForTesting.isPublicPath('/api/config', 'GET')).toBe(false)
    expect(__webAuthForTesting.isPublicPath('/api/jobs', 'POST')).toBe(false)
    expect(__webAuthForTesting.isPublicPath('/tasks', 'GET')).toBe(false)
  })

  it('keeps the pre-existing public set intact (regression guard)', () => {
    expect(__webAuthForTesting.isPublicPath('/login', 'GET')).toBe(true)
    expect(__webAuthForTesting.isPublicPath('/api/auth/login', 'POST')).toBe(true)
    expect(__webAuthForTesting.isPublicPath('/favicon.svg', 'GET')).toBe(true)
    expect(__webAuthForTesting.isPublicPath('/vendor/chart.umd.min.js', 'GET')).toBe(true)
    expect(__webAuthForTesting.isPublicPath('/l/abc123', 'GET')).toBe(true)
  })

  it('does not treat GET /api/viewer/:id as public (JSON is admin-only; HTML is /v/:id)', () => {
    expect(__webAuthForTesting.isPublicPath('/api/viewer/01234567-89ab-cdef-0123-456789abcdef', 'GET')).toBe(false)
    expect(__webAuthForTesting.isPublicPath('/v/01234567-89ab-cdef-0123-456789abcdef', 'GET')).toBe(true)
  })
})

// v1.5.43 — CJK webfont must load without a session cookie. CSS under
// /assets/ is public and references /fonts/*.woff2; a 302→login HTML
// response makes WKWebView drop the face → Chinese tofu / [?].
describe('v1.5.43: isPublicPath — CJK webfont bootstrap', () => {
  it('treats /fonts/*.woff2 as public so Agim CJK can load uncookied', () => {
    expect(__webAuthForTesting.isPublicPath(
      '/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2',
      'GET',
    )).toBe(true)
    expect(__webAuthForTesting.isPublicPath(
      '/fonts/noto-sans-sc-chinese-simplified-700-normal.woff2',
      'GET',
    )).toBe(true)
    expect(__webAuthForTesting.isPublicPath('/fonts/OFL.txt', 'GET')).toBe(true)
  })
})
