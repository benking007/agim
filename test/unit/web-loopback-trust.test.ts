// H-N8 — loopback-bypass gate.
//
// The web console auto-authenticates requests whose req.socket.remoteAddress
// is loopback so the local CLI / curl can talk to it without juggling
// tokens. That assumption fails when the server is fronted by a reverse
// proxy on the same machine: every proxied request looks loopback, and
// the bypass would forward auth to anyone the proxy lets through.
//
// IMHUB_TRUST_LOOPBACK gates the behavior:
//   - on  / 1 / true   always trust  (legacy)
//   - off / 0 / false  never trust   (proxy-fronted deployment)
//   - auto (default)   trust only when bound to a loopback address
//                      (127.0.0.1 / ::1 / localhost). When bound publicly
//                      (0.0.0.0 / routable IP) we distrust loopback peers.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { shouldTrustLoopbackBypass } from '../../src/web/server'

const ORIGINAL = process.env.IMHUB_TRUST_LOOPBACK

beforeEach(() => { delete process.env.IMHUB_TRUST_LOOPBACK })
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.IMHUB_TRUST_LOOPBACK
  else process.env.IMHUB_TRUST_LOOPBACK = ORIGINAL
})

describe('shouldTrustLoopbackBypass (auto)', () => {
  it('trusts loopback peer when bound to 127.0.0.1 / ::1 / localhost', () => {
    expect(shouldTrustLoopbackBypass('127.0.0.1')).toBe(true)
    expect(shouldTrustLoopbackBypass('::1')).toBe(true)
    expect(shouldTrustLoopbackBypass('localhost')).toBe(true)
  })

  it('distrusts loopback peer when bound to a public address', () => {
    // 0.0.0.0 is the canonical "behind a reverse proxy" shape: nginx
    // terminates on 443 and proxies to agim on 0.0.0.0:3000 — every hop
    // is a 127.0.0.1 socket on the agim side.
    expect(shouldTrustLoopbackBypass('0.0.0.0')).toBe(false)
    expect(shouldTrustLoopbackBypass('::')).toBe(false)
    expect(shouldTrustLoopbackBypass('10.0.0.5')).toBe(false)
    expect(shouldTrustLoopbackBypass('203.0.113.10')).toBe(false)
  })
})

describe('shouldTrustLoopbackBypass (explicit overrides)', () => {
  it('on / 1 / true → always trust even on public bind', () => {
    process.env.IMHUB_TRUST_LOOPBACK = 'on'
    expect(shouldTrustLoopbackBypass('0.0.0.0')).toBe(true)
    process.env.IMHUB_TRUST_LOOPBACK = '1'
    expect(shouldTrustLoopbackBypass('0.0.0.0')).toBe(true)
    process.env.IMHUB_TRUST_LOOPBACK = 'true'
    expect(shouldTrustLoopbackBypass('0.0.0.0')).toBe(true)
  })

  it('off / 0 / false → never trust even on loopback bind', () => {
    process.env.IMHUB_TRUST_LOOPBACK = 'off'
    expect(shouldTrustLoopbackBypass('127.0.0.1')).toBe(false)
    process.env.IMHUB_TRUST_LOOPBACK = '0'
    expect(shouldTrustLoopbackBypass('127.0.0.1')).toBe(false)
    process.env.IMHUB_TRUST_LOOPBACK = 'false'
    expect(shouldTrustLoopbackBypass('127.0.0.1')).toBe(false)
  })

  it('case insensitive', () => {
    process.env.IMHUB_TRUST_LOOPBACK = 'ON'
    expect(shouldTrustLoopbackBypass('0.0.0.0')).toBe(true)
    process.env.IMHUB_TRUST_LOOPBACK = 'Off'
    expect(shouldTrustLoopbackBypass('127.0.0.1')).toBe(false)
  })

  it('empty / unknown → falls back to auto', () => {
    process.env.IMHUB_TRUST_LOOPBACK = ''
    expect(shouldTrustLoopbackBypass('127.0.0.1')).toBe(true)
    expect(shouldTrustLoopbackBypass('0.0.0.0')).toBe(false)
    process.env.IMHUB_TRUST_LOOPBACK = 'maybe'
    expect(shouldTrustLoopbackBypass('127.0.0.1')).toBe(true)
    expect(shouldTrustLoopbackBypass('0.0.0.0')).toBe(false)
  })
})
