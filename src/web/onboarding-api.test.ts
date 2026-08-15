import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const TMP = mkdtempSync(join(tmpdir(), 'agim-onboarding-api-'))
process.env.AGIM_HOME = TMP
process.env.AGIM_WEB_AUTH = 'off'

mock.module('../cli-ui/readiness.js', () => ({
  checkAgentsFresh: async () => ({ available: [], missing: ['claude-code'] }),
}))

const { handleOnboardingApi } = await import('./onboarding-api.js')
const { AGIM_HOME } = await import('../core/agim-paths.js')

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

beforeEach(() => {
  try { rmSync(AGIM_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(AGIM_HOME, { recursive: true })
})

describe('handleOnboardingApi', () => {
  it('GET /api/onboarding/status reports first-run on a fresh install', async () => {
    const res = makeRes()
    const handled = await handleOnboardingApi(
      makeReq('GET'),
      res as unknown as import('node:http').ServerResponse,
      url('/api/onboarding/status'),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { firstRun: boolean; reason: string; skipped: boolean }
    expect(body.firstRun).toBe(true)
    expect(body.reason).toBe('no-usable-agent')
    expect(body.skipped).toBe(false)
  })

  it('POST /api/onboarding/skip persists setupSkipped and clears firstRun', async () => {
    writeFileSync(join(AGIM_HOME, 'config.json'), JSON.stringify({
      messengers: [],
      agents: ['agim'],
      defaultAgent: 'agim',
    }))
    const skipRes = makeRes()
    const skipped = await handleOnboardingApi(
      makeReq('POST'),
      skipRes as unknown as import('node:http').ServerResponse,
      url('/api/onboarding/skip'),
    )
    expect(skipped).toBe(true)
    expect(skipRes.statusCode).toBe(200)
    const skipBody = JSON.parse(skipRes.body) as { firstRun: boolean; skipped: boolean }
    expect(skipBody.skipped).toBe(true)
    expect(skipBody.firstRun).toBe(false)

    const statusRes = makeRes()
    await handleOnboardingApi(
      makeReq('GET'),
      statusRes as unknown as import('node:http').ServerResponse,
      url('/api/onboarding/status'),
    )
    const status = JSON.parse(statusRes.body) as { firstRun: boolean; skipped: boolean }
    expect(status.skipped).toBe(true)
    expect(status.firstRun).toBe(false)
  })

  it('returns false for unrelated paths', async () => {
    const res = makeRes()
    const handled = await handleOnboardingApi(
      makeReq('GET'),
      res as unknown as import('node:http').ServerResponse,
      url('/api/llm'),
    )
    expect(handled).toBe(false)
  })
})
