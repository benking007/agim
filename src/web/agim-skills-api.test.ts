// Unit tests for the P1 agim-skills editor REST.

import { describe, it, expect, beforeEach } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WS_OWN = mkdtempSync(join(tmpdir(), 'agim-skills-ws-'))
const BUILTIN_OWN = mkdtempSync(join(tmpdir(), 'agim-skills-builtin-'))
process.env.IMHUB_SKILLS_WORKSPACE_DIR = WS_OWN
process.env.IMHUB_SKILLS_BUILTIN_DIR = BUILTIN_OWN
// v1.2.48 multi-root scan (auto mode) inherits ~/.claude/skills etc. which
// breaks the per-test 'fresh install → count=0' fixture on dev boxes with
// CLI agents installed. Pin to agim-only so we only see WS_OWN + BUILTIN_OWN.
process.env.IMHUB_SKILLS_MODE = 'agim-only'

const { handleAgimSkillsApi } = await import('./agim-skills-api.js')
const { invalidateSkillsCache } = await import('../core/skills/loader.js')

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
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { r.headers[k] = v },
    end(b) { r.body = b },
  }
  return r
}

function url(path: string): URL { return new URL(`http://localhost${path}`) }
function asRes(r: MockRes): import('node:http').ServerResponse {
  return r as unknown as import('node:http').ServerResponse
}

beforeEach(() => {
  try { rmSync(WS_OWN, { recursive: true, force: true }) } catch {}
  mkdirSync(WS_OWN, { recursive: true })
  invalidateSkillsCache()
})

describe('agim-skills API — list + refresh', () => {
  it('returns empty list on fresh install', async () => {
    const res = makeRes()
    const handled = await handleAgimSkillsApi(makeReq('GET'), asRes(res), url('/api/agim-skills'))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ count: 0, skills: [] })
  })

  it('refresh endpoint returns the new count', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('POST'), asRes(res), url('/api/agim-skills/refresh'))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ count: 0 })
  })
})

describe('agim-skills API — create (POST)', () => {
  it('rejects missing body { name, body }', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('POST', {}), asRes(res), url('/api/agim-skills'))
    expect(res.statusCode).toBe(400)
  })

  it('rejects bad name (unsafe chars)', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('POST', {
      name: '../etc/passwd',
      body: '---\nname: x\ndescription: y\n---\nbody',
    }), asRes(res), url('/api/agim-skills'))
    expect(res.statusCode).toBe(400)
  })

  it('rejects missing frontmatter', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('POST', {
      name: 'no-front',
      body: 'no frontmatter at all',
    }), asRes(res), url('/api/agim-skills'))
    expect(res.statusCode).toBe(400)
  })

  it('happy path persists + returns the meta', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('POST', {
      name: 'demo',
      body: '---\nname: demo\ndescription: a tiny demo\n---\nbody here',
    }), asRes(res), url('/api/agim-skills'))
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.meta.name).toBe('demo')
    expect(body.meta.source).toBe('workspace')
  })

  it('refuses duplicate name', async () => {
    await handleAgimSkillsApi(makeReq('POST', {
      name: 'dup',
      body: '---\nname: dup\ndescription: x\n---\nbody',
    }), asRes(makeRes()), url('/api/agim-skills'))
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('POST', {
      name: 'dup',
      body: '---\nname: dup\ndescription: y\n---\nbody',
    }), asRes(res), url('/api/agim-skills'))
    expect(res.statusCode).toBe(409)
  })
})

describe('agim-skills API — get / update / delete', () => {
  beforeEach(async () => {
    await handleAgimSkillsApi(makeReq('POST', {
      name: 'mine',
      body: '---\nname: mine\ndescription: first\n---\nbody v1',
    }), asRes(makeRes()), url('/api/agim-skills'))
  })

  it('GET /:name returns meta + body', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('GET'), asRes(res), url('/api/agim-skills/mine'))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.meta.name).toBe('mine')
    expect(body.body).toContain('body v1')
  })

  it('GET /:name returns 404 when unknown', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('GET'), asRes(res), url('/api/agim-skills/never'))
    expect(res.statusCode).toBe(404)
  })

  it('PUT /:name updates the body', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('PUT', {
      body: '---\nname: mine\ndescription: updated\n---\nbody v2',
    }), asRes(res), url('/api/agim-skills/mine'))
    expect(res.statusCode).toBe(200)
    // Verify the body actually changed via a follow-up GET.
    const getRes = makeRes()
    await handleAgimSkillsApi(makeReq('GET'), asRes(getRes), url('/api/agim-skills/mine'))
    expect(getRes.body).toContain('body v2')
  })

  it('PUT /:name returns 404 for unknown name', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('PUT', { body: '---\nname: x\ndescription: y\n---\n' }),
      asRes(res), url('/api/agim-skills/never'))
    expect(res.statusCode).toBe(404)
  })

  it('DELETE /:name removes the workspace skill', async () => {
    const res = makeRes()
    await handleAgimSkillsApi(makeReq('DELETE'), asRes(res), url('/api/agim-skills/mine'))
    expect(res.statusCode).toBe(200)
    const getRes = makeRes()
    await handleAgimSkillsApi(makeReq('GET'), asRes(getRes), url('/api/agim-skills/mine'))
    expect(getRes.statusCode).toBe(404)
  })
})

describe('agim-skills API — routing', () => {
  it('returns false for unmatched URL', async () => {
    const res = makeRes()
    const handled = await handleAgimSkillsApi(makeReq('GET'), asRes(res), url('/api/agim-skillsx'))
    expect(handled).toBe(false)
  })
})
