import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const HOME = mkdtempSync(join(tmpdir(), 'agim-sched-owner-'))
process.env.AGIM_HOME = HOME
process.env.AGIM_WEB_AUTH = 'on'
process.env.AGIM_TRUST_LOOPBACK = 'off'

const { handleScheduleApi } = await import('./schedule-api.js')
const { handleJobsApi } = await import('./jobs-api.js')
const { bindAccountsModule } = await import('./auth.js')
const { registry } = await import('../core/registry.js')
import type { AgentAdapter } from '../core/types.js'

const stubAgent: AgentAdapter = {
  name: 'agim',
  aliases: [],
  async *sendPrompt() { yield '' },
  async isAvailable() { return true },
}
if (!registry.listAgents().includes('agim')) registry.registerAgent(stubAgent)

const ADMIN = { id: 'usr_admin01', role: 'admin' as const, username: 'operator' }
const MEMBER = { id: 'usr_member02', role: 'user' as const, username: 'alice' }
type TestUser = typeof ADMIN | typeof MEMBER

function publicUser(u: TestUser) {
  return { id: u.id, username: u.username, displayName: u.username, role: u.role, createdAt: 1, disabled: false }
}

function bindSessions(): void {
  bindAccountsModule({
    hasAnyUser: () => true,
    verifyLoginSession: (raw: string) => {
      if (raw === 'sess-admin') return publicUser(ADMIN)
      if (raw === 'sess-member') return publicUser(MEMBER)
      return null
    },
    getUserById: (id: string) => {
      if (id === ADMIN.id) return publicUser(ADMIN)
      if (id === MEMBER.id) return publicUser(MEMBER)
      return null
    },
    getSoleEnabledUser: () => null,
  } as unknown as typeof import('../core/accounts.js'))
}

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(k: string, v: string): void
  writeHead(code: number, headers?: Record<string, string>): void
  end(b: string): void
}

function makeReq(method: string, opts: { body?: unknown; session?: string } = {}): IncomingMessage {
  const raw = opts.body === undefined ? '' : JSON.stringify(opts.body)
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const headers: Record<string, string> = {
    'x-forwarded-for': '203.0.113.9',
  }
  if (opts.session) headers.cookie = `agim_session=${opts.session}`
  const req = {
    method,
    headers,
    socket: { remoteAddress: '10.0.0.2' },
    on(ev: string, cb: (...a: unknown[]) => void) {
      if (!listeners[ev]) listeners[ev] = []
      listeners[ev].push(cb)
      if (ev === 'data') {
        queueMicrotask(() => {
          if (raw) cb(Buffer.from(raw))
          for (const end of listeners.end ?? []) end()
        })
      }
      return req
    },
  }
  return req as unknown as IncomingMessage
}

function makeRes(): MockRes {
  const r: MockRes = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { r.headers[k] = v },
    writeHead(code, headers) {
      r.statusCode = code
      if (headers) Object.assign(r.headers, headers)
    },
    end(b) { r.body = b },
  }
  return r
}

function asRes(r: MockRes): ServerResponse {
  return r as unknown as ServerResponse
}

function url(path: string): URL {
  return new URL(`http://localhost${path}`)
}

async function jsonCall(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>,
  method: string,
  path: string,
  opts: { body?: unknown; session?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = makeRes()
  await handler(makeReq(method, opts), asRes(res), url(path))
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(res.body || '{}') as Record<string, unknown> } catch { parsed = { raw: res.body } }
  return { status: res.statusCode, body: parsed }
}

let dbAvailable = false
try {
  const sched = await import('../core/schedule.js')
  const id = sched.createSchedule({
    name: 'probe',
    agent: 'agim',
    cron: '0 9 * * *',
    prompt: 'probe',
  })
  dbAvailable = id > 0
  if (id > 0) sched.deleteSchedule(id)
} catch {
  dbAvailable = false
}
const skipIfNoDb = dbAvailable ? describe : describe.skip

beforeEach(() => {
  bindSessions()
})

afterEach(() => {
  bindAccountsModule(null)
})

afterAll(() => {
  bindAccountsModule(null)
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

skipIfNoDb('schedule owner isolation', () => {
  it('lists and mutates only the signed-in account, including admins', async () => {
    const adminCreate = await jsonCall(handleScheduleApi, 'POST', '/api/schedules', {
      session: 'sess-admin',
      body: { name: 'admin-gold', agent: 'agim', cron: '30 9 * * *', prompt: 'admin prompt' },
    })
    expect(adminCreate.status).toBe(201)
    const adminId = (adminCreate.body as { id: number }).id
    expect((adminCreate.body.schedule as { creator_id: string }).creator_id).toBe(ADMIN.id)

    const memberCreate = await jsonCall(handleScheduleApi, 'POST', '/api/schedules', {
      session: 'sess-member',
      body: { name: 'member-gold', agent: 'agim', cron: '0 8 * * *', prompt: 'member prompt' },
    })
    expect(memberCreate.status).toBe(201)
    const memberId = (memberCreate.body as { id: number }).id

    const adminList = await jsonCall(handleJobsApi, 'GET', '/api/schedules', { session: 'sess-admin' })
    expect(adminList.status).toBe(200)
    const adminRows = (adminList.body.schedules as Array<{ id: number; name: string }>)
    expect(adminRows.map((s) => s.name)).toEqual(['admin-gold'])

    const memberList = await jsonCall(handleJobsApi, 'GET', '/api/schedules', { session: 'sess-member' })
    expect(memberList.status).toBe(200)
    const memberRows = (memberList.body.schedules as Array<{ id: number; name: string }>)
    expect(memberRows.map((s) => s.name)).toEqual(['member-gold'])

    const adminPatchOther = await jsonCall(handleScheduleApi, 'PATCH', `/api/schedules/${memberId}`, {
      session: 'sess-admin',
      body: { name: 'hijacked' },
    })
    expect(adminPatchOther.status).toBe(403)

    const memberPatchOwn = await jsonCall(handleScheduleApi, 'PATCH', `/api/schedules/${memberId}`, {
      session: 'sess-member',
      body: { name: 'member-gold-2', prompt: 'updated member prompt' },
    })
    expect(memberPatchOwn.status).toBe(200)
    expect((memberPatchOwn.body.schedule as { name: string }).name).toBe('member-gold-2')

    const adminDeleteOther = await jsonCall(handleScheduleApi, 'DELETE', `/api/schedules/${memberId}`, {
      session: 'sess-admin',
    })
    expect(adminDeleteOther.status).toBe(403)

    const memberDelete = await jsonCall(handleScheduleApi, 'DELETE', `/api/schedules/${memberId}`, {
      session: 'sess-member',
    })
    expect(memberDelete.status).toBe(200)
    const adminDelete = await jsonCall(handleScheduleApi, 'DELETE', `/api/schedules/${adminId}`, {
      session: 'sess-admin',
    })
    expect(adminDelete.status).toBe(200)
  })

  it('GET /api/jobs?mine=1 hides other accounts even for admins', async () => {
    const { createJob } = await import('../core/job-board.js')
    const mine = createJob('agim', '<!-- agim:schedule {"artifacts":"A"} -->\nmine', { creatorId: ADMIN.id })
    const theirs = createJob('agim', '<!-- agim:schedule {"artifacts":"B"} -->\ntheirs', { creatorId: MEMBER.id })
    expect(mine).toBeGreaterThan(0)
    expect(theirs).toBeGreaterThan(0)

    const adminAll = await jsonCall(handleJobsApi, 'GET', '/api/jobs?limit=50', { session: 'sess-admin' })
    expect(adminAll.status).toBe(200)
    const allIds = ((adminAll.body.jobs as Array<{ id: number }>) ?? []).map((j) => j.id)
    expect(allIds).toContain(mine)
    expect(allIds).toContain(theirs)

    const adminMine = await jsonCall(handleJobsApi, 'GET', '/api/jobs?mine=1&limit=50', { session: 'sess-admin' })
    expect(adminMine.status).toBe(200)
    const mineIds = ((adminMine.body.jobs as Array<{ id: number }>) ?? []).map((j) => j.id)
    expect(mineIds).toContain(mine)
    expect(mineIds).not.toContain(theirs)
  })
})
