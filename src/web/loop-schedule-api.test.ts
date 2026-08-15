import { describe, it, expect, afterEach } from 'bun:test'
import { EventEmitter } from 'node:events'
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

type FakeReq = EventEmitter & {
  method: string
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>
}

function makeReq(method: string, body?: unknown): import('node:http').IncomingMessage {
  const ee = new EventEmitter() as FakeReq
  ee.method = method
  const raw = body === undefined ? null : JSON.stringify(body)
  ee[Symbol.asyncIterator] = (async function* () {
    if (raw !== null) yield Buffer.from(raw)
  }) as () => AsyncIterableIterator<Buffer>
  return ee as unknown as import('node:http').IncomingMessage
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

afterEach(() => {
  _clearLoopScheduleForTest()
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
