/**
 * Phase 2 signed callbacks. SQLite cases run under the Node vitest suite;
 * Bun skips them because better-sqlite3 does not load there.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'agim-bridge-phase2-'))
process.env.AGIM_HOME = home
process.env.AGIM_BRIDGE_ENABLED = '1'
process.env.AGIM_WEB_AUTH = 'on'
process.env.AGIM_TRUST_LOOPBACK = 'off'
process.env.AGIM_AUTO_APPROVE = '0'
process.env.LOG_LEVEL = 'silent'

type Loaded = {
  handleBridgeApi: typeof import('../../src/web/bridge-api.js').handleBridgeApi
  tokens: typeof import('../../src/core/access-token.js')
  jobs: typeof import('../../src/core/job-board.js')
  peers: typeof import('../../src/core/bridge-peers.js')
  callbacks: typeof import('../../src/core/bridge-callback.js')
  runs: typeof import('../../src/core/bridge-run.js')
  registry: typeof import('../../src/core/registry.js').registry
  clearAgentCache: typeof import('../../src/core/onboarding.js').clearAgentCache
  bindTokenModule: typeof import('../../src/web/auth.js').bindTokenModule
}

let api: Loaded | null = null
try {
  const [bridgeApi, tokens, jobs, peers, callbacks, runs, registryMod, onboarding, auth] = await Promise.all([
    import('../../src/web/bridge-api.js'),
    import('../../src/core/access-token.js'),
    import('../../src/core/job-board.js'),
    import('../../src/core/bridge-peers.js'),
    import('../../src/core/bridge-callback.js'),
    import('../../src/core/bridge-run.js'),
    import('../../src/core/registry.js'),
    import('../../src/core/onboarding.js'),
    import('../../src/web/auth.js'),
  ])
  const probe = jobs.createJob('probe', 'probe')
  if (probe > 0 && jobs.getJob(probe)) {
    api = {
      handleBridgeApi: bridgeApi.handleBridgeApi,
      tokens,
      jobs,
      peers,
      callbacks,
      runs,
      registry: registryMod.registry,
      clearAgentCache: onboarding.clearAgentCache,
      bindTokenModule: auth.bindTokenModule,
    }
  } else if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error('expected jobs.db')
  }
} catch (err) {
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw err
  api = null
}

const certDir = mkdtempSync(join(tmpdir(), 'agim-bridge-cert-'))
let certPem = ''
let keyPem = ''
if (api) {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'),
    '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' })
  certPem = readFileSync(join(certDir, 'cert.pem'), 'utf8')
  keyPem = readFileSync(join(certDir, 'key.pem'), 'utf8')
}

type Ticket = { status: string; maxSeq: number; seen: Set<string>; applied: number }
type Recorded = {
  raw: Buffer
  eventId: string
  seq: number
  type: string
  status: number
  authorization: string
  bridgeTimestamp: string
  bridgeEvent: string
  bridgeSignature: string
}

let mode: 'verify' | 'fail' = 'verify'
let secret = ''
let ticket: Ticket = { status: 'pending', maxSeq: 0, seen: new Set(), applied: 0 }
const recorded: Recorded[] = []
let server: https.Server | null = null
let port = 0

function bearerMatches(key: string, authorization: string): boolean {
  const prefix = 'Bearer '
  if (!key || !authorization.startsWith(prefix)) return false
  const token = authorization.slice(prefix.length)
  const a = Buffer.from(key)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function verifyAndApply(raw: Buffer, headers: IncomingHttpHeaders, key: string, state: Ticket): number {
  const authorization = String(headers.authorization || headers.Authorization || '')
  if (!bearerMatches(key, authorization)) return 401
  const body = JSON.parse(raw.toString('utf8')) as {
    specVersion: number
    eventId: string
    type: string
    seq: number
    status: string
  }
  if (body.specVersion !== 1 || typeof body.type !== 'string') return 204
  if (state.seen.has(body.eventId)) return 204
  state.seen.add(body.eventId)
  const terminal = state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled'
  if (terminal && (body.seq < state.maxSeq || body.type === 'run.started')) return 204
  if (body.seq >= state.maxSeq) {
    state.maxSeq = body.seq
    state.status = body.status
    state.applied += 1
  }
  return 204
}

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const chunks: Buffer[] = []
  const res = {
    statusCode: 200,
    headersSent: false,
    body: '',
    writeHead(code: number) { this.statusCode = code; this.headersSent = true; return this },
    setHeader() { return this },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.body = Buffer.concat(chunks).toString('utf8')
      this.headersSent = true
      return this
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: string }
}

function mockReq(method: string, path: string, body: string, token: string, key?: string): IncomingMessage {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const req = {
    method,
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': '203.0.113.9',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    socket: { remoteAddress: '203.0.113.10' },
    on(ev: string, cb: (...args: unknown[]) => void) {
      if (!listeners[ev]) listeners[ev] = []
      listeners[ev].push(cb)
      if (ev === 'data') {
        queueMicrotask(() => {
          if (body) cb(Buffer.from(body))
          for (const end of listeners.end ?? []) end()
        })
      }
      return req
    },
  }
  return req as unknown as IncomingMessage
}

function skip(): boolean {
  if (api) return false
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error('expected sqlite')
  return true
}

const agent = {
  name: 'agim',
  aliases: [] as string[],
  async isAvailable() { return true },
  async *sendPrompt() { yield '发布记录正常' },
}

describe('production bridge phase 2 callbacks', () => {
  beforeAll(async () => {
    if (!api || !certPem) return
    api.registry.registerAgent(agent)
    api.bindTokenModule(api.tokens)
    server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        const status = mode === 'fail' ? 500 : verifyAndApply(raw, req.headers, secret, ticket)
        let eventId = ''
        let seq = 0
        let type = ''
        try {
          const parsed = JSON.parse(raw.toString('utf8')) as { eventId?: string; seq?: number; type?: string }
          eventId = parsed.eventId || ''
          seq = parsed.seq || 0
          type = parsed.type || ''
        } catch { /* unsigned or empty */ }
        recorded.push({
          raw,
          eventId,
          seq,
          type,
          status,
          authorization: String(req.headers.authorization || ''),
          bridgeTimestamp: String(req.headers['x-agim-bridge-timestamp'] || ''),
          bridgeEvent: String(req.headers['x-agim-bridge-event'] || ''),
          bridgeSignature: String(req.headers['x-agim-bridge-signature'] || ''),
        })
        res.writeHead(status)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  beforeEach(() => {
    if (!api) return
    mode = 'verify'
    secret = randomBytes(24).toString('hex')
    ticket = { status: 'pending', maxSeq: 0, seen: new Set(), applied: 0 }
    recorded.length = 0
    api.bindTokenModule(api.tokens)
    api.clearAgentCache()
    api.runs.resetBridgeInflightForTests()
    api.registry.registerAgent(agent)
  })

  afterAll(() => {
    server?.close()
    if (api) {
      try { api.jobs.stopJobRetentionSweep() } catch { /* ignore */ }
      try { api.jobs.closeJobBoardDb() } catch { /* ignore */ }
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(certDir, { recursive: true, force: true })
  })

  async function savePeer(peerId: string, withCallback: boolean) {
    const mod = api
    if (!mod) throw new Error('sqlite')
    const token = mod.tokens.createToken(`cb-${peerId}`, { role: 'bridge' })
    await mod.peers.saveBridgePeers([{
      peerId,
      tokenId: token.id,
      agents: ['agim'],
      workspaceId: 'default',
      callbackUrl: withCallback ? `https://127.0.0.1:${port}/hook` : null,
      signingSecret: withCallback ? secret : null,
      callbackMode: withCallback ? 'webhook' : 'poll',
      enabled: true,
      maxConcurrent: 1,
      callbackPinnedHost: withCallback ? '127.0.0.1' : null,
    }])
    return token.raw
  }

  async function postRun(token: string, body: Record<string, unknown>, key: string) {
    const mod = api
    if (!mod) throw new Error('sqlite')
    const req = mockReq('POST', '/api/bridge/runs', JSON.stringify(body), token, key)
    const res = mockRes()
    await mod.handleBridgeApi(req, res, new URL(req.url || '/', 'http://localhost'))
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) as Record<string, unknown> : {} }
  }

  async function waitJob(id: number, status: string) {
    const mod = api
    if (!mod) throw new Error('sqlite')
    const start = Date.now()
    while (Date.now() - start < 8000) {
      if (mod.jobs.getJob(id)?.status === status) return
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    throw new Error(`job ${id} did not become ${status}`)
  }

  async function deliverAll() {
    const mod = api
    if (!mod) throw new Error('sqlite')
    for (let i = 0; i < 30; i += 1) {
      const n = await mod.callbacks.deliverDueCallbacks({
        caPem: certPem,
        backoffSeconds: [0, 0, 0, 0, 0, 0],
      })
      if (n === 0) return
    }
  }

  it('does not post when callback mode is poll even if URL and key are set', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const token = mod.tokens.createToken('poll-mode', { role: 'bridge' })
    await mod.peers.saveBridgePeers([{
      peerId: 'poll-keeps',
      tokenId: token.id,
      agents: ['agim'],
      workspaceId: 'default',
      callbackUrl: `https://127.0.0.1:${port}/hook`,
      signingSecret: secret,
      callbackMode: 'poll',
      enabled: true,
      maxConcurrent: 1,
      callbackPinnedHost: '127.0.0.1',
    }])
    const before = recorded.length
    const created = await postRun(token.raw, { agent: 'agim', prompt: '方式是轮询' }, 'cb-poll-mode-1')
    expect(created.status).toBe(202)
    await waitJob(created.body.jobId as number, 'completed')
    await deliverAll()
    expect(recorded.length).toBe(before)
    const stored = mod.peers.loadBridgePeers().find((peer) => peer.peerId === 'poll-keeps')
    expect(stored?.signingSecret).toBe(secret)
    expect(stored?.callbackUrl).toBe(`https://127.0.0.1:${port}/hook`)
    expect(stored?.callbackMode).toBe('poll')
    expect(mod.runs.getBridgeRunByRunId(String(created.body.runId))?.callback_status).toBe('none')
  }, { timeout: 20_000 })

  it('delivers a bearer-authenticated terminal event and run.started over HTTPS', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const token = await savePeer('signed', true)
    const created = await postRun(token, { agent: 'agim', prompt: '检查发布记录' }, 'cb-signed-1')
    expect(created.status).toBe(202)
    const jobId = created.body.jobId as number
    await waitJob(jobId, 'completed')
    await deliverAll()
    expect(recorded.length).toBeGreaterThanOrEqual(2)
    expect(recorded.every((row) => row.status === 204)).toBe(true)
    expect(recorded.every((row) => row.authorization === `Bearer ${secret}`)).toBe(true)
    expect(recorded.every((row) => row.bridgeTimestamp === '' && row.bridgeEvent === '' && row.bridgeSignature === '')).toBe(true)
    const types = recorded.map((row) => row.type)
    expect(types).toContain('run.started')
    expect(types).toContain('run.completed')
    const completed = recorded.find((row) => row.type === 'run.completed')
    const started = recorded.find((row) => row.type === 'run.started')
    expect(completed && started && completed.seq > started.seq).toBe(true)
    const payload = JSON.parse(completed?.raw.toString('utf8') || '{}') as {
      specVersion: number
      result: string
      status: string
      resultTruncated: boolean
    }
    expect(payload.specVersion).toBe(1)
    expect(payload.result).toBe('发布记录正常')
    expect(payload.resultTruncated).toBe(false)
    expect(ticket.status).toBe('completed')
    const side = mod.runs.getBridgeRunByRunId(String(created.body.runId))
    expect(side?.callback_status).toBe('delivered')
  }, { timeout: 20_000 })

  it('returns 401 for a bad bearer token and gives up instead of retrying', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const raw = Buffer.from('{"specVersion":1}')
    const bad = verifyAndApply(raw, { authorization: 'Bearer nope' }, secret, ticket)
    expect(bad).toBe(401)

    const signingKey = randomBytes(24).toString('hex')
    secret = signingKey
    const token = await savePeer('bad-sig', true)
    secret = randomBytes(24).toString('hex')
    const created = await postRun(token, { agent: 'agim', prompt: '签名不对' }, 'cb-badsig-1')
    await waitJob(created.body.jobId as number, 'completed')
    const before = recorded.length
    await deliverAll()
    const sent = recorded.slice(before)
    expect(sent.map((row) => row.type).sort()).toEqual(['run.completed', 'run.progress', 'run.started'])
    expect(sent.every((row) => row.status === 401)).toBe(true)
    const again = recorded.length
    await deliverAll()
    expect(recorded.length).toBe(again)
    const side = mod.runs.getBridgeRunByRunId(String(created.body.runId))
    expect(side?.callback_status).toBe('giving_up')
    expect(mod.jobs.getJob(created.body.jobId as number)?.status).toBe('completed')
  }, { timeout: 20_000 })

  it('applies one eventId only once when the same body is delivered twice', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const token = await savePeer('dedupe', true)
    const created = await postRun(token, { agent: 'agim', prompt: '去重' }, 'cb-dedupe-1')
    await waitJob(created.body.jobId as number, 'completed')
    await deliverAll()
    const completed = recorded.find((row) => row.type === 'run.completed')
    expect(completed?.eventId).toBeTruthy()
    const applied = ticket.applied
    expect(mod.callbacks.requeueCallbackByEventIdForTests(completed?.eventId || '')).toBe(true)
    await deliverAll()
    expect(ticket.applied).toBe(applied)
    expect(ticket.seen.has(completed?.eventId || '')).toBe(true)
    expect(ticket.status).toBe('completed')
  }, { timeout: 20_000 })

  it('does not let a late run.started replace a completed status', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const token = await savePeer('reorder', true)
    const created = await postRun(token, { agent: 'agim', prompt: '乱序' }, 'cb-reorder-1')
    await waitJob(created.body.jobId as number, 'completed')
    await deliverAll()
    const completed = recorded.find((row) => row.type === 'run.completed')
    const started = recorded.find((row) => row.type === 'run.started')
    if (!completed || !started) throw new Error('missing callback events')
    const late: Ticket = { status: 'pending', maxSeq: 0, seen: new Set(), applied: 0 }
    expect(verifyAndApply(completed.raw, {
      authorization: completed.authorization,
    }, secret, late)).toBe(204)
    expect(late.status).toBe('completed')
    expect(verifyAndApply(started.raw, {
      authorization: started.authorization,
    }, secret, late)).toBe(204)
    expect(late.status).toBe('completed')
  }, { timeout: 20_000 })

  it('keeps the job completed when the receiver always fails', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    mode = 'fail'
    const token = await savePeer('give-up', true)
    const created = await postRun(token, { agent: 'agim', prompt: '一直失败' }, 'cb-fail-1')
    await waitJob(created.body.jobId as number, 'completed')
    await deliverAll()
    const side = mod.runs.getBridgeRunByRunId(String(created.body.runId))
    expect(side?.callback_status).toBe('giving_up')
    expect(mod.jobs.getJob(created.body.jobId as number)?.status).toBe('completed')
    const seen = recorded.length
    await deliverAll()
    expect(recorded.length).toBe(seen)
    const req = mockReq('GET', `/api/bridge/runs/${created.body.runId}`, '', token)
    const res = mockRes()
    await mod.handleBridgeApi(req, res, new URL(req.url || '/', 'http://localhost'))
    const body = JSON.parse(res.body) as { status: string; result: string; callbackStatus: string }
    expect(body.status).toBe('completed')
    expect(body.result).toBe('发布记录正常')
    expect(body.callbackStatus).toBe('giving_up')
  }, { timeout: 20_000 })

  it('does not send when the callback URL is absent or resolves private at delivery', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const pollToken = await savePeer('poll-only', false)
    const before = recorded.length
    const polled = await postRun(pollToken, {
      agent: 'agim',
      prompt: '只轮询',
      callbackUrl: `https://127.0.0.1:${port}/hook`,
    }, 'cb-poll-1')
    expect(polled.status).toBe(400)
    const ok = await postRun(pollToken, { agent: 'agim', prompt: '只轮询' }, 'cb-poll-2')
    await waitJob(ok.body.jobId as number, 'completed')
    await deliverAll()
    expect(recorded.length).toBe(before)
    expect(mod.runs.getBridgeRunByRunId(String(ok.body.runId))?.callback_status).toBe('none')

    const hooked = await savePeer('private-later', true)
    const created = await postRun(hooked, { agent: 'agim', prompt: '内网' }, 'cb-private-1')
    await waitJob(created.body.jobId as number, 'completed')
    const peers = mod.peers.loadBridgePeers()
    const mine = peers.find((peer) => peer.peerId === 'private-later')
    if (!mine) throw new Error('peer missing')
    mine.callbackPinnedHost = null
    writeFileSync(mod.peers.bridgePeersFile(), `${JSON.stringify({ peers }, null, 2)}\n`)
    const seen = recorded.length
    await deliverAll()
    expect(recorded.length).toBe(seen)
    expect(mod.runs.getBridgeRunByRunId(String(created.body.runId))?.callback_status).toBe('giving_up')
    expect(mod.jobs.getJob(created.body.jobId as number)?.status).toBe('completed')
  }, { timeout: 20_000 })

  it('scrubs outbound secrets before sending the callback body', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const marker = `agim_${'a'.repeat(40)}`
    agent.sendPrompt = async function* () { yield `结果 ${marker}` }
    try {
      const token = await savePeer('scrub', true)
      const created = await postRun(token, { agent: 'agim', prompt: '脱敏' }, 'cb-scrub-1')
      await waitJob(created.body.jobId as number, 'completed')
      await deliverAll()
      const completed = recorded.find((row) => row.type === 'run.completed')
      const text = completed?.raw.toString('utf8') || ''
      expect(text.includes('[REDACTED-agim_token]')).toBe(true)
      expect(text.includes(marker)).toBe(false)
    } finally {
      agent.sendPrompt = async function* () { yield '发布记录正常' }
    }
  }, { timeout: 20_000 })
  it('emits run.failed with bridge_restarted for a job reaped at startup', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const token = await savePeer('restarted', true)
    const created = await postRun(token, { agent: 'agim', prompt: '重启' }, 'cb-restart-1')
    const jobId = created.body.jobId as number
    await waitJob(jobId, 'completed')
    mod.jobs.withJobsDatabase((db) => {
      db.prepare(
        `UPDATE jobs SET status = 'failed', error = 'agim restarted while running' WHERE id = ?`,
      ).run(jobId)
    })
    expect(mod.callbacks.enqueueRestartedBridgeFailures()).toBe(1)
    await deliverAll()
    const failed = recorded.find((row) => row.type === 'run.failed')
    const payload = JSON.parse(failed?.raw.toString('utf8') || '{}') as { error?: { code: string }; type: string }
    expect(payload.type).toBe('run.failed')
    expect(payload.error?.code).toBe('bridge_restarted')
    expect(mod.jobs.getJob(jobId)?.status).toBe('failed')
    expect(mod.jobs.getJob(jobId)?.error).toBe('agim restarted while running')
  }, { timeout: 20_000 })
})
