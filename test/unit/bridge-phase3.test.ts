/**
 * Phase 3: dev Agim calls production and mirrors the run on a local job.
 * SQLite cases run in the Node vitest suite.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
const home = mkdtempSync(join(tmpdir(), 'agim-bridge-phase3-'))
process.env.AGIM_HOME = home
process.env.AGIM_BRIDGE_ENABLED = '1'
process.env.AGIM_WEB_AUTH = 'on'
process.env.AGIM_TRUST_LOOPBACK = 'off'
process.env.LOG_LEVEL = 'silent'

type Loaded = {
  handleBridgeApi: typeof import('../../src/web/bridge-api.js').handleBridgeApi
  handleJobsApi: typeof import('../../src/web/jobs-api.js').handleJobsApi
  checkAuth: typeof import('../../src/web/auth.js').checkAuth
  bindTokenModule: typeof import('../../src/web/auth.js').bindTokenModule
  tokens: typeof import('../../src/core/access-token.js')
  jobs: typeof import('../../src/core/job-board.js')
  peers: typeof import('../../src/core/bridge-peers.js')
  outbound: typeof import('../../src/core/bridge-outbound.js')
}

let api: Loaded | null = null
try {
  const [bridgeApi, jobsApi, auth, tokens, jobs, peers, outbound] = await Promise.all([
    import('../../src/web/bridge-api.js'),
    import('../../src/web/jobs-api.js'),
    import('../../src/web/auth.js'),
    import('../../src/core/access-token.js'),
    import('../../src/core/job-board.js'),
    import('../../src/core/bridge-peers.js'),
    import('../../src/core/bridge-outbound.js'),
  ])
  const probe = jobs.createJob('probe', 'probe')
  if (probe > 0 && jobs.getJob(probe)) {
    api = {
      handleBridgeApi: bridgeApi.handleBridgeApi,
      handleJobsApi: jobsApi.handleJobsApi,
      checkAuth: auth.checkAuth,
      bindTokenModule: auth.bindTokenModule,
      tokens,
      jobs,
      peers,
      outbound,
    }
  } else if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error('expected jobs.db')
  }
} catch (err) {
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw err
  api = null
}

type Remote = {
  runId: string
  jobId: number
  status: string
  agent: string
  prompt: string
  result: string | null
  error: string | null
}

let port = 0
let server: http.Server | null = null
let remote: Remote | null = null
let gets = 0
let nextRemoteId = 8000
const prompt = '检查生产工作区里今天的发布记录'

function skip(): boolean {
  if (api) return false
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error('expected sqlite')
  return true
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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

function filesWith(needle: string): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else if (readFileSync(path).includes(needle)) hits.push(name)
    }
  }
  walk(home)
  return hits.sort()
}

describe('dev Agim outbound bridge', () => {
  const bridgeToken = randomBytes(24).toString('hex')
  const signingSecret = randomBytes(24).toString('hex')

  beforeAll(async () => {
    if (!api) return
    api.bindTokenModule(api.tokens)
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const auth = String(req.headers.authorization || '')
      if (sha(auth.slice('Bearer '.length)) !== sha(bridgeToken)) {
        res.writeHead(401)
        res.end()
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/runs') {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk as Buffer))
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { agent?: string; prompt?: string }
          remote = {
            runId: randomUUID(),
            jobId: nextRemoteId,
            status: 'pending',
            agent: body.agent || '',
            prompt: body.prompt || '',
            result: null,
            error: null,
          }
          nextRemoteId += 1
          res.writeHead(202, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            ok: true,
            runId: remote.runId,
            jobId: remote.jobId,
            status: 'pending',
            agent: remote.agent,
          }))
        })
        return
      }
      const match = url.pathname.match(/^\/api\/bridge\/runs\/([^/]+)$/)
      if (req.method === 'GET' && match && remote && decodeURIComponent(match[1]) === remote.runId) {
        gets += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          runId: remote.runId,
          jobId: remote.jobId,
          status: remote.status,
          agent: remote.agent,
          result: remote.result,
          error: remote.error,
          callbackStatus: 'none',
        }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  beforeEach(() => {
    if (!api) return
    gets = 0
    remote = null
    api.bindTokenModule(api.tokens)
    api.peers.saveOutboundTargets([{
      peerId: 'prod',
      baseUrl: `http://127.0.0.1:${port}`,
      token: bridgeToken,
      signingSecret,
      agents: ['agim'],
    }])
  })

  afterAll(() => {
    server?.close()
    if (api) {
      try { api.outbound.stopOutboundPollerForTests() } catch { /* ignore */ }
      try { api.jobs.stopJobRetentionSweep() } catch { /* ignore */ }
      try { api.jobs.closeJobBoardDb() } catch { /* ignore */ }
    }
    rmSync(home, { recursive: true, force: true })
  })

  async function start(key: string, text = prompt) {
    const mod = api
    if (!mod) throw new Error('sqlite')
    return mod.outbound.startOutboundRun({
      peerId: 'prod',
      agent: 'agim',
      prompt: text,
      idempotencyKey: key,
    })
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${signingSecret}` }
  }

  async function postCallback(body: string, headers: Record<string, string>) {
    const mod = api
    if (!mod) throw new Error('sqlite')
    const req = {
      method: 'POST',
      url: '/api/bridge/callbacks',
      headers,
      socket: { remoteAddress: '203.0.113.10' },
      on(ev: string, cb: (...args: unknown[]) => void) {
        if (ev === 'data') queueMicrotask(() => { cb(Buffer.from(body)); })
        if (ev === 'end') queueMicrotask(() => cb())
        return req
      },
    } as unknown as IncomingMessage
    const res = mockRes()
    await mod.handleBridgeApi(req, res, new URL('http://127.0.0.1/api/bridge/callbacks'))
    return res.statusCode
  }

  it('mirrors production through GET when no callback is delivered', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const before = mod.jobs.listJobs(1000).length
    const started = await start('poll-1')
    expect(started.status).toBe('pending')
    expect(typeof started.remoteJobId).toBe('number')
    expect(started.remoteJobId === started.jobId).toBe(false)
    expect(remote?.prompt).toBe(prompt)
    expect(remote?.agent).toBe('agim')
    const local = mod.jobs.getJob(started.jobId)
    expect(local?.prompt).toBe(prompt)
    expect(local?.agent).toBe('agim')
    expect(local?.kind).toBe('job')
    expect(local?.call_depth).toBe(0)
    const side = mod.jobs.withJobsDatabase((db) => db.prepare(
      'SELECT remote_job_id, direction, run_id FROM bridge_runs WHERE job_id = ?',
    ).get(started.jobId) as { remote_job_id: number; direction: string; run_id: string })
    expect(side?.direction).toBe('outbound')
    expect(side?.remote_job_id === started.remoteJobId).toBe(true)
    expect(side?.run_id).toBe(remote?.runId)

    if (remote) remote.status = 'running'
    await mod.outbound.pollOutboundRuns()
    expect(mod.jobs.getJob(started.jobId)?.status).toBe('running')

    if (remote) {
      remote.status = 'completed'
      remote.result = '发布记录正常'
    }
    await mod.outbound.pollOutboundRuns()
    const done = mod.jobs.getJob(started.jobId)
    expect(done?.status).toBe('completed')
    expect(done?.result).toBe('发布记录正常')

    const admin = mod.tokens.createToken('dev-admin')
    const listReq = {
      method: 'GET',
      url: '/api/jobs?limit=50',
      headers: { authorization: `Bearer ${admin.raw}` },
      socket: { remoteAddress: '203.0.113.10' },
      on() { return listReq },
    } as unknown as IncomingMessage
    const listRes = mockRes()
    await mod.handleJobsApi(listReq, listRes, new URL('http://127.0.0.1/api/jobs?limit=50'))
    const listed = JSON.parse(listRes.body) as { jobs: Array<{ id: number; prompt: string; agent: string }> }
    const row = listed.jobs.find((job) => job.id === started.jobId)
    expect(row?.prompt).toBe(prompt)
    expect(row?.agent).toBe('agim')
    expect(mod.jobs.listJobs(1000).length).toBe(before + 1)

    const again = await start('poll-1')
    expect(again.jobId).toBe(started.jobId)
    expect(mod.jobs.listJobs(1000).length).toBe(before + 1)
    expect(filesWith(bridgeToken)).toEqual(['bridge-peers.json'])
    expect(filesWith(signingSecret)).toEqual(['bridge-peers.json'])
  }, { timeout: 20_000 })

  it('follows production failure and cancellation through GET', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const failed = await start('fail-1', '失败任务')
    if (remote) {
      remote.status = 'failed'
      remote.error = 'bridge_timeout'
    }
    await mod.outbound.pollOutboundRuns()
    expect(mod.jobs.getJob(failed.jobId)?.status).toBe('failed')
    expect(mod.jobs.getJob(failed.jobId)?.error).toBe('bridge_timeout')

    const cancelled = await start('cancel-1', '取消任务')
    if (remote) remote.status = 'cancelled'
    await mod.outbound.pollOutboundRuns()
    expect(mod.jobs.getJob(cancelled.jobId)?.status).toBe('cancelled')
  }, { timeout: 20_000 })

  it('advances from callbacks and ignores a late run.started', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const started = await start('cb-1', '回调任务')
    const runId = started.runId || ''
    const startedBody = JSON.stringify({
      specVersion: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      type: 'run.started',
      seq: 1,
      emittedAt: new Date().toISOString(),
      runId,
      jobId: started.remoteJobId,
      peerId: 'prod',
      idempotencyKey: 'cb-1',
      agent: 'agim',
      status: 'running',
    })
    expect(await postCallback(startedBody, authHeaders())).toBe(204)
    expect(mod.jobs.getJob(started.jobId)?.status).toBe('running')
    expect(gets).toBe(0)
    expect(await postCallback(startedBody, authHeaders())).toBe(204)
    expect(gets).toBe(0)

    if (remote) {
      remote.status = 'completed'
      remote.result = '回调结果'
    }
    const doneBody = JSON.stringify({
      specVersion: 1,
      eventId: '22222222-2222-4222-8222-222222222222',
      type: 'run.completed',
      seq: 2,
      emittedAt: new Date().toISOString(),
      runId,
      jobId: started.remoteJobId,
      peerId: 'prod',
      idempotencyKey: 'cb-1',
      agent: 'agim',
      status: 'completed',
      result: '回调摘要',
      resultTruncated: false,
    })
    const getsBefore = gets
    expect(await postCallback(doneBody, authHeaders())).toBe(204)
    expect(gets).toBe(getsBefore + 1)
    expect(mod.jobs.getJob(started.jobId)?.status).toBe('completed')
    expect(mod.jobs.getJob(started.jobId)?.result).toBe('回调结果')
    expect(await postCallback(doneBody, authHeaders())).toBe(204)
    expect(gets).toBe(getsBefore + 1)

    const late = JSON.stringify({
      specVersion: 1,
      eventId: '33333333-3333-4333-8333-333333333333',
      type: 'run.started',
      seq: 1,
      emittedAt: new Date().toISOString(),
      runId,
      jobId: started.remoteJobId,
      peerId: 'prod',
      idempotencyKey: 'cb-1',
      agent: 'agim',
      status: 'running',
    })
    expect(await postCallback(late, authHeaders())).toBe(204)
    expect(mod.jobs.getJob(started.jobId)?.status).toBe('completed')
    expect(mod.jobs.getJob(started.jobId)?.result).toBe('回调结果')
  }, { timeout: 20_000 })

  it('rejects a bad callback bearer token and keeps the bridge flag gate', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const body = JSON.stringify({
      specVersion: 1,
      eventId: '44444444-4444-4444-8444-444444444444',
      type: 'run.started',
      seq: 1,
      runId: 'missing',
      peerId: 'prod',
      status: 'running',
    })
    const headers = authHeaders()
    headers.authorization = 'Bearer wrong'
    expect(await postCallback(body, headers)).toBe(401)
    process.env.AGIM_BRIDGE_ENABLED = '0'
    try {
      expect(await postCallback(body, authHeaders())).toBe(404)
    } finally {
      process.env.AGIM_BRIDGE_ENABLED = '1'
    }
    const req = {
      method: 'POST',
      url: '/api/bridge/callbacks',
      headers: {},
      socket: { remoteAddress: '203.0.113.20' },
    } as unknown as IncomingMessage
    const res = mockRes()
    expect(mod.checkAuth(req, res, new URL('http://127.0.0.1/api/bridge/callbacks'))).toBe(true)
  })
})
