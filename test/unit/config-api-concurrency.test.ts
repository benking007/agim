import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'agim-config-api-concurrency-'))
process.env.AGIM_HOME = TMP

const { handleLlmApi } = await import('../../src/web/llm-api.js')
const { handleMcpApi } = await import('../../src/web/mcp-api.js')

type FakeReq = EventEmitter & {
  method: string
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>
}

interface FakeRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(name: string, value: string): void
  end(body: string): void
}

function request(method: string, body: unknown): import('node:http').IncomingMessage {
  const req = new EventEmitter() as FakeReq
  req.method = method
  const raw = Buffer.from(JSON.stringify(body))
  req[Symbol.asyncIterator] = (async function* () { yield raw }) as () => AsyncIterableIterator<Buffer>
  return req as unknown as import('node:http').IncomingMessage
}

function response(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { res.headers[name] = value },
    end(body) { res.body = body },
  }
  return res
}

function asServerResponse(res: FakeRes): import('node:http').ServerResponse {
  return res as unknown as import('node:http').ServerResponse
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'config.json'), JSON.stringify({
    messengers: [],
    agents: ['claude-code'],
    defaultAgent: 'claude-code',
    sentinel: { preserved: true },
  }))
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('config API concurrency', () => {
  it('preserves concurrent LLM and MCP updates without lock/temp debris', async () => {
    const llmRes = response()
    const mcpResA = response()
    const mcpResB = response()

    await Promise.all([
      handleLlmApi(
        request('POST', {
          name: 'concurrent-llm',
          provider: 'openai-compat',
          baseUrl: 'https://llm.example.test/v1',
          model: 'demo-model',
          apiKey: 'test-secret',
        }),
        asServerResponse(llmRes),
        new URL('http://localhost/api/llm/backends'),
      ),
      handleMcpApi(
        request('POST', { name: 'mcp-a', command: '/bin/echo', args: ['a'] }),
        asServerResponse(mcpResA),
        new URL('http://localhost/api/mcp/servers'),
      ),
      handleMcpApi(
        request('POST', { name: 'mcp-b', command: '/bin/echo', args: ['b'] }),
        asServerResponse(mcpResB),
        new URL('http://localhost/api/mcp/servers'),
      ),
    ])

    expect([llmRes.statusCode, mcpResA.statusCode, mcpResB.statusCode]).toEqual([201, 201, 201])
    const stored = JSON.parse(readFileSync(join(TMP, 'config.json'), 'utf-8')) as {
      sentinel?: { preserved?: boolean }
      llmBackends?: Array<{ name: string }>
      mcpServers?: Array<{ name: string }>
    }
    expect(stored.sentinel?.preserved).toBe(true)
    expect(stored.llmBackends?.map((item) => item.name)).toEqual(['concurrent-llm'])
    expect(stored.mcpServers?.map((item) => item.name).sort()).toEqual(['mcp-a', 'mcp-b'])
    expect(readdirSync(TMP).filter((name) => name.includes('.lock') || name.endsWith('.tmp'))).toEqual([])
  })
})
