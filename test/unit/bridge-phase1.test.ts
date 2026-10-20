/**
 * Phase 1 production bridge: flag, bridge token, poll-only runs.
 * SQLite cases no-op under Bun and run for real via the Node sqlite suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'agim-bridge-phase1-'))
process.env.AGIM_HOME = home
process.env.AGIM_BRIDGE_ENABLED = '1'
process.env.AGIM_WEB_AUTH = 'on'
process.env.AGIM_TRUST_LOOPBACK = 'off'
process.env.AGIM_AUTO_APPROVE = '0'
process.env.LOG_LEVEL = 'silent'

type Loaded = {
  handleBridgeApi: typeof import('../../src/web/bridge-api.js').handleBridgeApi
  handleJobsApi: typeof import('../../src/web/jobs-api.js').handleJobsApi
  handleApprovalsApi: typeof import('../../src/web/approvals-api.js').handleApprovalsApi
  checkAuth: typeof import('../../src/web/auth.js').checkAuth
  bindTokenModule: typeof import('../../src/web/auth.js').bindTokenModule
  resolveWebIdentity: typeof import('../../src/web/auth.js').resolveWebIdentity
  setAccountsModule: typeof import('../../src/web/auth.js').__webAuthForTesting.setAccountsModule
  tokens: typeof import('../../src/core/access-token.js')
  jobs: typeof import('../../src/core/job-board.js')
  runs: typeof import('../../src/core/bridge-run.js')
  peers: typeof import('../../src/core/bridge-peers.js')
  registry: typeof import('../../src/core/registry.js').registry
  clearAgentCache: typeof import('../../src/core/onboarding.js').clearAgentCache
  approvalBus: typeof import('../../src/core/approval-bus.js').approvalBus
  queryInvocations: typeof import('../../src/core/audit-log.js').queryInvocations
  A2A_TIMEOUT_MS_DEFAULT: typeof import('../../src/core/a2a.js').A2A_TIMEOUT_MS_DEFAULT
  A2A_TIMEOUT_MS_MAX: typeof import('../../src/core/a2a.js').A2A_TIMEOUT_MS_MAX
}

let api: Loaded | null = null

try {
  const [
    bridgeApi,
    jobsApi,
    approvalsApi,
    auth,
    tokens,
    jobs,
    runs,
    peers,
    registryMod,
    onboarding,
    approvalMod,
    audit,
    a2a,
  ] = await Promise.all([
    import('../../src/web/bridge-api.js'),
    import('../../src/web/jobs-api.js'),
    import('../../src/web/approvals-api.js'),
    import('../../src/web/auth.js'),
    import('../../src/core/access-token.js'),
    import('../../src/core/job-board.js'),
    import('../../src/core/bridge-run.js'),
    import('../../src/core/bridge-peers.js'),
    import('../../src/core/registry.js'),
    import('../../src/core/onboarding.js'),
    import('../../src/core/approval-bus.js'),
    import('../../src/core/audit-log.js'),
    import('../../src/core/a2a.js'),
  ])
  const probe = jobs.createInlineJob({
    agent: 'probe',
    prompt: 'probe',
    threadKey: 'bridge:probe:probe',
  })
  if (typeof probe === 'number' && probe > 0 && jobs.getJob(probe)) {
    api = {
      handleBridgeApi: bridgeApi.handleBridgeApi,
      handleJobsApi: jobsApi.handleJobsApi,
      handleApprovalsApi: approvalsApi.handleApprovalsApi,
      checkAuth: auth.checkAuth,
      bindTokenModule: auth.bindTokenModule,
      resolveWebIdentity: auth.resolveWebIdentity,
      setAccountsModule: auth.__webAuthForTesting.setAccountsModule,
      tokens,
      jobs,
      runs,
      peers,
      registry: registryMod.registry,
      clearAgentCache: onboarding.clearAgentCache,
      approvalBus: approvalMod.approvalBus,
      queryInvocations: audit.queryInvocations,
      A2A_TIMEOUT_MS_DEFAULT: a2a.A2A_TIMEOUT_MS_DEFAULT,
      A2A_TIMEOUT_MS_MAX: a2a.A2A_TIMEOUT_MS_MAX,
    }
  } else if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error('expected jobs.db for the bridge sqlite suite')
  }
} catch (err) {
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw err
  api = null
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

function mockReq(opts: {
  method: string
  path: string
  body?: string
  token?: string
  tokenHeader?: 'bearer' | 'x-agim'
  idempotencyKey?: string
  remoteAddress?: string
  forwarded?: boolean
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.token && opts.tokenHeader === 'x-agim') headers['x-agim-token'] = opts.token
  else if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey
  if (opts.forwarded !== false) headers['x-forwarded-for'] = '203.0.113.9'
  const body = opts.body ?? ''
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const req = {
    method: opts.method,
    url: opts.path,
    headers,
    socket: { remoteAddress: opts.remoteAddress ?? '203.0.113.10' },
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

function jobCount(): number {
  return api?.jobs.listJobs(1000).length ?? 0
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out')
}

let calls = 0
let blockRun = false
let finishBlock: (() => void) | null = null
let runEntered = false
let wroteAfterAbort = false

const fakeAgent = {
  name: 'agim',
  aliases: [] as string[],
  async isAvailable() { return true },
  sendPrompt(
    _sessionId: string,
    _prompt: string,
    _history?: unknown,
    opts?: { signal?: AbortSignal; callDepth?: number; parentJobId?: number; platform?: string; channelId?: string; threadId?: string; userId?: string },
  ): AsyncGenerator<string> {
    calls += 1
    const hold = blockRun
    return (async function* () {
      runEntered = true
      if (hold) {
        await new Promise<void>((resolve) => {
          const signal = opts?.signal
          if (signal?.aborted) { resolve(); return }
          finishBlock = () => resolve()
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        if (opts?.signal?.aborted) return
        wroteAfterAbort = true
        yield '发布记录正常'
        return
      }
      yield '发布记录正常'
    })()
  },
}

describe('production bridge phase 1', () => {
  beforeAll(() => {
    if (!api) return
    api.registry.registerAgent(fakeAgent)
    api.approvalBus.setNotifier(async () => {})
  })

  beforeEach(() => {
    if (!api) return
    process.env.AGIM_BRIDGE_ENABLED = '1'
    process.env.AGIM_WEB_AUTH = 'on'
    process.env.AGIM_TRUST_LOOPBACK = 'off'
    process.env.AGIM_AUTO_APPROVE = '0'
    api.bindTokenModule(api.tokens)
    api.clearAgentCache()
    finishBlock?.()
    api.runs.resetBridgeInflightForTests()
    calls = 0
    blockRun = false
    finishBlock = null
    runEntered = false
    wroteAfterAbort = false
    api.registry.registerAgent(fakeAgent)
  })

  afterAll(() => {
    if (!api) return
    try { api.jobs.stopJobRetentionSweep() } catch { /* ignore */ }
    try { api.jobs.closeJobBoardDb() } catch { /* ignore */ }
    rmSync(home, { recursive: true, force: true })
  })

  function ready(): Loaded {
    if (!api) throw new Error('sqlite unavailable')
    return api
  }

  function skip(): boolean {
    if (api) return false
    if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
      throw new Error('expected sqlite')
    }
    return true
  }

  async function savePeer(peerId = 'dev-agim', overrides: Partial<import('../../src/core/bridge-peers.js').BridgePeer> = {}) {
    const mod = ready()
    const id = overrides.peerId ?? peerId
    const token = mod.tokens.createToken(`bridge-${id}`, { role: 'bridge' })
    await mod.peers.saveBridgePeers([{
      peerId: id,
      tokenId: overrides.tokenId ?? token.id,
      agents: overrides.agents ?? ['agim'],
      workspaceId: overrides.workspaceId ?? 'default',
      callbackUrl: overrides.callbackUrl ?? null,
      signingSecret: overrides.signingSecret ?? null,
      enabled: overrides.enabled ?? true,
      maxConcurrent: overrides.maxConcurrent ?? 1,
      callbackPinnedHost: overrides.callbackPinnedHost ?? null,
    }])
    return { token: token.raw, tokenId: token.id, peerId: id }
  }

  async function postRun(token: string, body: Record<string, unknown>, key: string, header?: 'bearer' | 'x-agim') {
    const mod = ready()
    const req = mockReq({
      method: 'POST',
      path: '/api/bridge/runs',
      body: JSON.stringify(body),
      token,
      tokenHeader: header,
      idempotencyKey: key,
    })
    const res = mockRes()
    await mod.handleBridgeApi(req, res, new URL(req.url || '/', 'http://localhost'))
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) as Record<string, unknown> : {} }
  }

  it('returns 404 and writes no job when the bridge is off', async () => {
    if (skip()) return
    const before = jobCount()
    process.env.AGIM_BRIDGE_ENABLED = '0'
    const res = mockRes()
    const req = mockReq({ method: 'POST', path: '/api/bridge/runs', body: '{}' })
    await ready().handleBridgeApi(req, res, new URL(req.url || '/', 'http://localhost'))
    expect(res.statusCode).toBe(404)
    expect(jobCount()).toBe(before)
  })

  it('rejects missing, admin, and non-allowlisted agents without a job row', async () => {
    if (skip()) return
    const before = jobCount()
    const mod = ready()
    const cred = await savePeer('unused')
    const admin = mod.tokens.createToken('admin')
    const noToken = await postRun('', { agent: 'agim', prompt: 'hi' }, 'k-none')
    expect(noToken.status).toBe(401)
    const asAdmin = await postRun(admin.raw, { agent: 'agim', prompt: 'hi' }, 'k-admin')
    expect(asAdmin.status).toBe(403)
    const outside = await postRun(cred.token, { agent: 'other', prompt: 'hi' }, 'k-other')
    expect(outside.status).toBe(403)
    await mod.peers.saveBridgePeers([{
      peerId: cred.peerId,
      tokenId: cred.tokenId,
      agents: [],
      workspaceId: 'default',
      callbackUrl: null,
      signingSecret: null,
      enabled: true,
      maxConcurrent: 1,
      callbackPinnedHost: null,
    }])
    const emptyList = await postRun(cred.token, { agent: 'agim', prompt: 'hi' }, 'k-empty')
    expect(emptyList.status).toBe(403)
    const revoked = mod.tokens.createToken('gone', { role: 'bridge' })
    mod.tokens.revokeToken(revoked.id)
    const afterRevoke = await postRun(revoked.raw, { agent: 'agim', prompt: 'hi' }, 'k-revoked')
    expect(afterRevoke.status).toBe(401)
    const blank = await postRun(cred.token, { agent: 'agim', prompt: '   ' }, 'k-blank')
    expect(blank.status).toBe(400)
    const req = mockReq({
      method: 'POST',
      path: '/api/bridge/runs',
      body: JSON.stringify({ agent: 'agim', prompt: 'hi' }),
      token: cred.token,
    })
    const res = mockRes()
    await mod.handleBridgeApi(req, res, new URL(req.url || '/', 'http://localhost'))
    expect(res.statusCode).toBe(400)
    expect(jobCount()).toBe(before)
  })

  it('does not let loopback or an attached admin account turn a bridge token into admin', async () => {
    if (skip()) return
    const before = jobCount()
    const mod = ready()
    process.env.AGIM_TRUST_LOOPBACK = 'on'
    const req = mockReq({
      method: 'POST',
      path: '/api/bridge/runs',
      body: JSON.stringify({ agent: 'agim', prompt: 'hi' }),
      idempotencyKey: 'loop-key',
      remoteAddress: '127.0.0.1',
      forwarded: false,
    })
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const gate = mockRes()
    const passed = mod.checkAuth(req, gate, url)
    const res = mockRes()
    if (passed) await mod.handleBridgeApi(req, res, url)
    expect(passed ? res.statusCode : gate.statusCode).toBe(401)
    expect(jobCount()).toBe(before)

    mod.setAccountsModule({
      hasAnyUser: () => true,
      getUserById: (id: string) => (id === 'usr_admin'
        ? { id, username: 'op', displayName: 'op', role: 'admin' as const, disabled: false, created_at: 0 }
        : undefined),
      verifyLoginSession: () => null,
      getSoleEnabledUser: () => null,
    } as unknown as typeof import('../../src/core/accounts.js'))
    const token = mod.tokens.createToken('scoped', { role: 'bridge', userId: 'usr_admin' })
    const ident = mod.resolveWebIdentity(mockReq({
      method: 'GET',
      path: '/api/jobs',
      token: token.raw,
    }), new URL('http://localhost/api/jobs'))
    expect(ident?.role).toBe('bridge')
    const blocked = mockRes()
    const jobsReq = mockReq({ method: 'GET', path: '/api/jobs', token: token.raw })
    expect(mod.checkAuth(jobsReq, blocked, new URL('http://localhost/api/jobs'))).toBe(false)
    expect(blocked.statusCode).toBe(403)
    mod.setAccountsModule(null)
  })

  it('accepts a run at depth 0, shows it to admins only, and replays the idempotency key', async () => {
    if (skip()) return
    const mod = ready()
    const cred = await savePeer('run')
    const member = mod.tokens.createToken('member', { role: 'user', userId: 'usr_member1' })
    mod.jobs.createJob('agim', 'member own job', { creatorId: 'usr_member1', kind: 'job' })
    const before = jobCount()
    blockRun = true
    const created = await postRun(cred.token, {
      agent: 'agim',
      prompt: '检查生产工作区里今天的发布记录',
      timeoutMs: 1_200_000,
      correlationId: 'dev-ticket-1842',
    }, 'dev-ticket-1842-attempt-1', 'x-agim')
    expect(created.status).toBe(202)
    expect(created.body.status).toBe('pending')
    expect(created.body.agent).toBe('agim')
    expect(typeof created.body.runId).toBe('string')
    expect(typeof created.body.jobId).toBe('number')
    const job = mod.jobs.getJob(created.body.jobId as number)
    expect(job?.kind).toBe('job')
    expect(job?.call_depth).toBe(0)
    expect(job?.parent_id).toBeNull()
    expect(job?.creator_id).toBe(cred.peerId)
    expect(job?.prompt).toBe('检查生产工作区里今天的发布记录')
    expect(job?.thread_key).toBe(`bridge:${cred.peerId}:${created.body.runId}`)
    const side = mod.runs.getBridgeRunByRunId(String(created.body.runId))
    const deadline = Date.parse(side?.timeout_at || '')
    expect(deadline).toBeGreaterThan(Date.now() + 19 * 60 * 1000)
    expect(deadline).toBeLessThan(Date.now() + 21 * 60 * 1000)
    await waitFor(() => runEntered && mod.jobs.getJob(created.body.jobId as number)?.status === 'running')
    expect(jobCount()).toBe(before + 1)

    const admin = mod.tokens.createToken('ops')
    const listReq = mockReq({ method: 'GET', path: '/api/jobs?limit=50', token: admin.raw })
    const listRes = mockRes()
    await mod.handleJobsApi(listReq, listRes, new URL(listReq.url || '/', 'http://localhost'))
    const listed = JSON.parse(listRes.body) as { jobs: Array<{ id: number; agent: string; prompt: string; status: string; bridge?: unknown }> }
    const row = listed.jobs.find((item) => item.id === created.body.jobId)
    expect(row?.agent).toBe('agim')
    expect(row?.prompt).toContain('发布记录')
    expect(row?.status === 'running' || row?.status === 'pending').toBe(true)
    expect(row && 'bridge' in row).toBe(false)

    const memberReq = mockReq({ method: 'GET', path: '/api/jobs?limit=50', token: member.raw })
    const memberRes = mockRes()
    await mod.handleJobsApi(memberReq, memberRes, new URL(memberReq.url || '/', 'http://localhost'))
    const memberJobs = JSON.parse(memberRes.body) as { jobs: Array<{ id: number; prompt: string }> }
    expect(memberJobs.jobs.some((item) => item.id === created.body.jobId)).toBe(false)
    expect(memberJobs.jobs.some((item) => item.prompt === 'member own job')).toBe(true)

    blockRun = false
    finishBlock?.()
    await waitFor(() => mod.jobs.getJob(created.body.jobId as number)?.status === 'completed')

    const detailReq = mockReq({ method: 'GET', path: `/api/jobs/${created.body.jobId}`, token: admin.raw })
    const detailRes = mockRes()
    await mod.handleJobsApi(detailReq, detailRes, new URL(detailReq.url || '/', 'http://localhost'))
    const detail = JSON.parse(detailRes.body) as {
      job: { result: string | null; error: string | null }
      bridge: { callback_status: string; peer_id: string; direction: string }
    }
    const bridgeReq = mockReq({ method: 'GET', path: `/api/bridge/runs/${created.body.runId}`, token: cred.token })
    const bridgeRes = mockRes()
    await mod.handleBridgeApi(bridgeReq, bridgeRes, new URL(bridgeReq.url || '/', 'http://localhost'))
    const bridgeBody = JSON.parse(bridgeRes.body) as { result: string | null; error: string | null; callbackStatus: string; correlationId?: string }
    expect(bridgeRes.statusCode).toBe(200)
    expect(bridgeBody.result).toBe(detail.job.result)
    expect(bridgeBody.error).toBe(detail.job.error)
    expect(bridgeBody.result).toBe('发布记录正常')
    expect(bridgeBody.callbackStatus).toBe('none')
    expect(bridgeBody.correlationId).toBe('dev-ticket-1842')
    expect(detail.bridge.callback_status).toBe('none')
    expect(detail.bridge.peer_id).toBe(cred.peerId)
    expect(detail.bridge.direction).toBe('inbound')

    const memberDetail = mockRes()
    const memberDetailReq = mockReq({ method: 'GET', path: `/api/jobs/${created.body.jobId}`, token: member.raw })
    await mod.handleJobsApi(memberDetailReq, memberDetail, new URL(memberDetailReq.url || '/', 'http://localhost'))
    expect(memberDetail.statusCode).toBe(403)

    const again = await postRun(cred.token, {
      agent: 'agim',
      prompt: '检查生产工作区里今天的发布记录',
      timeoutMs: 1_200_000,
    }, 'dev-ticket-1842-attempt-1')
    expect(again.status).toBe(200)
    expect(again.body.runId).toBe(created.body.runId)
    expect(again.body.jobId).toBe(created.body.jobId)
    expect(jobCount()).toBe(before + 1)
    expect(calls).toBe(1)

    const audits = mod.queryInvocations({ intent: 'bridge', platform: 'bridge', userId: cred.peerId, limit: 10 })
    expect(audits.some((row) => row.success === 1 && row.agent === 'agim')).toBe(true)
  }, { timeout: 20_000 })

  it('does not let a request userId become creator_id', async () => {
    if (skip()) return
    const cred = await savePeer('identity')
    const before = jobCount()
    const rejected = await postRun(cred.token, {
      agent: 'agim',
      prompt: 'task',
      userId: 'usr_admin',
      workspaceId: 'other',
      callbackUrl: 'https://example.com/hook',
      platform: 'web',
    }, 'reject-identity')
    expect(rejected.status).toBe(400)
    expect(jobCount()).toBe(before)
    const ok = await postRun(cred.token, { agent: 'agim', prompt: 'task' }, 'accept-identity')
    expect(ok.status).toBe(202)
    expect(ready().jobs.getJob(ok.body.jobId as number)?.creator_id).toBe(cred.peerId)
  })

  it('clamps the wall clock and rejects 0', async () => {
    if (skip()) return
    const mod = ready()
    const cred = await savePeer('clock')
    const before = jobCount()
    const zero = await postRun(cred.token, { agent: 'agim', prompt: 'task', timeoutMs: 0 }, 'timeout-zero')
    expect(zero.status).toBe(400)
    expect(jobCount()).toBe(before)
    const omitted = await postRun(cred.token, { agent: 'agim', prompt: 'task' }, 'timeout-default')
    const omittedAt = Date.parse(mod.runs.getBridgeRunByRunId(String(omitted.body.runId))?.timeout_at || '')
    expect(Math.abs(omittedAt - (Date.now() + mod.A2A_TIMEOUT_MS_DEFAULT))).toBeLessThan(5_000)
    const capped = await postRun(cred.token, {
      agent: 'agim',
      prompt: 'task',
      timeoutMs: mod.A2A_TIMEOUT_MS_MAX + 60_000,
    }, 'timeout-cap')
    const cappedAt = Date.parse(mod.runs.getBridgeRunByRunId(String(capped.body.runId))?.timeout_at || '')
    expect(Math.abs(cappedAt - (Date.now() + mod.A2A_TIMEOUT_MS_MAX))).toBeLessThan(5_000)
  })

  it('cancels a running agim turn and does not let it write a later result', async () => {
    if (skip()) return
    const mod = ready()
    const cred = await savePeer('cancel-peer')
    blockRun = true
    const created = await postRun(cred.token, { agent: 'agim', prompt: 'long task', timeoutMs: 120_000 }, 'cancel-1')
    expect(created.status).toBe(202)
    const jobId = created.body.jobId as number
    const runId = String(created.body.runId)
    await waitFor(() => runEntered && mod.jobs.getJob(jobId)?.status === 'running')
    const childId = mod.jobs.createInlineJob({
      agent: 'agim',
      prompt: 'child',
      threadKey: `bridge:${cred.peerId}:bridge-${runId}`,
      parentId: jobId,
      callDepth: 1,
    })
    mod.jobs.markJobRunning(childId)
    const req = mockReq({ method: 'POST', path: `/api/bridge/runs/${runId}/cancel`, token: cred.token })
    const res = mockRes()
    await mod.handleBridgeApi(req, res, new URL(req.url || '/', 'http://localhost'))
    expect(res.statusCode).toBe(200)
    await waitFor(() => mod.jobs.getJob(jobId)?.status === 'cancelled')
    expect(wroteAfterAbort).toBe(false)
    expect(mod.jobs.getJob(jobId)?.result ?? '').not.toContain('发布记录正常')
    expect(mod.jobs.getJob(childId)?.status).toBe('cancelled')
    const again = mockRes()
    await mod.handleBridgeApi(req, again, new URL(req.url || '/', 'http://localhost'))
    expect(mod.jobs.getJob(jobId)?.status).toBe('cancelled')
  }, { timeout: 20_000 })

  it('fails a hung run with bridge_timeout', async () => {
    if (skip()) return
    const mod = ready()
    const cred = await savePeer('timeout-peer')
    blockRun = true
    const created = await postRun(cred.token, { agent: 'agim', prompt: 'hang', timeoutMs: 80 }, 'timeout-hang')
    const jobId = created.body.jobId as number
    await waitFor(() => mod.jobs.getJob(jobId)?.status === 'failed')
    expect(mod.jobs.getJob(jobId)?.error).toBe('bridge_timeout')
    const req = mockReq({
      method: 'GET',
      path: `/api/bridge/runs/${created.body.runId}`,
      token: cred.token,
    })
    const res = mockRes()
    await mod.handleBridgeApi(req, res, new URL(req.url || '/', 'http://localhost'))
    const body = JSON.parse(res.body) as { status: string; error: string | null }
    expect(body.status).toBe('failed')
    expect(body.error).toBe(mod.jobs.getJob(jobId)?.error ?? null)
  }, { timeout: 20_000 })

  it('keeps one job when the same idempotency key is posted concurrently', async () => {
    if (skip()) return
    const mod = ready()
    const cred = await savePeer('race-peer')
    blockRun = true
    const before = jobCount()
    const [a, b] = await Promise.all([
      postRun(cred.token, { agent: 'agim', prompt: 'race' }, 'race-key'),
      postRun(cred.token, { agent: 'agim', prompt: 'race' }, 'race-key'),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 202])
    expect(a.body.runId).toBe(b.body.runId)
    expect(a.body.jobId).toBe(b.body.jobId)
    expect(jobCount()).toBe(before + 1)
    await waitFor(() => finishBlock !== null && mod.jobs.getJob(a.body.jobId as number)?.status === 'running')
    const unblock = finishBlock
    blockRun = false
    unblock?.()
    await waitFor(() => mod.jobs.getJob(a.body.jobId as number)?.status === 'completed')
  }, { timeout: 20_000 })

  it('keeps a second run pending while the peer slot is taken', async () => {
    if (skip()) return
    const mod = ready()
    const cred = await savePeer('queue-peer')
    blockRun = true
    const first = await postRun(cred.token, { agent: 'agim', prompt: 'one' }, 'queue-1')
    await waitFor(() => runEntered && finishBlock !== null && mod.jobs.getJob(first.body.jobId as number)?.status === 'running')
    const second = await postRun(cred.token, { agent: 'agim', prompt: 'two' }, 'queue-2')
    expect(second.status).toBe(202)
    expect(mod.jobs.getJob(second.body.jobId as number)?.status).toBe('pending')
    const unblock = finishBlock
    blockRun = false
    unblock?.()
    await waitFor(() => {
      const status = mod.jobs.getJob(second.body.jobId as number)?.status
      return status === 'running' || status === 'completed'
    })
  }, { timeout: 20_000 })

  it('shows a depth-0 write approval and gives the caller no way to allow it', async () => {
    if (skip()) return
    const mod = ready()
    const cred = await savePeer('approval-peer')
    let seenDepth: number | undefined
    let decision: string | null = null
    const reqId = `bridge-write-${Date.now()}`
    let gate: () => void = () => {}
    const opened = new Promise<void>((resolve) => { gate = resolve })
    const previous = fakeAgent.sendPrompt
    fakeAgent.sendPrompt = (_s, _p, _h, opts) => (async function* () {
      seenDepth = opts?.callDepth
      await mod.approvalBus.registerSyntheticPending({
        runId: `bridge-${opts?.parentJobId}`,
        reqId,
        toolName: 'Write',
        input: { file_path: '/tmp/agim-bridge-approval.txt', content: 'note' },
        ctx: {
          platform: opts?.platform || 'bridge',
          channelId: opts?.channelId || cred.peerId,
          threadId: opts?.threadId || 'bridge-thread',
          userId: opts?.userId || cred.peerId,
          callDepth: opts?.callDepth ?? 0,
          parentJobId: opts?.parentJobId,
        },
        dispatch: (value) => { decision = value.behavior },
      })
      gate()
      yield 'finished-without-caller-approval'
    })()
    try {
      const created = await postRun(cred.token, { agent: 'agim', prompt: 'edit the notes' }, 'approval-1')
      expect(created.status).toBe(202)
      await opened
      expect(seenDepth).toBe(0)
      const admin = mod.tokens.createToken('approver')
      const listReq = mockReq({ method: 'GET', path: '/api/approvals', token: admin.raw })
      const listRes = mockRes()
      expect(mod.checkAuth(listReq, listRes, new URL('http://localhost/api/approvals'))).toBe(true)
      await mod.handleApprovalsApi(listReq, listRes, new URL('http://localhost/api/approvals'))
      const pending = JSON.parse(listRes.body) as { pending: Array<{ reqId: string; toolName: string }> }
      expect(pending.pending.some((row) => row.reqId === reqId && row.toolName === 'Write')).toBe(true)
      const allowReq = mockReq({
        method: 'POST',
        path: `/api/approvals/${reqId}/resolve`,
        token: cred.token,
        body: JSON.stringify({ behavior: 'allow' }),
      })
      const allowRes = mockRes()
      expect(mod.checkAuth(allowReq, allowRes, new URL(allowReq.url || '/', 'http://localhost'))).toBe(false)
      expect(allowRes.statusCode).toBe(403)
      expect(decision).toBeNull()
      expect(mod.approvalBus.listPending().some((row) => row.reqId === reqId)).toBe(true)
      await waitFor(() => mod.jobs.getJob(created.body.jobId as number)?.status === 'completed')
      expect(mod.jobs.getJob(created.body.jobId as number)?.result).toBe('finished-without-caller-approval')
    } finally {
      fakeAgent.sendPrompt = previous
      const still = mod.approvalBus.listPending().find((row) => row.reqId === reqId)
      if (still) mod.approvalBus.resolvePendingByReqId(reqId, { behavior: 'deny' }, still.approverUserId)
    }
  }, { timeout: 20_000 })

  it('hides another peer run and rejects a disabled peer', async () => {
    if (skip()) return
    const mod = ready()
    const a = await savePeer('peer-a')
    const bToken = mod.tokens.createToken('peer-b', { role: 'bridge' })
    const both = {
      agents: ['agim'],
      workspaceId: 'default',
      callbackUrl: null,
      signingSecret: null,
      maxConcurrent: 1,
      callbackPinnedHost: null,
    }
    await mod.peers.saveBridgePeers([
      { ...both, peerId: 'peer-a', tokenId: a.tokenId, enabled: true },
      { ...both, peerId: 'peer-b', tokenId: bToken.id, enabled: true },
    ])
    const created = await postRun(a.token, { agent: 'agim', prompt: 'owned' }, 'owned-1')
    const foreign = mockReq({
      method: 'GET',
      path: `/api/bridge/runs/${created.body.runId}`,
      token: bToken.raw,
    })
    const foreignRes = mockRes()
    await mod.handleBridgeApi(foreign, foreignRes, new URL(foreign.url || '/', 'http://localhost'))
    expect(foreignRes.statusCode).toBe(404)
    await mod.peers.saveBridgePeers([
      { ...both, peerId: 'peer-a', tokenId: a.tokenId, enabled: true },
      { ...both, peerId: 'peer-b', tokenId: bToken.id, enabled: false },
    ])
    const before = jobCount()
    const denied = await postRun(bToken.raw, { agent: 'agim', prompt: 'nope' }, 'disabled-1')
    expect(denied.status).toBe(403)
    expect(jobCount()).toBe(before)
  })

  it('rejects an unknown workspace pin and an overlong prompt', async () => {
    if (skip()) return
    const cred = await savePeer('bad-ws', { workspaceId: 'missing-workspace' })
    const before = jobCount()
    const missing = await postRun(cred.token, { agent: 'agim', prompt: 'task' }, 'missing-ws')
    expect(missing.status).toBe(403)
    const longCred = await savePeer('long-prompt')
    const tooLong = await postRun(longCred.token, { agent: 'agim', prompt: 'a'.repeat(32_001) }, 'too-long')
    expect(tooLong.status).toBe(400)
    expect(jobCount()).toBe(before)
  })
})
