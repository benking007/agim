import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetAccountsCache } from '../core/accounts-store.js'
import { handleAccountApi } from './account-api.js'

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
let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agim-price-api-'))
  saved.AGIM_HOME = process.env.AGIM_HOME
  saved.AGIM_WEB_AUTH = process.env.AGIM_WEB_AUTH
  process.env.AGIM_HOME = tmp
  process.env.AGIM_WEB_AUTH = 'off'
  _resetAccountsCache()
})

afterEach(() => {
  _resetAccountsCache()
  if (saved.AGIM_HOME === undefined) delete process.env.AGIM_HOME
  else process.env.AGIM_HOME = saved.AGIM_HOME
  if (saved.AGIM_WEB_AUTH === undefined) delete process.env.AGIM_WEB_AUTH
  else process.env.AGIM_WEB_AUTH = saved.AGIM_WEB_AUTH
  rmSync(tmp, { recursive: true, force: true })
})

describe('/api/admin/model-prices', () => {
  it('lists LLM and CLI presets for an admin', async () => {
    const req = makeReq('GET')
    const res = makeRes()
    const handled = await handleAccountApi(req, res as unknown as import('node:http').ServerResponse, url('/api/admin/model-prices'))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { ok: boolean; rows: Array<{ id: string; source: string }> }
    expect(body.ok).toBe(true)
    const ids = body.rows.map((r) => r.id)
    expect(ids).toContain('deepseek-v4-flash-vision-exp')
    expect(ids).toContain('cursor')
    expect(body.rows.find((r) => r.id === 'deepseek-v4-flash-vision-exp')?.source).toBe('preset')
  })

  it('saves an override and can restore the preset', async () => {
    const putReq = makeReq('PUT', {
      overrides: { 'llm:deepseek-v4-flash-vision-exp': { costPer1kIn: 0.001, costPer1kOut: 0.002 } },
    })
    const putRes = makeRes()
    await handleAccountApi(putReq, putRes as unknown as import('node:http').ServerResponse, url('/api/admin/model-prices'))
    expect(putRes.statusCode).toBe(200)
    const afterPut = JSON.parse(putRes.body) as { rows: Array<{ id: string; source: string; current: { costPer1kIn: number } }> }
    expect(afterPut.rows.find((r) => r.id === 'deepseek-v4-flash-vision-exp')?.source).toBe('override')
    expect(afterPut.rows.find((r) => r.id === 'deepseek-v4-flash-vision-exp')?.current.costPer1kIn).toBeCloseTo(0.001)

    const resetReq = makeReq('PUT', { overrides: { 'llm:deepseek-v4-flash-vision-exp': null } })
    const resetRes = makeRes()
    await handleAccountApi(resetReq, resetRes as unknown as import('node:http').ServerResponse, url('/api/admin/model-prices'))
    const afterReset = JSON.parse(resetRes.body) as { rows: Array<{ id: string; source: string }> }
    expect(afterReset.rows.find((r) => r.id === 'deepseek-v4-flash-vision-exp')?.source).toBe('preset')
  })

  it('rejects a non-object overrides payload', async () => {
    const req = makeReq('PUT', { overrides: [1, 2] })
    const res = makeRes()
    await handleAccountApi(req, res as unknown as import('node:http').ServerResponse, url('/api/admin/model-prices'))
    expect(res.statusCode).toBe(400)
  })
})
