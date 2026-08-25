import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleLoopApi } from './loop-api.js'
import { bindTokenModule } from './auth.js'

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const chunks: Buffer[] = []
  const res = {
    statusCode: 200,
    body: '',
    writeHead(code: number) { this.statusCode = code; return this },
    setHeader() { return this },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.body = Buffer.concat(chunks).toString('utf8')
      return this
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('GET /api/loop member ownership', () => {
  let tmpHome = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agim-loop-member-'))
    for (const k of ['AGIM_HOME', 'AGIM_WEB_AUTH', 'AGIM_TRUST_LOOPBACK']) {
      saved[k] = process.env[k]
    }
    process.env.AGIM_HOME = tmpHome
    process.env.AGIM_WEB_AUTH = 'on'
    process.env.AGIM_TRUST_LOOPBACK = 'off'
  })

  afterEach(() => {
    bindTokenModule(null)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('allows a member to poll a brand-new web thread', async () => {
    const tokenModule = await import('../core/access-token.js')
    bindTokenModule(tokenModule)
    const user = tokenModule.createToken('loop-member', { role: 'user', userId: 'usr_loop01' })
    const req = {
      method: 'GET',
      url: '/api/loop?threadId=web-newThread01',
      headers: {
        authorization: `Bearer ${user.raw}`,
        'x-forwarded-for': '203.0.113.9',
      },
      socket: { remoteAddress: '10.0.0.2' },
    } as unknown as IncomingMessage
    const res = mockRes()
    const ok = await handleLoopApi(req, res, new URL('http://localhost/api/loop?threadId=web-newThread01'))
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, loop: null })
  })

  it('denies a member polling a web thread owned by someone else', async () => {
    const { sessionManager } = await import('../core/session.js')
    await sessionManager.claimWebSessionOwner('web-foreign01', 'usr_other')
    const tokenModule = await import('../core/access-token.js')
    bindTokenModule(tokenModule)
    const user = tokenModule.createToken('loop-intruder', { role: 'user', userId: 'usr_loop02' })
    const req = {
      method: 'GET',
      url: '/api/loop?threadId=web-foreign01',
      headers: {
        authorization: `Bearer ${user.raw}`,
        'x-forwarded-for': '203.0.113.9',
      },
      socket: { remoteAddress: '10.0.0.2' },
    } as unknown as IncomingMessage
    const res = mockRes()
    const ok = await handleLoopApi(req, res, new URL('http://localhost/api/loop?threadId=web-foreign01'))
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(403)
  })
})
