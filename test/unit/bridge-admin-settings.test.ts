/**
 * Connection settings: bridge tokens, one-time handoff, public contract, peers.
 * Bun skips nothing here; the suite only touches tokens.json and bridge-peers.json.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'agim-bridge-admin-'))
process.env.AGIM_HOME = home
process.env.AGIM_WEB_AUTH = 'on'
process.env.AGIM_TRUST_LOOPBACK = 'off'
process.env.LOG_LEVEL = 'silent'
delete process.env.AGIM_VIEWER_PUBLIC_BASE_URL
delete process.env.AGIM_BRIDGE_ENABLED

const [adminApi, bridgeApi, auth, tokens, peers, guide] = await Promise.all([
  import('../../src/web/bridge-admin-api.js'),
  import('../../src/web/bridge-api.js'),
  import('../../src/web/auth.js'),
  import('../../src/core/access-token.js'),
  import('../../src/core/bridge-peers.js'),
  import('../../src/web/bridge-caller-guide.js'),
])

const contract = readFileSync(guide.bridgeCallerGuideFile() || '', 'utf8')

function mockRes(): ServerResponse & { statusCode: number; body: string; contentType: string } {
  const chunks: Buffer[] = []
  const res = {
    statusCode: 200,
    contentType: '',
    headersSent: false,
    body: '',
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code
      this.contentType = headers?.['Content-Type'] || ''
      this.headersSent = true
      return this
    },
    setHeader() { return this },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.body = Buffer.concat(chunks).toString('utf8')
      this.headersSent = true
      return this
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: string; contentType: string }
}

function mockReq(opts: {
  method: string
  path: string
  body?: string
  token?: string
  host?: string
  remoteAddress?: string
  forwardedHost?: string
  forwardedProto?: string
}): IncomingMessage {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const headers: Record<string, string> = { host: opts.host || '127.0.0.1:3000' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.forwardedHost) headers['x-forwarded-host'] = opts.forwardedHost
  if (opts.forwardedProto) headers['x-forwarded-proto'] = opts.forwardedProto
  const req = {
    method: opts.method,
    url: opts.path,
    headers,
    socket: { remoteAddress: opts.remoteAddress || '203.0.113.10' },
    on(ev: string, cb: (...args: unknown[]) => void) {
      if (!listeners[ev]) listeners[ev] = []
      listeners[ev].push(cb)
      if (ev === 'data') {
        queueMicrotask(() => {
          if (opts.body) cb(Buffer.from(opts.body))
          for (const end of listeners.end ?? []) end()
        })
      }
      return req
    },
  }
  return req as unknown as IncomingMessage
}

async function callAdmin(opts: Parameters<typeof mockReq>[0]) {
  const req = mockReq(opts)
  const res = mockRes()
  await adminApi.handleBridgeAdminApi(req, res, new URL(opts.path, 'http://localhost'))
  return res
}

describe('bridge connection settings', () => {
  let adminRaw = ''
  let userRaw = ''

  beforeAll(() => {
    auth.bindTokenModule(tokens)
    adminRaw = tokens.createToken('ops').raw
    userRaw = tokens.createToken('member', { role: 'user' }).raw
  })

  beforeEach(() => {
    delete process.env.AGIM_VIEWER_PUBLIC_BASE_URL
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('serves the full caller contract without a token', async () => {
    expect(auth.isPublicPath('/api/bridge/caller-access', 'GET')).toBe(true)
    const req = mockReq({ method: 'GET', path: '/api/bridge/caller-access' })
    const res = mockRes()
    await bridgeApi.handleBridgeApi(req, res, new URL(req.url || '/', 'http://localhost'))
    expect(res.statusCode).toBe(200)
    expect(res.contentType).toContain('text/markdown')
    expect(res.body).toBe(contract)
    expect(res.body.includes('timeoutMs')).toBe(true)
    expect(res.body.includes('1200000')).toBe(true)
    expect(res.body.includes('终态只看 GET')).toBe(true)
    expect(res.body.includes('只轮询')).toBe(true)
  })

  it('creates a bridge token once and puts only the secret and base in the handoff', async () => {
    const created = await callAdmin({
      method: 'POST',
      path: '/api/admin/bridge/tokens',
      token: adminRaw,
      body: JSON.stringify({ label: 'caller', baseUrl: 'https://calls.example/ignored' }),
    })
    expect(created.statusCode).toBe(201)
    const body = JSON.parse(created.body) as {
      raw: string
      role: string
      callerPrompt: string
      publicBaseUrl: string
      guideUrl: string
    }
    expect(body.role).toBe('bridge')
    expect(body.raw.startsWith('agim_')).toBe(true)
    expect(body.raw.length).toBe('agim_'.length + 40)
    expect(body.publicBaseUrl).toBe('https://calls.example')
    expect(body.guideUrl).toBe('https://calls.example/api/bridge/caller-access')
    expect(body.callerPrompt.includes(body.raw)).toBe(true)
    expect(body.callerPrompt.includes('https://calls.example')).toBe(true)
    expect(body.callerPrompt.includes('这是来自云端的Agent，该Agent名字叫：Agim，可以通过以下方式连接这个Agent，连接完成后，可以向他发送任务安排，并在完成任务后，把任务执行情况返回给你')).toBe(true)
    expect(body.callerPrompt.includes('按对接页实现，不要等更多说明')).toBe(false)
    expect(body.callerPrompt.includes('【含密钥，只此一次】')).toBe(false)
    expect(contract.includes(body.raw)).toBe(false)
    expect(body.callerPrompt.includes('timeoutMs')).toBe(false)

    const guide = mockRes()
    await bridgeApi.handleBridgeApi(
      mockReq({ method: 'GET', path: '/api/bridge/caller-access' }),
      guide,
      new URL('/api/bridge/caller-access', 'http://localhost'),
    )
    expect(guide.body.includes(body.raw)).toBe(false)

    const listed = await callAdmin({
      method: 'GET',
      path: '/api/admin/bridge/tokens',
      token: adminRaw,
    })
    const listBody = JSON.parse(listed.body) as { tokens: Array<{ id: string; label: string; revoked: boolean }> }
    expect(JSON.stringify(listBody).includes(body.raw)).toBe(false)
    expect(JSON.stringify(listBody).includes('callerPrompt')).toBe(false)
    expect(listBody.tokens.some((row) => row.label === 'caller' && row.revoked === false)).toBe(true)

    const id = listBody.tokens.find((row) => row.label === 'caller')?.id || ''
    const revoked = await callAdmin({
      method: 'DELETE',
      path: `/api/admin/bridge/tokens/${id}`,
      token: adminRaw,
    })
    expect(revoked.statusCode).toBe(200)
    expect(tokens.verifyToken(body.raw)).toBeNull()
    const after = await callAdmin({
      method: 'GET',
      path: '/api/admin/bridge/tokens',
      token: adminRaw,
    })
    const afterBody = JSON.parse(after.body) as { tokens: Array<{ id: string; revoked: boolean }> }
    expect(afterBody.tokens.find((row) => row.id === id)?.revoked).toBe(true)
    expect(JSON.stringify(afterBody).includes(body.raw)).toBe(false)
  })

  it('uses a public request origin and still rejects non-admins', async () => {
    const created = await callAdmin({
      method: 'POST',
      path: '/api/admin/bridge/tokens',
      token: adminRaw,
      host: 'bridge.example',
      body: JSON.stringify({ label: 'from-host' }),
    })
    expect(created.statusCode).toBe(201)
    const body = JSON.parse(created.body) as { publicBaseUrl: string; callerPrompt: string; raw: string }
    expect(body.publicBaseUrl).toBe('http://bridge.example')
    expect(body.callerPrompt.includes('http://bridge.example')).toBe(true)
    expect(body.callerPrompt.includes(body.raw)).toBe(true)

    const denied = await callAdmin({
      method: 'POST',
      path: '/api/admin/bridge/tokens',
      token: userRaw,
      body: JSON.stringify({ label: 'nope', baseUrl: 'https://calls.example' }),
    })
    expect(denied.statusCode).toBe(403)
    const deniedList = await callAdmin({
      method: 'GET',
      path: '/api/admin/bridge/peers',
      token: userRaw,
    })
    expect(deniedList.statusCode).toBe(403)
  })

  it('lists peers without secrets and can disable one', async () => {
    const token = tokens.createToken('peer-token', { role: 'bridge' })
    const secret = 'signing-secret-should-not-leak'
    await peers.saveBridgePeers([{
      peerId: 'already',
      tokenId: token.id,
      agents: ['agim'],
      workspaceId: 'default',
      callbackUrl: null,
      signingSecret: secret,
      enabled: true,
      maxConcurrent: 1,
      callbackPinnedHost: null,
    }])
    const listed = await callAdmin({
      method: 'GET',
      path: '/api/admin/bridge/peers',
      token: adminRaw,
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.body.includes(secret)).toBe(false)
    expect(listed.body.includes('signingSecret')).toBe(false)
    const rows = JSON.parse(listed.body) as { peers: Array<{ peerId: string; enabled: boolean; agents: string[] }> }
    expect(rows.peers.some((row) => row.peerId === 'already' && row.enabled && row.agents.includes('agim'))).toBe(true)

    const patched = await callAdmin({
      method: 'PATCH',
      path: '/api/admin/bridge/peers',
      token: adminRaw,
      body: JSON.stringify({ peerId: 'already', enabled: false }),
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.body.includes(secret)).toBe(false)
    const again = peers.loadBridgePeers().find((row) => row.peerId === 'already')
    expect(again?.enabled).toBe(false)
    expect(again?.signingSecret).toBe(secret)

    const rejected = await callAdmin({
      method: 'POST',
      path: '/api/admin/bridge/peers',
      token: adminRaw,
      body: JSON.stringify({
        peerId: 'next',
        tokenId: token.id,
        agents: ['agim'],
        signingSecret: 'do-not-store',
      }),
    })
    expect(rejected.statusCode).toBe(400)
    expect(peers.loadBridgePeers().some((row) => row.peerId === 'next')).toBe(false)
  })
})
