/**
 * GET /api/jobs/:id — chat users may read Subagent jobs on their web thread.
 * Skips when better-sqlite3 is unavailable (Bun job-board path).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleJobsApi } from '../../src/web/jobs-api.js'
import { bindTokenModule } from '../../src/web/auth.js'
import { webThreadOwners } from '../../src/core/web-thread-owners.js'

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

describe('GET /api/jobs/:id chat-user Subagent read', () => {
  let tmpHome = ''
  const saved: Record<string, string | undefined> = {}
  const threadId = 'web-jobAuthTest01'

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agim-jobs-auth-'))
    for (const k of ['AGIM_HOME', 'AGIM_WEB_AUTH', 'AGIM_TRUST_LOOPBACK']) {
      saved[k] = process.env[k]
    }
    process.env.AGIM_HOME = tmpHome
    process.env.AGIM_WEB_AUTH = 'on'
    process.env.AGIM_TRUST_LOOPBACK = 'off'
  })

  afterEach(() => {
    bindTokenModule(null)
    webThreadOwners.delete(threadId)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('lets role=user read a job on their owned web thread', async () => {
    const { createInlineJob, getJob } = await import('../../src/core/job-board.js')
    const id = createInlineJob({
      agent: 'agim',
      prompt: 'Subagent brief',
      threadKey: `web:web:${threadId}`,
      creatorId: `web:${threadId}`,
    })
    if (!(typeof id === 'number' && id > 0 && getJob(id))) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
        throw new Error('expected createInlineJob to persist under Node sqlite suite')
      }
      // Bun cannot load better-sqlite3 — exercised under npm run test:sqlite.
      return
    }

    const tokenModule = await import('../../src/core/access-token.js')
    bindTokenModule(tokenModule)
    const user = tokenModule.createToken('chat-user', { role: 'user' })
    webThreadOwners.set(threadId, user.id)

    const req = {
      method: 'GET',
      url: `/api/jobs/${id}?threadId=${threadId}`,
      headers: {
        authorization: `Bearer ${user.raw}`,
        'x-forwarded-for': '203.0.113.9',
      },
      socket: { remoteAddress: '10.0.0.2' },
    } as unknown as IncomingMessage
    const res = mockRes()
    const url = new URL(`http://localhost/api/jobs/${id}?threadId=${encodeURIComponent(threadId)}`)
    expect(await handleJobsApi(req, res, url)).toBe(true)
    if (res.statusCode !== 200) {
      throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`)
    }
    const body = JSON.parse(res.body) as { job?: { id: number; prompt: string; threadKey?: string } }
    expect(body.job?.id).toBe(id)
    expect(body.job?.prompt).toContain('Subagent brief')
  })

  it('denies role=user without matching threadId', async () => {
    const { createInlineJob, getJob } = await import('../../src/core/job-board.js')
    const id = createInlineJob({
      agent: 'agim',
      prompt: 'secret',
      threadKey: `web:web:${threadId}`,
      creatorId: `web:${threadId}`,
    })
    if (!(typeof id === 'number' && id > 0 && getJob(id))) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
        throw new Error('expected createInlineJob to persist under Node sqlite suite')
      }
      return
    }

    const tokenModule = await import('../../src/core/access-token.js')
    bindTokenModule(tokenModule)
    const user = tokenModule.createToken('chat-user-2', { role: 'user' })

    const req = {
      method: 'GET',
      url: `/api/jobs/${id}`,
      headers: {
        authorization: `Bearer ${user.raw}`,
        'x-forwarded-for': '203.0.113.9',
      },
      socket: { remoteAddress: '10.0.0.2' },
    } as unknown as IncomingMessage
    const res = mockRes()
    const url = new URL(`http://localhost/api/jobs/${id}`)
    expect(await handleJobsApi(req, res, url)).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatch(/admin role required/)
  })
})
