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
    saved.IMHUB_HOME = process.env.IMHUB_HOME
    saved.IMHUB_WEB_AUTH = process.env.IMHUB_WEB_AUTH
    saved.IMHUB_TRUST_LOOPBACK = process.env.IMHUB_TRUST_LOOPBACK
    process.env.AGIM_HOME = tmpHome
    delete process.env.IMHUB_HOME
    delete process.env.IMHUB_WEB_AUTH
    delete process.env.IMHUB_TRUST_LOOPBACK
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

  it('honors IMHUB_TRUST_LOOPBACK=off', () => {
    process.env.IMHUB_TRUST_LOOPBACK = 'off'
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
