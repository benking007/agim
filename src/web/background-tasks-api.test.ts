// Unit tests for the P1 follow-up /api/heartbeat /api/goals /api/asks
// REST endpoints. Same shape as llm-api.test.ts + mcp-api.test.ts —
// invoke the dispatcher directly with mock req/res so we don't need
// the whole HTTP server.

import { describe, it, expect, beforeEach } from 'bun:test'
import { EventEmitter } from 'node:events'

const { handleBackgroundTasksApi } = await import('./background-tasks-api.js')
const { _resetAskBusForTests, handleAskOp } = await import('../core/ask-user-rpc.js')
const { _truncateForTests: truncGoals, setActiveGoal } = await import('../core/goals.js')

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(k: string, v: string): void
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

beforeEach(() => {
  _resetAskBusForTests()
  try { truncGoals() } catch { /* sqlite may be unavailable */ }
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

describe('handleBackgroundTasksApi — goals', () => {
  it('returns empty list on fresh install', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('GET'), asRes(res), url('/api/goals'))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.goals).toEqual([])
    expect(body.scope).toBe('all-active')
  })

  it('narrows to thread when scope params present', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('GET'), asRes(res),
      url('/api/goals?platform=wechat&channelId=c&threadId=t'))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scope).toBe('thread')
  })

  it('GET /:id returns 404 on unknown id', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('GET'), asRes(res), url('/api/goals/999999'))
    expect(res.statusCode).toBe(404)
  })

  it('status PUT rejects unknown status', async () => {
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('PUT', { status: 'whatever' }), asRes(res),
      url('/api/goals/1/status'))
    expect(res.statusCode).toBe(400)
  })

  it('status PUT happy path round-trips when goal exists (sqlite-dependent)', async () => {
    const created = setActiveGoal({
      platform: 'wechat', channelId: 'rest', threadId: 'unit-1',
      userId: 'u', title: 'demo',
    })
    if (!created) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
        throw new Error('SQLite is required by the Node persistence suite')
      }
      return
    }
    const res = makeRes()
    await handleBackgroundTasksApi(makeReq('PUT', { status: 'paused' }), asRes(res),
      url(`/api/goals/${created.id}/status`))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('paused')
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
})
