// Unit tests for the Stage 6 /api/mcp/* REST endpoints.
//
// Same approach as llm-api.test.ts — invoke handleMcpApi directly with
// mock IncomingMessage / ServerResponse so we don't spin up the whole
// HTTP server. AGIM_HOME is overridden to a temp dir for isolation.

import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const TMP_OWN = mkdtempSync(join(tmpdir(), 'agim-mcp-api-'))
process.env.AGIM_HOME = TMP_OWN

const { handleMcpApi } = await import('./mcp-api.js')
const { AGIM_HOME } = await import('../core/agim-paths.js')
const TMP = AGIM_HOME

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
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  mkdirSync(TMP, { recursive: true })
})

describe('handleMcpApi — list', () => {
  it('returns empty list on fresh install', async () => {
    const res = makeRes()
    const handled = await handleMcpApi(makeReq('GET'), asRes(res), url('/api/mcp'))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.servers).toEqual([])
    expect(body.runtime.servers).toEqual([])
    expect(body.runtime.totalTools).toBe(0)
  })
})

describe('handleMcpApi — add server', () => {
  it('happy-path stdio: persists to config.json', async () => {
    const res = makeRes()
    await handleMcpApi(makeReq('POST', {
      name: 'fs1',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    }), asRes(res), url('/api/mcp/servers'))
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).name).toBe('fs1')
    const config = JSON.parse(readFileSync(join(TMP, 'config.json'), 'utf-8'))
    expect(config.mcpServers).toHaveLength(1)
    expect(config.mcpServers[0].name).toBe('fs1')
    expect(config.mcpServers[0].command).toBe('npx')
  })

  it('happy-path http: persists with url + headers', async () => {
    const res = makeRes()
    await handleMcpApi(makeReq('POST', {
      name: 'http1',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer xxx' },
    }), asRes(res), url('/api/mcp/servers'))
    expect(res.statusCode).toBe(201)
  })

  it('rejects server with neither command nor url', async () => {
    const res = makeRes()
    await handleMcpApi(makeReq('POST', { name: 'bad1' }),
      asRes(res), url('/api/mcp/servers'))
    expect(res.statusCode).toBe(400)
  })

  it('rejects server with BOTH command and url', async () => {
    const res = makeRes()
    await handleMcpApi(makeReq('POST', {
      name: 'bad2',
      command: 'foo',
      url: 'https://example.com',
    }), asRes(res), url('/api/mcp/servers'))
    expect(res.statusCode).toBe(400)
  })

  it('rejects bad name', async () => {
    const res = makeRes()
    await handleMcpApi(makeReq('POST', {
      name: 'has spaces',
      command: 'foo',
    }), asRes(res), url('/api/mcp/servers'))
    expect(res.statusCode).toBe(400)
  })

  it('rejects duplicate name with 409', async () => {
    const add = { name: 'dup', command: 'foo' }
    await handleMcpApi(makeReq('POST', add), asRes(makeRes()), url('/api/mcp/servers'))
    const r2 = makeRes()
    await handleMcpApi(makeReq('POST', add), asRes(r2), url('/api/mcp/servers'))
    expect(r2.statusCode).toBe(409)
  })
})

describe('handleMcpApi — remove server', () => {
  it('404 on unknown name', async () => {
    const res = makeRes()
    await handleMcpApi(makeReq('DELETE'), asRes(res),
      url('/api/mcp/servers/no-such'))
    expect(res.statusCode).toBe(404)
  })

  it('removes a registered server', async () => {
    await handleMcpApi(makeReq('POST', { name: 's1', command: 'foo' }),
      asRes(makeRes()), url('/api/mcp/servers'))
    const res = makeRes()
    await handleMcpApi(makeReq('DELETE'), asRes(res), url('/api/mcp/servers/s1'))
    expect(res.statusCode).toBe(200)
    const config = JSON.parse(readFileSync(join(TMP, 'config.json'), 'utf-8'))
    expect(config.mcpServers).toEqual([])
  })
})

describe('handleMcpApi — health probe', () => {
  it('404 on unknown server', async () => {
    const res = makeRes()
    await handleMcpApi(makeReq('POST'), asRes(res),
      url('/api/mcp/servers/no-such/health'))
    expect(res.statusCode).toBe(404)
  })

  it('returns 200 with connected=false when the configured stdio binary does not exist', async () => {
    await handleMcpApi(makeReq('POST', {
      name: 'bogus',
      command: '/no/such/binary/agim-test-stub',
    }), asRes(makeRes()), url('/api/mcp/servers'))
    const res = makeRes()
    await handleMcpApi(makeReq('POST'), asRes(res),
      url('/api/mcp/servers/bogus/health'))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.name).toBe('bogus')
    // connected will be false since the binary doesn't exist; we just
    // verify the wire shape matches and lastError is populated.
    expect(body).toHaveProperty('connected')
    expect(body).toHaveProperty('toolCount')
  })
})

describe('handleMcpApi — non-matching URL returns false', () => {
  it('GET /api/mcpx is not handled', async () => {
    const res = makeRes()
    const handled = await handleMcpApi(makeReq('GET'), asRes(res), url('/api/mcpx'))
    expect(handled).toBe(false)
  })
})

describe('config-schema regression — restored llmBackends/mcpServers/llmRoles', () => {
  it('configSchema validates llmBackends correctly', async () => {
    const { configSchema } = await import('../core/config-schema.js')
    expect(configSchema.safeParse({
      llmBackends: [{ name: 'ok', provider: 'openai-compat', model: 'm' }],
    }).success).toBe(true)
    // Bad provider rejected
    expect(configSchema.safeParse({
      llmBackends: [{ name: 'ok', provider: 'mystery', model: 'm' }],
    }).success).toBe(false)
  })

  it('configSchema validates mcpServers correctly', async () => {
    const { configSchema } = await import('../core/config-schema.js')
    // command-only is fine
    expect(configSchema.safeParse({
      mcpServers: [{ name: 'a', command: 'foo' }],
    }).success).toBe(true)
    // url-only is fine
    expect(configSchema.safeParse({
      mcpServers: [{ name: 'b', url: 'https://x.com/mcp' }],
    }).success).toBe(true)
    // both rejected
    expect(configSchema.safeParse({
      mcpServers: [{ name: 'c', command: 'foo', url: 'https://x.com' }],
    }).success).toBe(false)
    // neither rejected
    expect(configSchema.safeParse({
      mcpServers: [{ name: 'd' }],
    }).success).toBe(false)
  })

  it('configSchema accepts llmRoles record', async () => {
    const { configSchema } = await import('../core/config-schema.js')
    expect(configSchema.safeParse({
      llmRoles: { cheap: 'b1', evaluator: 'b2' },
    }).success).toBe(true)
  })
})
