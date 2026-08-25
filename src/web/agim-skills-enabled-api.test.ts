import { describe, it, expect, beforeEach } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'agim-skills-en-api-'))
const WS_OWN = mkdtempSync(join(tmpdir(), 'agim-skills-en-ws-'))
const BUILTIN_OWN = mkdtempSync(join(tmpdir(), 'agim-skills-en-bi-'))
process.env.AGIM_HOME = HOME
process.env.AGIM_SKILLS_WORKSPACE_DIR = WS_OWN
process.env.AGIM_SKILLS_BUILTIN_DIR = BUILTIN_OWN
process.env.AGIM_SKILLS_MODE = 'agim-only'

const { handleAgimSkillsApi } = await import('./agim-skills-api.js')
const { invalidateSkillsCache, buildSkillsSummary } = await import('../core/skills/loader.js')

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(k: string, v: string): void
  end(b: string): void
}
type FakeReq = EventEmitter & {
  method: string
  headers: Record<string, string | undefined>
  socket: { remoteAddress?: string }
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>
}

function makeReq(method: string, body?: unknown): import('node:http').IncomingMessage {
  const ee = new EventEmitter() as FakeReq
  ee.method = method
  ee.headers = {}
  ee.socket = { remoteAddress: '127.0.0.1' }
  const raw = body === undefined ? null : JSON.stringify(body)
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

function writeSkill(name: string): void {
  const dir = join(WS_OWN, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---
name: ${name}
description: toggle me
---

body
`, 'utf-8')
}

beforeEach(() => {
  try { rmSync(WS_OWN, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(WS_OWN, { recursive: true })
  try { rmSync(join(HOME, 'skills-disabled.json'), { force: true }) } catch { /* ignore */ }
  invalidateSkillsCache()
})

describe('PATCH /api/agim-skills/:name/enabled', () => {
  it('persists the flag immediately and rebuilds injection off-path', async () => {
    writeSkill('toggle-me')
    invalidateSkillsCache()
    expect(buildSkillsSummary()).toContain('toggle-me')

    const res = makeRes()
    const handled = await handleAgimSkillsApi(
      makeReq('PATCH', { enabled: false }),
      asRes(res),
      url('/api/agim-skills/toggle-me/enabled'),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ name: 'toggle-me', enabled: false, rebuilding: true })

    const list = makeRes()
    await handleAgimSkillsApi(makeReq('GET'), asRes(list), url('/api/agim-skills'))
    const row = (JSON.parse(list.body) as { skills: Array<{ name: string; enabled: boolean }> })
      .skills.find((s) => s.name === 'toggle-me')
    expect(row?.enabled).toBe(false)

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(buildSkillsSummary()).not.toContain('toggle-me')
  })

  it('404s unknown names and 400s a missing enabled flag', async () => {
    const missing = makeRes()
    await handleAgimSkillsApi(
      makeReq('PATCH', { enabled: false }),
      asRes(missing),
      url('/api/agim-skills/nope/enabled'),
    )
    expect(missing.statusCode).toBe(404)

    writeSkill('ok')
    invalidateSkillsCache()
    const bad = makeRes()
    await handleAgimSkillsApi(
      makeReq('PATCH', {}),
      asRes(bad),
      url('/api/agim-skills/ok/enabled'),
    )
    expect(bad.statusCode).toBe(400)
  })
})
