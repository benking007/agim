import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import { buildSessionCookie, shouldUseSecureCookie } from '../../src/web/server'

/**
 * H-N2 — session cookie hardening.
 *
 *   - Always HttpOnly (XSS-to-session-takeover is the dominant risk; the
 *     web UI uses localStorage + Bearer, so the cookie no longer needs
 *     to be readable from JS).
 *   - Always SameSite=Strict (CSRF on cross-site form posts).
 *   - Secure flag gated by IMHUB_WEB_COOKIE_SECURE (auto/on/off). In auto
 *     mode we accept either req.socket.encrypted (direct HTTPS) OR
 *     x-forwarded-proto=https (reverse-proxy terminated TLS) as the
 *     "this request is HTTPS" signal.
 *
 * Pure HTTP on loopback is the common dev shape; forcing Secure there
 * would silently strip the cookie and lock the operator out, so the
 * default has to be opt-in via either env or a real HTTPS signal.
 */

interface FakeReqOptions {
  encrypted?: boolean
  xfp?: string
  headers?: Record<string, string>
}

function fakeReq(opts: FakeReqOptions = {}): IncomingMessage {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.xfp !== undefined) headers['x-forwarded-proto'] = opts.xfp
  const socket = { encrypted: opts.encrypted ?? false }
  return {
    headers,
    socket,
  } as unknown as IncomingMessage
}

describe('shouldUseSecureCookie', () => {
  const original = process.env.IMHUB_WEB_COOKIE_SECURE

  beforeEach(() => { delete process.env.IMHUB_WEB_COOKIE_SECURE })
  afterEach(() => {
    if (original === undefined) delete process.env.IMHUB_WEB_COOKIE_SECURE
    else process.env.IMHUB_WEB_COOKIE_SECURE = original
  })

  it('auto + plain HTTP loopback → no Secure', () => {
    expect(shouldUseSecureCookie(fakeReq())).toBe(false)
  })

  it('auto + req.socket.encrypted → Secure', () => {
    expect(shouldUseSecureCookie(fakeReq({ encrypted: true }))).toBe(true)
  })

  it('auto + x-forwarded-proto=https → Secure (reverse-proxy TLS)', () => {
    expect(shouldUseSecureCookie(fakeReq({ xfp: 'https' }))).toBe(true)
  })

  it('auto + x-forwarded-proto=http → no Secure', () => {
    expect(shouldUseSecureCookie(fakeReq({ xfp: 'http' }))).toBe(false)
  })

  it('auto + comma-separated XFP picks first hop', () => {
    // Some CDNs forward "https, http" (CDN → origin); the first entry is
    // the original client scheme and is what we should honour.
    expect(shouldUseSecureCookie(fakeReq({ xfp: 'https, http' }))).toBe(true)
    expect(shouldUseSecureCookie(fakeReq({ xfp: 'http, https' }))).toBe(false)
  })

  it('auto + XFP case-insensitive', () => {
    expect(shouldUseSecureCookie(fakeReq({ xfp: 'HTTPS' }))).toBe(true)
  })

  it('explicit on → Secure even without HTTPS signal', () => {
    process.env.IMHUB_WEB_COOKIE_SECURE = 'on'
    expect(shouldUseSecureCookie(fakeReq())).toBe(true)
    process.env.IMHUB_WEB_COOKIE_SECURE = '1'
    expect(shouldUseSecureCookie(fakeReq())).toBe(true)
    process.env.IMHUB_WEB_COOKIE_SECURE = 'true'
    expect(shouldUseSecureCookie(fakeReq())).toBe(true)
  })

  it('explicit off → no Secure even with HTTPS signal', () => {
    process.env.IMHUB_WEB_COOKIE_SECURE = 'off'
    expect(shouldUseSecureCookie(fakeReq({ encrypted: true }))).toBe(false)
    expect(shouldUseSecureCookie(fakeReq({ xfp: 'https' }))).toBe(false)
  })
})

describe('buildSessionCookie', () => {
  const original = process.env.IMHUB_WEB_COOKIE_SECURE

  beforeEach(() => { delete process.env.IMHUB_WEB_COOKIE_SECURE })
  afterEach(() => {
    if (original === undefined) delete process.env.IMHUB_WEB_COOKIE_SECURE
    else process.env.IMHUB_WEB_COOKIE_SECURE = original
  })

  it('always sets HttpOnly + SameSite=Strict + Path=/', () => {
    const c = buildSessionCookie(fakeReq(), 'abc', 3600)
    expect(c).toContain('agim_token=abc')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Path=/')
    expect(c).toContain('Max-Age=3600')
  })

  it('omits Secure on plain HTTP loopback', () => {
    const c = buildSessionCookie(fakeReq(), 'abc', 3600)
    expect(c).not.toContain('Secure')
  })

  it('adds Secure when request is HTTPS', () => {
    const c = buildSessionCookie(fakeReq({ xfp: 'https' }), 'abc', 3600)
    expect(c).toContain('Secure')
  })

  it('encodes token value', () => {
    const c = buildSessionCookie(fakeReq(), 'a b=c', 3600)
    // encodeURIComponent('a b=c') === 'a%20b%3Dc'
    expect(c).toContain('agim_token=a%20b%3Dc')
  })

  it('Max-Age=0 logout cookie still carries all attributes (matching is required for deletion)', () => {
    process.env.IMHUB_WEB_COOKIE_SECURE = 'on'
    const c = buildSessionCookie(fakeReq(), '', 0)
    expect(c).toContain('Max-Age=0')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Secure')
  })
})
