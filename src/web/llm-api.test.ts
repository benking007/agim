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
      { name: 'bad name with spaces', provider: 'openai-compat', baseUrl: 'https://x.com', model: 'm', apiKey: 'k' },
      { name: 'ok', provider: 'mystery', baseUrl: 'https://x.com', model: 'm', apiKey: 'k' },
      { name: 'ok', provider: 'openai-compat', baseUrl: 'ftp://x.com', model: 'm', apiKey: 'k' },
      { name: 'ok', provider: 'openai-compat', baseUrl: 'https://x.com', model: '', apiKey: 'k' },
      { name: 'ok', provider: 'openai-compat', baseUrl: 'https://x.com', model: 'm', apiKey: '' },
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

  it('enriches list contextWindow/maxTokens from pi catalog when unset', async () => {
    const add = {
      name: 'deepseek-v4-pro',
      provider: 'openai-compat',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKey: 'sk-ds',
    }
    const res1 = makeRes()
    await handleLlmApi(makeReq('POST', add), res1 as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    expect(res1.statusCode).toBe(201)

    const disk = JSON.parse(readFileSync(join(TMP, 'config.json'), 'utf8')) as {
      llmBackends: Array<Record<string, unknown>>
    }
    // Disk must stay unset (catalog fill is list-time only).
    expect(disk.llmBackends[0].contextWindow).toBeUndefined()
    expect(disk.llmBackends[0].maxTokens).toBeUndefined()

    const res2 = makeRes()
    await handleLlmApi(makeReq('GET'), res2 as unknown as import('node:http').ServerResponse, url('/api/llm'))
    const body = JSON.parse(res2.body) as { backends: Array<Record<string, unknown>> }
    expect(body.backends[0].contextWindow).toBe(1_000_000)
    expect(body.backends[0].maxTokens).toBe(384_000)
  })

  it('persists custom advanced fields (thinking / context / headers)', async () => {
    const add = {
      name: 'proxy-1',
      provider: 'openai-compat',
      baseUrl: 'https://llm.internal/v1',
      model: 'proxy-model',
      apiKey: 'sk-proxy',
      temperature: 0.2,
      maxTokens: 8192,
      contextWindow: 200000,
      thinkingFormat: 'deepseek',
      maxTokensField: 'max_completion_tokens',
      extraHeaders: 'X-Tenant: acme\napi-key: sk-extra',
    }
    const res1 = makeRes()
    await handleLlmApi(makeReq('POST', add), res1 as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    expect(res1.statusCode).toBe(201)

    const disk = JSON.parse(readFileSync(join(TMP, 'config.json'), 'utf8')) as {
      llmBackends: Array<Record<string, unknown>>
    }
    expect(disk.llmBackends[0]).toMatchObject({
      name: 'proxy-1',
      temperature: 0.2,
      maxTokens: 8192,
      contextWindow: 200000,
      thinkingFormat: 'deepseek',
      maxTokensField: 'max_completion_tokens',
      // Disk keeps the raw value; list API redacts secret-bearing headers.
      extraHeaders: { 'X-Tenant': 'acme', 'api-key': 'sk-extra' },
    })

    const res2 = makeRes()
    await handleLlmApi(makeReq('GET'), res2 as unknown as import('node:http').ServerResponse, url('/api/llm'))
    const body = JSON.parse(res2.body) as { backends: Array<Record<string, unknown>> }
    expect(body.backends[0]).toMatchObject({
      thinkingFormat: 'deepseek',
      contextWindow: 200000,
      extraHeaders: { 'X-Tenant': 'acme', 'api-key': '***' },
    })
  })

  it('rejects Authorization in extraHeaders', async () => {
    const add = {
      name: 'proxy-auth',
      provider: 'openai-compat',
      baseUrl: 'https://llm.internal/v1',
      model: 'm',
      apiKey: 'sk',
      extraHeaders: { Authorization: 'Bearer leaked' },
    }
    const res = makeRes()
    await handleLlmApi(makeReq('POST', add), res as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/Authorization/i)
  })

  it('round-trips thinkingFormat off on GET /api/llm', async () => {
    const add = {
      name: 'proxy-off',
      provider: 'openai-compat',
      baseUrl: 'https://llm.internal/v1',
      model: 'proxy-model',
      apiKey: 'sk-off',
      thinkingFormat: 'off',
    }
    const res1 = makeRes()
    await handleLlmApi(makeReq('POST', add), res1 as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    expect(res1.statusCode).toBe(201)

    const res2 = makeRes()
    await handleLlmApi(makeReq('GET'), res2 as unknown as import('node:http').ServerResponse, url('/api/llm'))
    const body = JSON.parse(res2.body) as { backends: Array<Record<string, unknown>> }
    expect(body.backends[0]?.thinkingFormat).toBe('off')
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
      baseUrl: 'https://x.com/v1', model: 'm', apiKey: 'k' }
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
    const add = { name: 'a', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm', apiKey: 'k' }
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
    const add = { name: 's1', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm', apiKey: 'k1' }
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
    const add = { name: 's2', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm', apiKey: 'k2' }
    await handleLlmApi(makeReq('POST', add), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    const res = makeRes()
    await handleLlmApi(makeReq('POST', { apiKey: '' }), res as unknown as import('node:http').ServerResponse, url('/api/llm/secrets/s2'))
    expect(res.statusCode).toBe(400)
  })
})

describe('handleLlmApi — presets + quick-enable', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    _resetRegistry()
  })

  it('GET /api/llm/presets returns DeepSeek as default', async () => {
    const res = makeRes()
    const handled = await handleLlmApi(makeReq('GET'), res as unknown as import('node:http').ServerResponse, url('/api/llm/presets'))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      defaultPreset: string
      presets: Array<{ key: string; model: string; cheapModel?: string; models?: string[] }>
    }
    expect(body.defaultPreset).toBe('deepseek')
    expect(body.presets[0]?.key).toBe('deepseek')
    expect(body.presets[0]?.model).toBe('deepseek-v4-pro')
    const kimi = body.presets.find((p) => p.key === 'moonshot')
    expect(kimi?.model).toBe('kimi-k3')
    expect(kimi?.cheapModel).toBe('kimi-k2.6')
    expect(kimi?.models).toEqual(['kimi-k3', 'kimi-k2.6'])
    const glm = body.presets.find((p) => p.key === 'zhipu')
    expect(glm?.model).toBe('glm-5.2')
    expect(glm?.cheapModel).toBe('glm-4.7-flash')
    expect(glm?.models).toEqual(['glm-5.2', 'glm-4.7-flash'])
    const mimo = body.presets.find((p) => p.key === 'mimo')
    expect(mimo?.model).toBe('mimo-v2.5-pro')
    expect(mimo?.cheapModel).toBe('mimo-v2.5')
    expect(mimo?.models).toEqual(['mimo-v2.5-pro', 'mimo-v2.5'])
    expect(body.presets.some((p) => p.key === 'openai')).toBe(false)
    expect(body.presets.some((p) => p.key === 'anthropic')).toBe(false)
  })

  it('POST /api/llm/quick-enable creates DeepSeek backend and roles', async () => {
    const res = makeRes()
    const handled = await handleLlmApi(
      makeReq('POST', { apiKey: 'sk-quick-1' }),
      res as unknown as import('node:http').ServerResponse,
      url('/api/llm/quick-enable'),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as {
      model: string
      backends?: Array<{ name: string; model: string }>
      roles: Record<string, string>
      defaultAgent: string
    }
    expect(body.model).toBe('deepseek-v4-pro')
    expect(body.backends?.map((b) => b.model)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
    expect(body.roles['native-chat']).toBeTruthy()
    expect(body.backends?.[1]?.name).toBeTruthy()
    expect(body.roles.cheap).toBe(body.backends![1]!.name)
    expect(body.defaultAgent).toBe('agim')
  })
})

describe('handleLlmApi — non-matching URL returns false', () => {
  it('GET /api/llmx is not handled', async () => {
    const res = makeRes()
    const handled = await handleLlmApi(makeReq('GET'), res as unknown as import('node:http').ServerResponse, url('/api/llmx'))
    expect(handled).toBe(false)
  })

  it('disk written with 0600 perms', async () => {
    const add = { name: 'p1', provider: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'm', apiKey: 'k' }
    await handleLlmApi(makeReq('POST', add), makeRes() as unknown as import('node:http').ServerResponse, url('/api/llm/backends'))
    const content = readFileSync(join(TMP, 'config.json'), 'utf-8')
    expect(content).toContain('"p1"')
    expect(content).toContain('"openai-compat"')
  })
})
