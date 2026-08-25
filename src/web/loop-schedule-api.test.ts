import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  _clearLoopScheduleForTest,
  getPendingLoopSchedule,
  setPendingLoopSchedule,
} from '../core/pending-loop-schedule.js'
import { handleLoopScheduleApi } from './loop-schedule-api.js'

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(k: string, v: string): void
  writeHead(status: number, headers?: Record<string, string>): void
  end(b: string): void
}

function makeReq(method: string, body?: unknown): import('node:http').IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const req = {
    method,
    headers: {},
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
  return req as unknown as import('node:http').IncomingMessage
}

function makeRes(): MockRes {
  const r: MockRes = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k: string, v: string) { r.headers[k] = v },
    writeHead(status: number, headers?: Record<string, string>) {
      r.statusCode = status
      if (headers) Object.assign(r.headers, headers)
    },
    end(b: string) { r.body = b },
  }
  return r
}

function url(path: string): URL {
  return new URL(`http://localhost${path}`)
}

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved.AGIM_WEB_AUTH = process.env.AGIM_WEB_AUTH
  process.env.AGIM_WEB_AUTH = 'off'
})

afterEach(() => {
  _clearLoopScheduleForTest()
  if (saved.AGIM_WEB_AUTH === undefined) delete process.env.AGIM_WEB_AUTH
  else process.env.AGIM_WEB_AUTH = saved.AGIM_WEB_AUTH
})

describe('handleLoopScheduleApi', () => {
  it('GET returns null when no draft', async () => {
    const res = makeRes()
    const handled = await handleLoopScheduleApi(
      makeReq('GET'),
      res as unknown as import('node:http').ServerResponse,
      url('/api/loop-schedule/pending?threadId=t-empty'),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { pending: unknown }
    expect(body.pending).toBeNull()
  })

  it('GET returns a stashed draft', async () => {
    setPendingLoopSchedule('web:web:t-get', {
      name: 'loop-login',
      cron: '0 2 * * *',
      cronLabel: '每天 02:00',
      timeText: '每天凌晨2点',
      objective: '修登录',
      exitDescription: '验收通过',
      headless: false,
    })
    const res = makeRes()
    await handleLoopScheduleApi(
      makeReq('GET'),
      res as unknown as import('node:http').ServerResponse,
      url('/api/loop-schedule/pending?threadId=t-get'),
    )
    const body = JSON.parse(res.body) as { pending: { cron: string; objective: string } }
    expect(body.pending.cron).toBe('0 2 * * *')
    expect(body.pending.objective).toBe('修登录')
  })

  it('POST confirm rejects missing exit', async () => {
    const res = makeRes()
    await handleLoopScheduleApi(
      makeReq('POST', {
        threadId: 't-bad',
        timeText: '每天凌晨2点',
        objective: '修登录',
        exitDescription: '',
      }),
      res as unknown as import('node:http').ServerResponse,
      url('/api/loop-schedule/confirm'),
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('退出条件')
  })

  it('POST cancel clears the draft', async () => {
    setPendingLoopSchedule('web:web:t-cancel', {
      name: 'x',
      cron: '0 2 * * *',
      cronLabel: '每天 02:00',
      timeText: '每天凌晨2点',
      objective: '修登录',
      exitDescription: '验收通过',
      headless: false,
    })
    const res = makeRes()
    await handleLoopScheduleApi(
      makeReq('POST', { threadId: 't-cancel' }),
      res as unknown as import('node:http').ServerResponse,
      url('/api/loop-schedule/cancel'),
    )
    expect(res.statusCode).toBe(200)
    expect(getPendingLoopSchedule('web:web:t-cancel')).toBeNull()
  })
})
