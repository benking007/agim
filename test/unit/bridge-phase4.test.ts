/**
 * Phase 4: approval/progress callbacks and the jobs-list bridge filter.
 * Progress events use only the documented common fields.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

const home = mkdtempSync(joinTmp())
process.env.AGIM_HOME = home
process.env.AGIM_BRIDGE_ENABLED = '1'
process.env.AGIM_WEB_AUTH = 'on'
process.env.AGIM_TRUST_LOOPBACK = 'off'
process.env.AGIM_AUTO_APPROVE = '0'
process.env.LOG_LEVEL = 'silent'

function joinTmp(): string {
  return `${tmpdir()}/agim-bridge-phase4-`
}

type Loaded = {
  handleBridgeApi: typeof import('../../src/web/bridge-api.js').handleBridgeApi
  handleJobsApi: typeof import('../../src/web/jobs-api.js').handleJobsApi
  bindTokenModule: typeof import('../../src/web/auth.js').bindTokenModule
  tokens: typeof import('../../src/core/access-token.js')
  jobs: typeof import('../../src/core/job-board.js')
  peers: typeof import('../../src/core/bridge-peers.js')
  callbacks: typeof import('../../src/core/bridge-callback.js')
  runs: typeof import('../../src/core/bridge-run.js')
  approvalBus: typeof import('../../src/core/approval-bus.js').approvalBus
}

let api: Loaded | null = null
try {
  const [bridgeApi, jobsApi, auth, tokens, jobs, peers, callbacks, runs, approval] = await Promise.all([
    import('../../src/web/bridge-api.js'),
    import('../../src/web/jobs-api.js'),
    import('../../src/web/auth.js'),
    import('../../src/core/access-token.js'),
    import('../../src/core/job-board.js'),
    import('../../src/core/bridge-peers.js'),
    import('../../src/core/bridge-callback.js'),
    import('../../src/core/bridge-run.js'),
    import('../../src/core/approval-bus.js'),
  ])
  const id = jobs.createJob('probe', 'probe')
  if (id > 0 && jobs.getJob(id)) {
    api = {
      handleBridgeApi: bridgeApi.handleBridgeApi,
      handleJobsApi: jobsApi.handleJobsApi,
      bindTokenModule: auth.bindTokenModule,
      tokens,
      jobs,
      peers,
      callbacks,
      runs,
      approvalBus: approval.approvalBus,
    }
  } else if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error('expected jobs.db')
  }
} catch (err) {
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw err
  api = null
}

const toolArg = `tool-arg-${randomBytes(8).toString('hex')}`
const progressText = `visible-${'p'.repeat(240)}`
let port = 0
let server: http.Server | null = null
const bodies: string[] = []

function skip(): boolean {
  if (api) return false
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error('expected sqlite')
  return true
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

describe('bridge phase 4 observability', () => {
  const secret = randomBytes(16).toString('hex')

  beforeAll(async () => {
    if (!api) return
    api.bindTokenModule(api.tokens)
    api.approvalBus.setNotifier(async () => {})
    api.callbacks.ensureBridgeApprovalListener()
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(204)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  beforeEach(async () => {
    if (!api) return
    bodies.length = 0
    api.callbacks.__setBridgeClockForTests(null)
    await api.peers.saveBridgePeers([{
      peerId: 'dev',
      tokenId: 'tk_phase4',
      agents: ['agim'],
      workspaceId: 'default',
      callbackUrl: `http://127.0.0.1:${port}/hook`,
      signingSecret: secret,
      enabled: true,
      maxConcurrent: 1,
      callbackPinnedHost: '127.0.0.1',
    }])
  })

  afterAll(() => {
    server?.close()
    if (api) {
      try { api.jobs.stopJobRetentionSweep() } catch { /* ignore */ }
      try { api.jobs.closeJobBoardDb() } catch { /* ignore */ }
    }
    rmSync(home, { recursive: true, force: true })
  })

  function seedRunning(runId: string): number {
    const mod = api
    if (!mod) throw new Error('sqlite')
    const jobId = mod.jobs.createJob('agim', '检查发布', {
      kind: 'job',
      creatorId: 'dev',
      callDepth: 0,
      threadKey: `bridge:dev:${runId}`,
    })
    mod.jobs.markJobRunning(jobId)
    mod.runs.getBridgeRunByJobId(jobId)
    mod.jobs.withJobsDatabase((db) => {
      db.prepare(
        `INSERT INTO bridge_runs (
           job_id, run_id, direction, peer_id, idempotency_key, remote_job_id,
           correlation_id, callback_status, wait_reason, timeout_at, last_event_seq
         ) VALUES (?, ?, 'inbound', 'dev', ?, NULL, NULL, 'none', NULL, NULL, 0)`,
      ).run(jobId, runId, `key-${runId}`)
    })
    return jobId
  }

  async function deliver() {
    const mod = api
    if (!mod) throw new Error('sqlite')
    for (let i = 0; i < 10; i += 1) {
      const n = await mod.callbacks.deliverDueCallbacks({ backoffSeconds: [0, 0, 0, 0, 0, 0] })
      if (n === 0) return
    }
  }

  it('sends waiting_approval without tool arguments and keeps the job running', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const jobId = seedRunning(runId)
    await mod.approvalBus.registerSyntheticPending({
      runId: `bridge-run-${jobId}`,
      reqId: `req-${jobId}`,
      toolName: 'Write',
      input: { file_path: toolArg, content: 'do not leak' },
      ctx: {
        platform: 'bridge',
        channelId: 'dev',
        threadId: `bridge-${runId}`,
        userId: 'dev',
        callDepth: 0,
        parentJobId: jobId,
      },
      dispatch() {},
    })
    expect(mod.jobs.getJob(jobId)?.status).toBe('running')
    await deliver()
    const waiting = bodies.map((body) => JSON.parse(body) as { type?: string; status?: string })
      .filter((body) => body.type === 'run.waiting_approval')
    expect(waiting.length).toBeGreaterThan(0)
    expect(waiting.every((body) => body.status === 'running')).toBe(true)
    expect(bodies.some((body) => body.includes(toolArg))).toBe(false)
    expect(bodies.some((body) => body.includes('file_path'))).toBe(false)
    expect(mod.jobs.getJob(jobId)?.status).toBe('running')
    const admin = mod.tokens.createToken('ops')
    const req = {
      method: 'GET',
      url: '/api/jobs?limit=50',
      headers: { authorization: `Bearer ${admin.raw}` },
      socket: { remoteAddress: '203.0.113.10' },
      on() { return req },
    } as unknown as IncomingMessage
    const res = mockRes()
    await mod.handleJobsApi(req, res, new URL('http://127.0.0.1/api/jobs?limit=50'))
    const listed = JSON.parse(res.body) as { jobs: Array<{ id: number; status: string }> }
    expect(listed.jobs.find((job) => job.id === jobId)?.status).toBe('running')
  }, { timeout: 20_000 })

  it('throttles progress and still returns the terminal GET if progress is dropped', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const runId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const jobId = seedRunning(runId)
    let now = 1_000_000
    mod.callbacks.__setBridgeClockForTests(() => now)
    mod.callbacks.noteBridgeProgress(jobId)
    mod.callbacks.noteBridgeProgress(jobId)
    const first = mod.jobs.withJobsDatabase((db) => db.prepare(
      `SELECT COUNT(*) AS n FROM bridge_callbacks WHERE job_id = ? AND event_type = 'run.progress'`,
    ).get(jobId) as { n: number })
    expect(first?.n).toBe(1)
    now += 10_000
    mod.callbacks.noteBridgeProgress(jobId)
    const second = mod.jobs.withJobsDatabase((db) => db.prepare(
      `SELECT COUNT(*) AS n FROM bridge_callbacks WHERE job_id = ? AND event_type = 'run.progress'`,
    ).get(jobId) as { n: number })
    expect(second?.n).toBe(2)
    const raw = mod.jobs.withJobsDatabase((db) => db.prepare(
      `SELECT body FROM bridge_callbacks WHERE job_id = ? AND event_type = 'run.progress'`,
    ).all(jobId) as Array<{ body: string }>) ?? []
    for (const row of raw) {
      const parsed = JSON.parse(row.body) as Record<string, unknown>
      expect(parsed.type).toBe('run.progress')
      expect(parsed.status).toBe('running')
      expect(row.body.includes(progressText)).toBe(false)
      expect(row.body.includes(toolArg)).toBe(false)
      expect(Object.keys(parsed).sort()).toEqual([
        'agent', 'emittedAt', 'eventId', 'idempotencyKey', 'jobId', 'peerId', 'runId', 'seq', 'specVersion', 'status', 'type',
      ])
    }
    mod.jobs.withJobsDatabase((db) => {
      db.prepare(`DELETE FROM bridge_callbacks WHERE job_id = ? AND event_type = 'run.progress'`).run(jobId)
    })
    mod.jobs.markJobCompleted(jobId, '发布记录正常')
    const bridgeToken = mod.tokens.createToken('bridge-reader', { role: 'bridge' })
    await mod.peers.saveBridgePeers([{
      peerId: 'dev',
      tokenId: bridgeToken.id,
      agents: ['agim'],
      workspaceId: 'default',
      callbackUrl: null,
      signingSecret: null,
      enabled: true,
      maxConcurrent: 1,
      callbackPinnedHost: null,
    }])
    const req = {
      method: 'GET',
      url: `/api/bridge/runs/${runId}`,
      headers: { authorization: `Bearer ${bridgeToken.raw}` },
      socket: { remoteAddress: '203.0.113.10' },
      on() { return req },
    } as unknown as IncomingMessage
    const res = mockRes()
    await mod.handleBridgeApi(req, res, new URL(`http://127.0.0.1/api/bridge/runs/${runId}`))
    const body = JSON.parse(res.body) as { status: string; result: string | null }
    expect(res.statusCode).toBe(200)
    expect(body.status).toBe('completed')
    expect(body.result).toBe('发布记录正常')
  })

  it('lists conversation jobs by default and only bridge rows when source=bridge', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const inlineId = mod.jobs.createInlineJob({
      agent: 'agim',
      prompt: '普通对话',
      threadKey: 'web:web:web-chatphase4',
      creatorId: 'usr_chat',
    })
    const bridgeId = seedRunning('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const admin = mod.tokens.createToken('lister')
    const handleJobsApi = mod.handleJobsApi
    async function list(source: boolean) {
      const path = source ? '/api/jobs?limit=50&source=bridge' : '/api/jobs?limit=50'
      const req = {
        method: 'GET',
        url: path,
        headers: { authorization: `Bearer ${admin.raw}` },
        socket: { remoteAddress: '203.0.113.10' },
        on() { return req },
      } as unknown as IncomingMessage
      const res = mockRes()
      await handleJobsApi(req, res, new URL(`http://127.0.0.1${path}`))
      return JSON.parse(res.body) as { jobs: Array<{ id: number; prompt: string }> }
    }
    const all = await list(false)
    expect(all.jobs.some((job) => job.id === inlineId && job.prompt === '普通对话')).toBe(true)
    expect(all.jobs.some((job) => job.id === bridgeId)).toBe(true)
    const only = await list(true)
    expect(only.jobs.some((job) => job.id === bridgeId)).toBe(true)
    expect(only.jobs.some((job) => job.id === inlineId)).toBe(false)
    expect(only.jobs.every((job) => job.prompt !== '普通对话')).toBe(true)
  })

  it('does not enqueue progress for a poll-only peer', async () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    await mod.peers.saveBridgePeers([{
      peerId: 'dev',
      tokenId: 'tk_poll',
      agents: ['agim'],
      workspaceId: 'default',
      callbackUrl: null,
      signingSecret: null,
      enabled: true,
      maxConcurrent: 1,
      callbackPinnedHost: null,
    }])
    const jobId = seedRunning('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    mod.callbacks.__setBridgeClockForTests(() => 1_000_000)
    mod.callbacks.noteBridgeProgress(jobId)
    const n = mod.jobs.withJobsDatabase((db) => db.prepare(
      `SELECT COUNT(*) AS n FROM bridge_callbacks WHERE job_id = ? AND event_type = 'run.progress'`,
    ).get(jobId) as { n: number })
    expect(n?.n).toBe(0)
  })

  it('allows a second progress event after the phase-2 singleton unique index is removed', () => {
    if (skip()) return
    const mod = api
    if (!mod) return
    const jobId = seedRunning('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    mod.jobs.withJobsDatabase((db) => {
      db.exec('DROP TABLE IF EXISTS bridge_callbacks')
      db.exec(`
        CREATE TABLE bridge_callbacks (
          id              INTEGER PRIMARY KEY,
          event_id        TEXT    NOT NULL UNIQUE,
          run_id          TEXT    NOT NULL,
          job_id          INTEGER NOT NULL,
          peer_id         TEXT    NOT NULL,
          event_type      TEXT    NOT NULL,
          seq             INTEGER NOT NULL,
          body            TEXT    NOT NULL,
          status          TEXT    NOT NULL DEFAULT 'pending',
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error      TEXT,
          created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE (run_id, event_type)
        )
      `)
    })
    let now = 3_000_000
    mod.callbacks.__setBridgeClockForTests(() => now)
    mod.callbacks.noteBridgeProgress(jobId)
    now += 10_000
    mod.callbacks.noteBridgeProgress(jobId)
    const n = mod.jobs.withJobsDatabase((db) => db.prepare(
      `SELECT COUNT(*) AS n FROM bridge_callbacks WHERE job_id = ? AND event_type = 'run.progress'`,
    ).get(jobId) as { n: number })
    expect(n?.n).toBe(2)
  })
})
