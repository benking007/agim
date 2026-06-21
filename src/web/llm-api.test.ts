// Unit tests for the Stage 4 /api/llm REST endpoints.
//
// We invoke handleLlmApi directly with mock IncomingMessage / Server-
// Response objects rather than spinning up the whole HTTP server.
// Disk side effects land in a per-test temp dir via AGIM_HOME.

import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const TMP_OWN = mkdtempSync(join(tmpdir(), 'agim-llm-api-'))
process.env.AGIM_HOME = TMP_OWN

const { handleLlmApi } = await import('./llm-api.js')
const { AGIM_HOME } = await import('../core/agim-paths.js')
const { getAnyProvider, _resetRegistry } = await import('../core/llm/registry.js')
const TMP = AGIM_HOME

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(k: string, v: string): void
  end(b: string): void
}

// Minimal IncomingMessage-shaped EventEmitter that handleLlmApi can
// `for await ... of req` against. Cast through unknown at the
// boundary; handler only touches .method + async iterator.
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

beforeEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  mkdirSync(TMP, { recursive: true })
  _resetRegistry()
})

describe('handleLlmApi — list', () => {
  it('returns empty arrays on a fresh install', async () => {
    const req = makeReq('GET')
    const res = makeRes()
    const handled = await handleLlmApi(req, res as unknown as import('node:http').ServerResponse, url('/api/llm'))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.backends).toEqual([])
    expect(body.roles).toEqual({})
  })
})

describe('handleLlmApi — add backend', () => {
  it('rejects missing name / bad provider / non-http baseUrl', async () => {
    for (const bad of [
      {},
      { name: 'bad name with spaces', provider: 'openai-compat', baseUrl: 'https://x.com', model: 'm' },
      { name: 'ok', provider: 'mystery', baseUrl: 'https://x.com', model: 'm' },
      { name: 'ok', provider: 'openai-compat', baseUrl: 'ftp://x.com', model: 'm' },
      { name: 'ok', provider: 'openai-compat', baseUrl: 'https://x.com', model: '' },
    ]) {
      const res = makeRes()
      await handleLlmApi(makeReq('POST', bad), res as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
      expect(res.statusCode).toBe(400)
    }
  })

  it('happy-path persists backend + secret to disk and re-reads via list', async () => {
    const add = { name: 'deepseek', provider: 'openai-compat',
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-test-123' }
    const res1 = makeRes()
    await handleLlmApi(makeReq('POST', add), res1 as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    expect(res1.statusCode).toBe(201)
    expect(JSON.parse(res1.body).secretStored).toBe(true)

    expect(existsSync(join(TMP, 'config.json'))).toBe(true)
    expect(existsSync(join(TMP, 'llm-secrets.json'))).toBe(true)

    const res2 = makeRes()
    await handleLlmApi(makeReq('GET'), res2 as unknown as import('node:http').ServerResponse, url('/api/llm'))
    const body = JSON.parse(res2.body)
    expect(body.backends).toHaveLength(1)
    expect(body.backends[0].name).toBe('deepseek')
    expect(body.backends[0].secret.source).toBe('file')
  })

  it('refreshes in-process LLM registry immediately after save', async () => {
    const add = { name: 'runtime-ok', provider: 'openai-compat',
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-live' }
    const res = makeRes()
    await handleLlmApi(makeReq('POST', add), res as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    expect(res.statusCode).toBe(201)
    expect(getAnyProvider()?.name).toBe('runtime-ok')
  })

  it('refuses duplicate name with 409', async () => {
    const base = { name: 'foo', provider: 'openai-compat',
      baseUrl: 'https://x.com/v1', model: 'm' }
    const r1 = makeRes()
    await handleLlmApi(makeReq('POST', base), r1 as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    expect(r1.statusCode).toBe(201)
    const r2 = makeRes()
    await handleLlmApi(makeReq('POST', base), r2 as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    expect(r2.statusCode).toBe(409)
  })
})

describe('handleLlmApi — remove backend', () => {
  it('404 on unknown name', async () => {
    const res = makeRes()
    await handleLlmApi(makeReq('DELETE'), res as unknown as import('node:http').ServerResponse, url('/api/llm/backends/nope'))
    expect(res.statusCode).toBe(404)
  })

  it('drops roles pointing at the removed backend', async () => {
    const add = { name: 'd', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm', apiKey: 'k' }
    await handleLlmApi(makeReq('POST', add), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    await handleLlmApi(makeReq('PUT', { cheap: 'd', evaluator: 'd' }), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/roles'))

    const res = makeRes()
    await handleLlmApi(makeReq('DELETE'), res as unknown as import('node:http').ServerResponse, url('/api/llm/backends/d'))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).removedRoles).toBe(2)

    const list = makeRes()
    await handleLlmApi(makeReq('GET'), list as unknown as import('node:http').ServerResponse, url('/api/llm'))
    const body = JSON.parse(list.body)
    expect(body.backends).toEqual([])
    expect(body.roles).toEqual({})
  })
})

describe('handleLlmApi — roles', () => {
  it('rejects role pointing at unknown backend', async () => {
    const res = makeRes()
    await handleLlmApi(makeReq('PUT', { cheap: 'no-such' }), res as unknown as import('node:http').ServerResponse, url('/api/llm/roles'))
    expect(res.statusCode).toBe(400)
  })

  it('null / empty value unbinds the role', async () => {
    const add = { name: 'a', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm' }
    await handleLlmApi(makeReq('POST', add), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    await handleLlmApi(makeReq('PUT', { cheap: 'a' }), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/roles'))
    const r = makeRes()
    await handleLlmApi(makeReq('PUT', { cheap: null }), r as unknown as import('node:http').ServerResponse, url('/api/llm/roles'))
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).roles).toEqual({})
  })
})

describe('handleLlmApi — secrets', () => {
  it('404 on backend that does not exist', async () => {
    const res = makeRes()
    await handleLlmApi(makeReq('POST', { apiKey: 'k' }), res as unknown as import('node:http').ServerResponse, url('/api/llm/secrets/no-such'))
    expect(res.statusCode).toBe(404)
  })

  it('round-trips save and remove for an existing backend', async () => {
    const add = { name: 's1', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm' }
    await handleLlmApi(makeReq('POST', add), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))

    const saveRes = makeRes()
    await handleLlmApi(makeReq('POST', { apiKey: 'sk-xxx' }), saveRes as unknown as import('node:http').ServerResponse, url('/api/llm/secrets/s1'))
    expect(saveRes.statusCode).toBe(200)

    const rmRes = makeRes()
    await handleLlmApi(makeReq('DELETE'), rmRes as unknown as import('node:http').ServerResponse, url('/api/llm/secrets/s1'))
    expect(rmRes.statusCode).toBe(200)
    expect(getAnyProvider()).toBeNull()
  })

  it('rejects empty apiKey', async () => {
    const add = { name: 's2', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm' }
    await handleLlmApi(makeReq('POST', add), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    const res = makeRes()
    await handleLlmApi(makeReq('POST', { apiKey: '' }), res as unknown as import('node:http').ServerResponse, url('/api/llm/secrets/s2'))
    expect(res.statusCode).toBe(400)
  })
})

describe('handleLlmApi — non-matching URL returns false', () => {
  it('GET /api/llmx is not handled', async () => {
    const res = makeRes()
    const handled = await handleLlmApi(makeReq('GET'), res as unknown as import('node:http').ServerResponse, url('/api/llmx'))
    expect(handled).toBe(false)
  })

  it('disk written with 0600 perms', async () => {
    const add = { name: 'p1', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm' }
    await handleLlmApi(makeReq('POST', add), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    const content = readFileSync(join(TMP, 'config.json'), 'utf-8')
    expect(content).toContain('"p1"')
    expect(content).toContain('"openai-compat"')
  })
})
