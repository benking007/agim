import { afterEach, describe, expect, it } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleWorkspaceCwdApi } from './workspace-cwd-api.js'

const prevRoot = process.env.AGIM_WORKSPACES_ROOT

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

function mockReq(method: string, body: unknown): IncomingMessage {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const req = {
    method,
    headers: {},
    url: '/api/workspace-resolve',
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
  return req as unknown as IncomingMessage
}

afterEach(() => {
  if (prevRoot === undefined) delete process.env.AGIM_WORKSPACES_ROOT
  else process.env.AGIM_WORKSPACES_ROOT = prevRoot
})

describe('POST /api/workspace-resolve', () => {
  it('resolves a subdirectory under the agent workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agim-ws-api-'))
    process.env.AGIM_WORKSPACES_ROOT = root
    const child = join(root, 'agim', 'proj')
    mkdirSync(child, { recursive: true })
    try {
      const res = mockRes()
      const handled = await handleWorkspaceCwdApi(
        mockReq('POST', { agent: 'agim', path: 'proj' }),
        res,
        new URL('http://localhost/api/workspace-resolve'),
      )
      expect(handled).toBe(true)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        path: realpathSync(child),
        name: 'proj',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects the workspace root and paths outside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agim-ws-api-'))
    process.env.AGIM_WORKSPACES_ROOT = root
    mkdirSync(join(root, 'agim'), { recursive: true })
    try {
      const rootRes = mockRes()
      await handleWorkspaceCwdApi(
        mockReq('POST', { agent: 'agim', path: '.' }),
        rootRes,
        new URL('http://localhost/api/workspace-resolve'),
      )
      expect(JSON.parse(rootRes.body)).toEqual({ ok: false, path: null })

      const outRes = mockRes()
      await handleWorkspaceCwdApi(
        mockReq('POST', { agent: 'agim', path: '/etc' }),
        outRes,
        new URL('http://localhost/api/workspace-resolve'),
      )
      expect(JSON.parse(outRes.body)).toEqual({ ok: false, path: null })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires an agent name', async () => {
    const res = mockRes()
    await handleWorkspaceCwdApi(
      mockReq('POST', { path: 'proj' }),
      res,
      new URL('http://localhost/api/workspace-resolve'),
    )
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing agent' })
  })
})
