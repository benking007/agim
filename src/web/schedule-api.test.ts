import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const HOME = mkdtempSync(join(tmpdir(), 'agim-sched-api-'))
process.env.AGIM_HOME = HOME

const { handleScheduleApi } = await import('./schedule-api.js')
const { registry } = await import('../core/registry.js')
import type { AgentAdapter } from '../core/types.js'

const stubAgent: AgentAdapter = {
  name: 'agim',
  aliases: [],
  async *sendPrompt() { yield '' },
  async isAvailable() { return true },
}
if (!registry.listAgents().includes('agim')) registry.registerAgent(stubAgent)

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(k: string, v: string): void
  writeHead(code: number, headers?: Record<string, string>): void
  end(b: string): void
}
function makeReq(method: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const req = {
    method,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
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
    writeHead(code: number, headers?: Record<string, string>) {
      r.statusCode = code
      if (headers) Object.assign(r.headers, headers)
    },
    end(b) { r.body = b },
  }
  return r
}

function url(path: string): URL { return new URL(`http://localhost${path}`) }
function asRes(r: MockRes): ServerResponse {
  return r as unknown as ServerResponse
}

afterAll(() => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('POST /api/schedules validation', () => {
  it('rejects missing fields and unknown agents', async () => {
    const missing = makeRes()
    await handleScheduleApi(makeReq('POST', { name: 'x' }), asRes(missing), url('/api/schedules'))
    expect(missing.statusCode).toBe(400)

    const unknown = makeRes()
    await handleScheduleApi(makeReq('POST', {
      name: 'daily',
      agent: 'no-such-agent',
      cron: '0 9 * * *',
      prompt: 'hi',
    }), asRes(unknown), url('/api/schedules'))
    expect(unknown.statusCode).toBe(400)
    expect(unknown.body).toMatch(/unknown agent/)
  })

  it('rejects a bad cron expression', async () => {
    const res = makeRes()
    await handleScheduleApi(makeReq('POST', {
      name: 'daily',
      agent: 'agim',
      cron: 'not-cron',
      prompt: 'hi',
    }), asRes(res), url('/api/schedules'))
    expect(res.statusCode).toBe(400)
  })
})

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

skipIfNoDb('schedule write REST (sqlite)', () => {
  it('creates, patches, and deletes a member-visible row', async () => {
    const created = makeRes()
    await handleScheduleApi(makeReq('POST', {
      name: 'gold-daily',
      agent: 'agim',
      cron: '30 9 * * *',
      prompt: '<!-- agim:schedule {"model":"deepseek-v4-pro","artifacts":"PROJECTS/gold"} -->\n写日报',
    }), asRes(created), url('/api/schedules'))
    expect(created.statusCode).toBe(201)
    const { id } = JSON.parse(created.body) as { id: number }
    expect(id).toBeGreaterThan(0)

    const patched = makeRes()
    await handleScheduleApi(makeReq('PATCH', { enabled: false }), asRes(patched), url(`/api/schedules/${id}`))
    expect(patched.statusCode).toBe(200)
    expect(JSON.parse(patched.body).schedule.enabled).toBe(0)

    const deleted = makeRes()
    await handleScheduleApi(makeReq('DELETE'), asRes(deleted), url(`/api/schedules/${id}`))
    expect(deleted.statusCode).toBe(200)
  })
})
