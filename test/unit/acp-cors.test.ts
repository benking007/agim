// H-N3 — ACP CORS allowlist.
//
// ACP 9090 previously echoed `Access-Control-Allow-Origin: *`. Combined
// with Bearer auth that lets any cross-origin page enumerate /agent/card
// (which advertises agent capabilities) and observe 401 shape via
// preflight + actual fetch. Default is now no CORS at all; browser-based
// callers opt-in via IMHUB_ACP_CORS_ORIGINS.

import { describe, it, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseAcpCorsOrigins, applyAcpCors } from '../../src/core/acp-server'

interface CapturedRes {
  status?: number
  ended: boolean
  headers: Record<string, string>
}

function fakeRes(): { res: ServerResponse; captured: CapturedRes } {
  const captured: CapturedRes = { ended: false, headers: {} }
  const res = {
    setHeader(name: string, value: string | number): void {
      captured.headers[name.toLowerCase()] = String(value)
    },
    writeHead(status: number): void { captured.status = status },
    end(): void { captured.ended = true },
  } as unknown as ServerResponse
  return { res, captured }
}

function fakeReq(opts: { method?: string; origin?: string } = {}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.origin !== undefined) headers.origin = opts.origin
  return { method: opts.method ?? 'GET', headers } as unknown as IncomingMessage
}

describe('parseAcpCorsOrigins', () => {
  it('null when env unset / empty / whitespace', () => {
    expect(parseAcpCorsOrigins(undefined)).toBeNull()
    expect(parseAcpCorsOrigins('')).toBeNull()
    expect(parseAcpCorsOrigins('   ')).toBeNull()
  })

  it('* → wildcard mode', () => {
    const v = parseAcpCorsOrigins('*')
    expect(v).toEqual({ wildcard: true })
  })

  it('parses comma list into a Set', () => {
    const v = parseAcpCorsOrigins('https://a.com,https://b.com, https://c.com ')
    expect(v).not.toBeNull()
    if (v && !v.wildcard) {
      expect(v.origins.has('https://a.com')).toBe(true)
      expect(v.origins.has('https://b.com')).toBe(true)
      expect(v.origins.has('https://c.com')).toBe(true)
      expect(v.origins.size).toBe(3)
    }
  })

  it('null when list is all blanks', () => {
    expect(parseAcpCorsOrigins(',  ,')).toBeNull()
  })
})

describe('applyAcpCors', () => {
  it('without allowlist: no CORS headers, OPTIONS still gets 204', () => {
    const { res, captured } = fakeRes()
    const consumed = applyAcpCors(fakeReq({ origin: 'https://attacker.com' }), res, null)
    expect(consumed).toBe(false)
    expect(captured.headers['access-control-allow-origin']).toBeUndefined()

    // OPTIONS preflight still terminates with 204 (no leak of allowlist
    // status through 4xx vs 204 differential).
    const { res: res2, captured: c2 } = fakeRes()
    const consumed2 = applyAcpCors(fakeReq({ method: 'OPTIONS', origin: 'https://attacker.com' }), res2, null)
    expect(consumed2).toBe(true)
    expect(c2.status).toBe(204)
    expect(c2.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allowlist match: echoes origin + Vary: Origin', () => {
    const allowlist = parseAcpCorsOrigins('https://a.com,https://b.com')
    const { res, captured } = fakeRes()
    const consumed = applyAcpCors(fakeReq({ origin: 'https://a.com' }), res, allowlist)
    expect(consumed).toBe(false)
    expect(captured.headers['access-control-allow-origin']).toBe('https://a.com')
    expect(captured.headers.vary).toBe('Origin')
    expect(captured.headers['access-control-allow-methods']).toContain('POST')
    expect(captured.headers['access-control-allow-headers']).toContain('Authorization')
  })

  it('allowlist miss: no CORS headers (browser will block the page)', () => {
    const allowlist = parseAcpCorsOrigins('https://a.com')
    const { res, captured } = fakeRes()
    applyAcpCors(fakeReq({ origin: 'https://attacker.com' }), res, allowlist)
    expect(captured.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('wildcard: echoes the actual origin (or * if missing) + Vary when echoing', () => {
    const allowlist = parseAcpCorsOrigins('*')
    const { res, captured } = fakeRes()
    applyAcpCors(fakeReq({ origin: 'https://random.com' }), res, allowlist)
    expect(captured.headers['access-control-allow-origin']).toBe('https://random.com')
    expect(captured.headers.vary).toBe('Origin')

    // Curl-style request with no Origin header → bare *
    const { res: r2, captured: c2 } = fakeRes()
    applyAcpCors(fakeReq({}), r2, allowlist)
    expect(c2.headers['access-control-allow-origin']).toBe('*')
    expect(c2.headers.vary).toBeUndefined()
  })

  it('OPTIONS preflight: replies 204 even when origin matches (and sets CORS)', () => {
    const allowlist = parseAcpCorsOrigins('https://a.com')
    const { res, captured } = fakeRes()
    const consumed = applyAcpCors(fakeReq({ method: 'OPTIONS', origin: 'https://a.com' }), res, allowlist)
    expect(consumed).toBe(true)
    expect(captured.status).toBe(204)
    expect(captured.headers['access-control-allow-origin']).toBe('https://a.com')
    expect(captured.headers['access-control-max-age']).toBe('600')
  })
})
