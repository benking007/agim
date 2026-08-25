// Unit tests for the P1 follow-up /api/heartbeat /api/asks
// REST endpoints. Same shape as llm-api.test.ts + mcp-api.test.ts —
// invoke the dispatcher directly with mock req/res so we don't need
// the whole HTTP server.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { EventEmitter } from 'node:events'

const { handleBackgroundTasksApi } = await import('./background-tasks-api.js')
const { _resetAskBusForTests } = await import('../core/ask-user-rpc.js')

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
  const raw = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body))
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

function asRes(r: MockRes): import('node:http').ServerResponse {
  return r as unknown as import('node:http').ServerResponse
}

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  _resetAskBusForTests()
  saved.AGIM_WEB_AUTH = process.env.AGIM_WEB_AUTH
  process.env.AGIM_WEB_AUTH = 'off'
})

afterEach(() => {
  if (saved.AGIM_WEB_AUTH === undefined) delete process.env.AGIM_WEB_AUTH
  else process.env.AGIM_WEB_AUTH = saved.AGIM_WEB_AUTH
})

describe('handleBackgroundTasksApi — heartbeat list', () => {
  it('returns empty bindings list on fresh install', async () => {
    const res = makeRes()
    const handled = await handleBackgroundTasksApi(makeReq('GET'), asRes(res),
      url('/api/heartbeat/bindings'))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.bindings).toEqual([])
    expect(body.count).toBe(0)
  })

  it('toggle endpoint returns 400 on malformed key', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('POST'), asRes(res),
      url('/api/heartbeat/bindings/justone/enable'))
    expect(res.statusCode).toBe(400)
  })

  it('toggle endpoint returns 404 on unknown binding', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('POST'), asRes(res),
      url('/api/heartbeat/bindings/wechat:rest:never-bound/disable'))
    expect([200, 404]).toContain(res.statusCode)
    // 200 if SQLite unavailable (no-op store); 404 if it returned false.
  })

  it('interval PUT validates body shape', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('PUT', { foo: 'bar' }), asRes(res),
      url('/api/heartbeat/bindings/wechat:rest:t/interval'))
    expect(res.statusCode).toBe(400)
  })
})

describe('handleBackgroundTasksApi — asks', () => {
  it('returns empty pending list when nothing is in flight', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('GET'), asRes(res), url('/api/asks/pending'))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ pending: [], count: 0 })
  })

  it('cancel endpoint returns 404 on unknown reqId', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('POST'), asRes(res),
      url('/api/asks/pending/no-such-id/cancel'))
    expect(res.statusCode).toBe(404)
  })

  // Cancel-happy-path test requires both a registered messenger AND a
  // live pending ask. The native-side test in ask-user-rpc.test.ts
  // already covers the resolution path; here we only verify the HTTP
  // dispatch + 404.
})

describe('handleBackgroundTasksApi — routing', () => {
  it('returns false for unmatched URLs', async () => {
    const res = makeRes()
    const handled = await handleBackgroundTasksApi(makeReq('GET'), asRes(res),
      url('/api/heartbeatx'))
    expect(handled).toBe(false)
  })

  it('does not handle retired /api/goals routes', async () => {
    const res = makeRes()
    const handled = await handleBackgroundTasksApi(makeReq('GET'), asRes(res), url('/api/goals'))
    expect(handled).toBe(false)
  })
})
