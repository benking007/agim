/**
 * MCP Events deliveries for bridge runs. SQLite cases run under vitest.
 * Bun skips them when better-sqlite3 does not load.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { signStandardWebhook } from '../../src/core/bridge-mcp-events.js'

const home = mkdtempSync(join(tmpdir(), 'agim-bridge-mcp-'))
process.env.AGIM_HOME = home
process.env.AGIM_WEB_AUTH = 'on'
process.env.AGIM_TRUST_LOOPBACK = 'off'
process.env.LOG_LEVEL = 'silent'
delete process.env.AGIM_BRIDGE_ENABLED

type Jobs = typeof import('../../src/core/job-board.js')
type Runs = typeof import('../../src/core/bridge-run.js')
type Peers = typeof import('../../src/core/bridge-peers.js')
type Callbacks = typeof import('../../src/core/bridge-callback.js')
type Mcp = typeof import('../../src/core/bridge-mcp-events.js')
type Tools = typeof import('../../src/core/bridge-mcp-tools.js')
type BridgeApi = typeof import('../../src/web/bridge-api.js')

let jobs: Jobs | null = null
let runs: Runs | null = null
let peers: Peers | null = null
let callbacks: Callbacks | null = null
let mcp: Mcp | null = null
let tools: Tools | null = null
let bridgeApi: BridgeApi | null = null
try {
  const loaded = await Promise.all([
    import('../../src/core/job-board.js'),
    import('../../src/core/bridge-run.js'),
    import('../../src/core/bridge-peers.js'),
    import('../../src/core/bridge-callback.js'),
    import('../../src/core/bridge-mcp-events.js'),
    import('../../src/core/bridge-mcp-tools.js'),
    import('../../src/web/bridge-api.js'),
  ])
  const probe = loaded[0].createJob('probe', 'probe')
  if (probe > 0 && loaded[0].getJob(probe)) {
    jobs = loaded[0]
    runs = loaded[1]
    peers = loaded[2]
    callbacks = loaded[3]
    mcp = loaded[4]
    tools = loaded[5]
    bridgeApi = loaded[6]
  } else if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error('expected jobs.db')
  }
} catch (err) {
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw err
}

const certDir = mkdtempSync(join(tmpdir(), 'agim-mcp-cert-'))
let certPem = ''
let keyPem = ''
if (jobs) {
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

const secretKey = Buffer.alloc(32, 11)
const secret = `whsec_${secretKey.toString('base64')}`
const unusedKey = `whk-${createHash('sha256').update('unused').digest('hex').slice(0, 16)}`

type Hit = { headers: IncomingHttpHeaders; raw: string }

describe('bridge mcp events', () => {
  const hits: Hit[] = []
  let server: https.Server | null = null
  let port = 0
  let eventStatus = 204
  let failuresLeft = 0

  afterAll(() => {
    server?.close()
    mcp?.setMcpPostOptionsForTests(null)
    rmSync(home, { recursive: true, force: true })
    rmSync(certDir, { recursive: true, force: true })
  })

  function skip(): boolean {
    if (jobs && runs && peers && callbacks && mcp && tools && bridgeApi && certPem) return false
    if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error('expected sqlite')
    return true
  }

  async function listen(): Promise<void> {
    if (server) return
    server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        hits.push({ headers: req.headers, raw })
        let challenge = ''
        try {
          const parsed = JSON.parse(raw) as { type?: string; challenge?: string }
          if (parsed.type === 'verification' && parsed.challenge) challenge = parsed.challenge
        } catch { /* event body */ }
        if (challenge) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ challenge }))
          return
        }
        let status = 204
        if (failuresLeft > 0) {
          failuresLeft -= 1
          status = eventStatus
        }
        res.writeHead(status)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
    mcp?.setMcpPostOptionsForTests({ caPem: certPem, pinnedHost: '127.0.0.1' })
  }

  function seed(peerId: string, status: 'completed' | 'failed' | 'cancelled'): { jobId: number; runId: string } {
    const board = jobs
    const side = runs
    if (!board || !side) throw new Error('sqlite')
    const runId = `run-${status}-${createHash('sha256').update(`${peerId}:${status}:${Math.random()}`).digest('hex').slice(0, 8)}`
    const jobId = board.createJob('agim', '任务', {
      kind: 'job',
      creatorId: peerId,
      callDepth: 0,
      threadKey: `bridge:${peerId}:${runId}`,
    })
    board.markJobRunning(jobId)
    if (status === 'completed') board.markJobCompleted(jobId, 'full text that must not be in the event')
    else if (status === 'failed') board.markJobFailed(jobId, 'boom')
    else board.cancelJob(jobId)
    side.getBridgeRunByJobId(jobId)
    board.withJobsDatabase((db) => {
      db.prepare(
        `INSERT INTO bridge_runs (
           job_id, run_id, direction, peer_id, idempotency_key, remote_job_id,
           correlation_id, callback_status, wait_reason, timeout_at, last_event_seq
         ) VALUES (?, ?, 'inbound', ?, ?, NULL, NULL, 'none', NULL, NULL, 0)`,
      ).run(jobId, runId, peerId, `idem-${runId}`)
    })
    return { jobId, runId }
  }

  function callbackCount(jobId: number): number {
    const row = jobs?.withJobsDatabase((db) => db.prepare(
      'SELECT COUNT(*) AS n FROM bridge_callbacks WHERE job_id = ?',
    ).get(jobId) as { n: number } | undefined)
    return row?.n ?? 0
  }

  function eventsFor(name = 'agim.run.finished'): Array<{ eventId: string; data: { runId: string; jobId: number; status: string }; raw: string; headers: IncomingHttpHeaders }> {
    const out = []
    for (const hit of hits) {
      let parsed: { name?: string; eventId?: string; data?: { runId: string; jobId: number; status: string } }
      try { parsed = JSON.parse(hit.raw) as typeof parsed } catch { continue }
      if (parsed.name !== name || !parsed.eventId || !parsed.data) continue
      out.push({ eventId: parsed.eventId, data: parsed.data, raw: hit.raw, headers: hit.headers })
    }
    return out
  }

  it('refuses the bridge token as an MCP plugin login', async () => {
    if (skip() || !bridgeApi) return
    const res = mockRes()
    const req = {
      method: 'POST',
      url: '/api/bridge/mcp',
      headers: { authorization: 'Bearer agim_not_a_plugin_login' },
      socket: { remoteAddress: '203.0.113.10' },
      on() { return req },
    } as unknown as IncomingMessage
    const handled = await bridgeApi.handleBridgeApi(req, res, new URL('http://localhost/api/bridge/mcp'))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).code).toBe('MCP_OAUTH_REQUIRED')
  })

  it('rejects a callback URL on create and delivers terminal events once', async () => {
    if (skip() || !peers || !callbacks || !mcp || !tools || !jobs) return
    await listen()
    const postOpts = { caPem: certPem, pinnedHost: '127.0.0.1' as const }
    await peers.saveBridgePeers([
      {
        peerId: 'mcp-caller',
        tokenId: 'tk_mcp',
        agents: ['agim'],
        workspaceId: 'default',
        callbackMode: 'mcp_events',
        callbackUrl: 'https://1.1.1.1/unused',
        signingSecret: unusedKey,
        enabled: true,
        maxConcurrent: 1,
        callbackPinnedHost: null,
      },
      {
        peerId: 'hook-caller',
        tokenId: 'tk_hook',
        agents: ['agim'],
        workspaceId: 'default',
        callbackMode: 'webhook',
        callbackUrl: 'https://1.1.1.1/hook',
        signingSecret: unusedKey,
        enabled: true,
        maxConcurrent: 1,
        callbackPinnedHost: null,
      },
      {
        peerId: 'poll-caller',
        tokenId: 'tk_poll',
        agents: ['agim'],
        workspaceId: 'default',
        callbackMode: 'poll',
        callbackUrl: 'https://1.1.1.1/poll',
        signingSecret: unusedKey,
        enabled: true,
        maxConcurrent: 1,
        callbackPinnedHost: null,
      },
    ])
    const rejected = tools.agimCreateRun(peers.loadBridgePeers()[0]!, {
      agent: 'agim',
      prompt: 'no',
      timeoutMs: 1200000,
      idempotencyKey: 'idem-1',
      callbackUrl: 'https://example.com/hook',
    })
    expect(rejected.ok).toBe(false)
    const wrongAgent = tools.agimCreateRun(peers.loadBridgePeers()[0]!, {
      agent: 'claude',
      prompt: 'no',
      timeoutMs: 1200000,
      idempotencyKey: 'idem-2',
    })
    expect(wrongAgent.ok).toBe(false)

    const subscribed = await mcp.subscribeMcpEvent({
      name: 'agim.run.finished',
      arguments: {},
      delivery: { mode: 'webhook', url: `https://127.0.0.1:${port}/hook`, secret },
    }, postOpts)
    expect(subscribed.ok).toBe(true)
    if (!subscribed.ok) return
    const before = eventsFor().length
    const finished = (['completed', 'failed', 'cancelled'] as const).map((status) => seed('mcp-caller', status))
    for (const row of finished) callbacks.enqueueBridgeTerminal(row.jobId)
    await mcp.flushBridgeMcpDeliveries()
    const delivered = eventsFor().slice(before)
    expect(delivered.map((row) => row.data.status).sort()).toEqual(['cancelled', 'completed', 'failed'])
    for (const row of delivered) {
      expect(row.raw.includes('full text that must not be in the event')).toBe(false)
      expect(row.raw.includes(unusedKey)).toBe(false)
      expect(row.headers.authorization).toBeUndefined()
      expect(row.headers['webhook-id']).toBe(row.eventId)
      expect(row.headers['x-mcp-subscription-id']).toBe(subscribed.id)
      const timestamp = String(row.headers['webhook-timestamp'] || '')
      expect(row.headers['webhook-signature']).toBe(signStandardWebhook(secret, row.eventId, timestamp, row.raw) ?? '')
      expect(Object.keys(row.data).sort()).toEqual(['jobId', 'runId', 'status'])
    }
    const seen = eventsFor().length
    for (const row of finished) callbacks.enqueueBridgeTerminal(row.jobId)
    await mcp.flushBridgeMcpDeliveries()
    expect(eventsFor().length).toBe(seen)

    const late = seed('mcp-caller', 'completed')
    const backfill = await mcp.subscribeMcpEvent({
      name: 'agim.run.finished',
      arguments: { runId: late.runId },
      delivery: { mode: 'webhook', url: `https://127.0.0.1:${port}/late`, secret },
    }, postOpts)
    expect(backfill.ok).toBe(true)
    const lateHits = eventsFor().filter((row) => row.headers['x-mcp-subscription-id'] === (backfill.ok ? backfill.id : ''))
    expect(lateHits).toHaveLength(1)
    expect(lateHits[0]?.data.status).toBe('completed')
    expect(lateHits[0]?.eventId).toBe(mcp.stableFinishedEventId(late.runId, 'completed'))
    const lateCount = eventsFor().length
    await mcp.subscribeMcpEvent({
      name: 'agim.run.finished',
      arguments: { runId: late.runId },
      delivery: { mode: 'webhook', url: `https://127.0.0.1:${port}/late`, secret },
    }, postOpts)
    expect(eventsFor().length).toBe(lateCount)
    expect(jobs.getJob(late.jobId)?.status).toBe('completed')

    const paired = [seed('mcp-caller', 'completed'), seed('mcp-caller', 'failed')]
    for (const row of paired) callbacks.enqueueBridgeTerminal(row.jobId)
    await mcp.flushBridgeMcpDeliveries()
    for (const row of paired) {
      expect(eventsFor().some((hit) => hit.data.runId === row.runId)).toBe(true)
    }

    const hooked = seed('hook-caller', 'completed')
    const polled = seed('poll-caller', 'completed')
    const mcpBefore = eventsFor().length
    callbacks.enqueueBridgeTerminal(hooked.jobId)
    callbacks.enqueueBridgeTerminal(polled.jobId)
    await mcp.flushBridgeMcpDeliveries()
    expect(callbackCount(hooked.jobId)).toBe(1)
    expect(callbackCount(polled.jobId)).toBe(0)
    expect(eventsFor().length).toBe(mcpBefore)
    expect(eventsFor().some((hit) => hit.raw.includes(unusedKey))).toBe(false)
  }, { timeout: 20_000 })

  it('retries 5xx after restart, stops on 410, expiry, and unsubscribe', async () => {
    if (skip() || !peers || !callbacks || !mcp || !jobs) return
    await listen()
    mcp.setMcpRetryBackoffForTests([0, 0, 0])
    jobs.withJobsDatabase((db) => {
      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bridge_mcp_subscriptions'`,
      ).get()
      if (table) db.prepare('UPDATE bridge_mcp_subscriptions SET active = 0').run()
    })
    const postOpts = { caPem: certPem, pinnedHost: '127.0.0.1' as const }
    await peers.saveBridgePeers([{
      peerId: 'mcp-retry',
      tokenId: 'tk_retry',
      agents: ['agim'],
      workspaceId: 'default',
      callbackMode: 'mcp_events',
      callbackUrl: null,
      signingSecret: null,
      enabled: true,
      maxConcurrent: 1,
      callbackPinnedHost: null,
    }])
    eventStatus = 500
    failuresLeft = 1
    const subscribed = await mcp.subscribeMcpEvent({
      name: 'agim.run.finished',
      arguments: {},
      delivery: { mode: 'webhook', url: `https://127.0.0.1:${port}/retry`, secret },
    }, postOpts)
    expect(subscribed.ok).toBe(true)
    if (!subscribed.ok) return
    const job = seed('mcp-retry', 'completed')
    callbacks.enqueueBridgeTerminal(job.jobId)
    await mcp.flushBridgeMcpDeliveries()
    const first = eventsFor().filter((row) => row.data.runId === job.runId)
    expect(first).toHaveLength(1)
    expect(jobs.getJob(job.jobId)?.status).toBe('completed')
    eventStatus = 204
    failuresLeft = 0
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await mcp.resumePendingMcpDeliveries()
    const again = eventsFor().filter((row) => row.data.runId === job.runId)
    expect(again).toHaveLength(2)
    expect(again[0]?.eventId).toBe(again[1]?.eventId)
    expect(again[0]?.headers['webhook-timestamp']).not.toBe(again[1]?.headers['webhook-timestamp'])

    eventStatus = 410
    failuresLeft = 5
    const gone = seed('mcp-retry', 'failed')
    callbacks.enqueueBridgeTerminal(gone.jobId)
    await mcp.flushBridgeMcpDeliveries()
    const goneHits = eventsFor().filter((row) => row.data.runId === gone.runId)
    expect(goneHits).toHaveLength(1)
    await mcp.resumePendingMcpDeliveries()
    expect(eventsFor().filter((row) => row.data.runId === gone.runId)).toHaveLength(1)
    expect(jobs.getJob(gone.jobId)?.status).toBe('failed')
    failuresLeft = 0

    jobs.withJobsDatabase((db) => {
      db.prepare('UPDATE bridge_mcp_subscriptions SET refresh_before = ? WHERE id = ?').run(
        new Date(Date.now() - 60_000).toISOString(),
        subscribed.id,
      )
    })
    const expired = seed('mcp-retry', 'cancelled')
    const beforeExpired = eventsFor().length
    callbacks.enqueueBridgeTerminal(expired.jobId)
    await mcp.flushBridgeMcpDeliveries()
    expect(eventsFor().filter((row) => row.data.runId === expired.runId)).toHaveLength(0)
    expect(eventsFor().length).toBe(beforeExpired)
    expect(jobs.getJob(expired.jobId)?.status).toBe('cancelled')

    jobs.withJobsDatabase((db) => {
      db.prepare('UPDATE bridge_mcp_subscriptions SET refresh_before = ? WHERE id = ?').run(
        new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        subscribed.id,
      )
    })
    const running = seed('mcp-retry', 'completed')
    jobs.withJobsDatabase((db) => {
      db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(running.jobId)
    })
    const removed = mcp.unsubscribeMcpEvent({
      name: 'agim.run.finished',
      arguments: {},
      delivery: { mode: 'webhook', url: `https://127.0.0.1:${port}/retry` },
    })
    expect(removed.ok).toBe(true)
    expect(jobs.getJob(running.jobId)?.status).toBe('running')
    jobs.markJobCompleted(running.jobId, 'still complete')
    const beforeStop = eventsFor().length
    callbacks.enqueueBridgeTerminal(running.jobId)
    await mcp.flushBridgeMcpDeliveries()
    expect(eventsFor().length).toBe(beforeStop)
    expect(jobs.getJob(running.jobId)?.status).toBe('completed')
    mcp.setMcpRetryBackoffForTests(null)
    eventStatus = 204
    failuresLeft = 0
  }, { timeout: 20_000 })
})

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
