import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleEnvApi } from './env-api.js'

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const chunks: Buffer[] = []
  const res = {
    statusCode: 200,
    body: '',
    writeHead(code: number) { this.statusCode = code },
    end(data?: string | Buffer) {
      if (data != null) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
      this.body = Buffer.concat(chunks).toString('utf8')
    },
    setHeader() { /* noop */ },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: string }
}

function mockReq(method: string, body = ''): IncomingMessage {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const req = {
    method,
    headers: {},
    url: '/api/policy/auto-approve',
    on(ev: string, cb: (...a: unknown[]) => void) {
      ;(listeners[ev] ??= []).push(cb)
      if (ev === 'data') {
        queueMicrotask(() => {
          if (body) cb(Buffer.from(body))
          for (const end of listeners.end ?? []) end()
        })
      }
      return req
    },
  }
  return req as unknown as IncomingMessage
}

describe('/api/policy/auto-approve', () => {
  const prevApprove = process.env.AGIM_AUTO_APPROVE

  beforeEach(() => {
    process.env.AGIM_AUTO_APPROVE = '0'
  })

  afterEach(() => {
    if (prevApprove === undefined) delete process.env.AGIM_AUTO_APPROVE
    else process.env.AGIM_AUTO_APPROVE = prevApprove
  })

  it('GET returns enabled=false by default', async () => {
    const res = mockRes()
    const ok = await handleEnvApi(
      mockReq('GET'),
      res,
      new URL('http://localhost/api/policy/auto-approve'),
    )
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body) as { enabled: boolean }
    expect(json.enabled).toBe(false)
  })

  it('PUT enabled=true hot-sets AGIM_AUTO_APPROVE=1', async () => {
    const res = mockRes()
    const ok = await handleEnvApi(
      mockReq('PUT', JSON.stringify({ enabled: true })),
      res,
      new URL('http://localhost/api/policy/auto-approve'),
    )
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body) as { enabled: boolean; ok: boolean }
    expect(json.ok).toBe(true)
    expect(json.enabled).toBe(true)
    expect(process.env.AGIM_AUTO_APPROVE).toBe('1')
  })

  it('PUT enabled=false restores request-approval mode', async () => {
    process.env.AGIM_AUTO_APPROVE = '1'
    const res = mockRes()
    const ok = await handleEnvApi(
      mockReq('PUT', JSON.stringify({ enabled: false })),
      res,
      new URL('http://localhost/api/policy/auto-approve'),
    )
    expect(ok).toBe(true)
    const json = JSON.parse(res.body) as { enabled: boolean }
    expect(json.enabled).toBe(false)
    expect(process.env.AGIM_AUTO_APPROVE).toBe('0')
  })
})
