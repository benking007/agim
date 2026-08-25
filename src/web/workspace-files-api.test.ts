import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleWorkspaceFilesApi } from './workspace-files-api.js'
import { bindTokenModule } from './auth.js'
import { registry } from '../core/registry.js'
import type { AgentAdapter } from '../core/types.js'

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const chunks: Buffer[] = []
  const res = {
    statusCode: 200,
    body: '',
    writeHead(code: number) { this.statusCode = code; return this },
    setHeader() { return this },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.body = Buffer.concat(chunks).toString('utf8')
      return this
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: string }
}

function mockReq(method: string, url: string, body = '', auth?: string): IncomingMessage {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const req = {
    method,
    url,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      'x-forwarded-for': '203.0.113.9',
    },
    socket: { remoteAddress: '10.0.0.2' },
    on(ev: string, cb: (...a: unknown[]) => void) {
      if (!listeners[ev]) listeners[ev] = []
      listeners[ev].push(cb)
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

const stubAgent: AgentAdapter = {
  name: 'agim',
  aliases: [],
  async *sendPrompt() { yield '' },
  async isAvailable() { return true },
}

describe('workspace-files per-account cwd', () => {
  let tmpHome = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agim-ws-files-'))
    for (const k of ['AGIM_HOME', 'AGIM_WORKSPACES_ROOT', 'AGIM_WEB_AUTH', 'AGIM_TRUST_LOOPBACK', 'AGIM_AGIM_CWD']) {
      saved[k] = process.env[k]
    }
    process.env.AGIM_HOME = tmpHome
    process.env.AGIM_WORKSPACES_ROOT = join(tmpHome, 'workspaces')
    process.env.AGIM_WEB_AUTH = 'on'
    process.env.AGIM_TRUST_LOOPBACK = 'off'
    delete process.env.AGIM_AGIM_CWD
    if (!registry.listAgents().includes('agim')) {
      registry.registerAgent(stubAgent)
    }
  })

  afterEach(() => {
    bindTokenModule(null)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('PUT writes into users/<id>/<agent>/ for a member token', async () => {
    const tokenModule = await import('../core/access-token.js')
    bindTokenModule(tokenModule)
    const user = tokenModule.createToken('ws-member', { role: 'user', userId: 'usr_ws01' })

    const res = mockRes()
    const handled = await handleWorkspaceFilesApi(
      mockReq('PUT', '/api/workspace-files?agent=agim&path=NOTES.md', JSON.stringify({ content: 'hello-member' }), user.raw),
      res,
      new URL('http://localhost/api/workspace-files?agent=agim&path=NOTES.md'),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body) as { ok: boolean; path: string }
    expect(json.ok).toBe(true)
    expect(json.path).toBe('NOTES.md')

    const dirRes = mockRes()
    await handleWorkspaceFilesApi(
      mockReq('GET', '/api/workspace-files?agent=agim', '', user.raw),
      dirRes,
      new URL('http://localhost/api/workspace-files?agent=agim'),
    )
    expect(dirRes.statusCode).toBe(200)
    const listing = JSON.parse(dirRes.body) as { type: string; base: string; entries: Array<{ name: string }> }
    expect(listing.type).toBe('dir')
    expect(listing.base.replace(/\\/g, '/')).toContain('/users/usr_ws01/agim')
    expect(listing.entries.some((e) => e.name === 'NOTES.md')).toBe(true)
    expect(listing.entries.some((e) => e.name === 'AGENTS.md')).toBe(true)
    expect(listing.entries.some((e) => e.name === 'MEMORY.md')).toBe(true)
    expect(listing.entries.some((e) => e.name === 'PROJECTS')).toBe(true)
    expect(listing.entries.some((e) => e.name === 'SESSIONS')).toBe(true)

    const getRes = mockRes()
    await handleWorkspaceFilesApi(
      mockReq('GET', '/api/workspace-files?agent=agim&path=NOTES.md', '', user.raw),
      getRes,
      new URL('http://localhost/api/workspace-files?agent=agim&path=NOTES.md'),
    )
    expect(getRes.statusCode).toBe(200)
    const file = JSON.parse(getRes.body) as { content: string }
    expect(file.content).toBe('hello-member')
  })
})
