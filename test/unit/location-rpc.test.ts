// location-rpc.ts — agent-facing RPC dispatch tests.
//
// Covers the four ops surface (request_capture / save / list / delete) +
// owner scoping + the no-userId guard. CRUD-touching cases auto-skip when
// better-sqlite3 isn't loadable (bun dev env); CI runs them in real Node.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DIR = join(tmpdir(), `imhub-locrpc-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
process.env.IMHUB_LOCATIONS_DB = join(TEST_DIR, 'locations.db')

const rpcMod = await import('../../src/core/location-rpc.js')
const tokenMod = await import('../../src/core/location-token.js')
const locMod = await import('../../src/core/locations.js')
const { handleLocationOp } = rpcMod
const { _clearAll, _stopSweep, peekToken, consumeToken } = tokenMod
const { closeLocationsDb, createMemo } = locMod

const CTX = { platform: 'wechat', channelId: 'c1', threadId: 't1', userId: 'u1' }
const CTX2 = { platform: 'wechat', channelId: 'c1', threadId: 't1', userId: 'u2' }

beforeAll(async () => { await mkdir(TEST_DIR, { recursive: true }) })
afterAll(async () => {
  closeLocationsDb()
  _stopSweep()
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('handleLocationOp — pure / no-DB cases', () => {
  it('rejects unknown op', async () => {
    const r = await handleLocationOp('not_a_real_op', {}, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('unknown op')
  })

  it('request_capture returns a URL with embedded token', async () => {
    _clearAll()
    const r = await handleLocationOp('request_capture', { note: '车' }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { url: string; ttlSeconds: number; note: string }
      // Short path /l/<token>; token is base64url (9 bytes → 12 chars).
      expect(res.url).toMatch(/^https:\/\/.+\/l\/[A-Za-z0-9_-]{12}$/)
      expect(res.ttlSeconds).toBe(600)
      expect(res.note).toBe('车')
    }
  })

  it('request_capture stashes note for later peek/consume', async () => {
    _clearAll()
    const r = await handleLocationOp('request_capture', { note: '伞' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const url = (r.result as { url: string }).url
    // New URL shape: /l/<token>. Extract trailing path component.
    const token = url.split('/').pop() as string
    const peek = peekToken(token)
    expect(peek).not.toBeNull()
    expect(peek?.note).toBe('伞')
    expect(peek?.ctx.userId).toBe('u1')
    // peek does NOT consume — token still alive
    const peek2 = peekToken(token)
    expect(peek2).not.toBeNull()
    // consume drops it
    const consumed = consumeToken(token)
    expect(consumed.ok).toBe(true)
    if (consumed.ok) expect(consumed.note).toBe('伞')
  })

  it('request_capture trims oversized notes to 80 chars', async () => {
    _clearAll()
    const longNote = 'x'.repeat(200)
    const r = await handleLocationOp('request_capture', { note: longNote }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { note: string }
      expect(res.note.length).toBe(80)
    }
  })

  it('request_capture without userId in ctx errors', async () => {
    const r = await handleLocationOp('request_capture', {}, { ...CTX, userId: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('userId')
  })

  it('save without lat/lng or address errors', async () => {
    const r = await handleLocationOp('save', {}, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('lat+lng or address')
  })

  it('list without userId in ctx errors', async () => {
    const r = await handleLocationOp('list', {}, { ...CTX, userId: '' })
    expect(r.ok).toBe(false)
  })
})

// ─── DB-touching cases ────────────────────────────────────────────────
function sqliteAlive(): boolean {
  try {
    createMemo({
      platform: 'wechat', channelId: 'p', threadId: 'p', userId: 'p',
      lat: 0, lng: 0, note: '__probe__',
    })
    return true
  } catch { return false }
}
const SQLITE_OK = sqliteAlive()
const describeIfSqlite = SQLITE_OK ? describe : describe.skip

describeIfSqlite('handleLocationOp — DB CRUD', () => {
  it('save with coords creates a memo', async () => {
    const r = await handleLocationOp('save', {
      lat: 39.908, lng: 116.397, note: '故宫午门',
    }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { id: number; lat: number; label: string; mapUrl: string; source: string }
      expect(res.id).toBeGreaterThan(0)
      expect(res.lat).toBeCloseTo(39.908)
      expect(res.label).toBe('故宫午门')
      expect(res.source).toBe('manual')
      expect(res.mapUrl).toContain('api.map.baidu.com')
    }
  })

  it('save with no API key + address returns geocode error', async () => {
    const orig = process.env.IMHUB_BAIDU_MAP_AK
    delete process.env.IMHUB_BAIDU_MAP_AK
    try {
      const r = await handleLocationOp('save', { address: '北京天安门' }, CTX)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('not configured')
    } finally {
      if (orig !== undefined) process.env.IMHUB_BAIDU_MAP_AK = orig
    }
  })

  it('list without query returns recent memos for this user', async () => {
    await handleLocationOp('save', { lat: 1, lng: 1, note: 'A' }, CTX)
    await handleLocationOp('save', { lat: 2, lng: 2, note: 'B' }, CTX)
    const r = await handleLocationOp('list', { limit: 10 }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { items: Array<{ note: string; mapUrl: string }> }
      expect(res.items.length).toBeGreaterThanOrEqual(2)
      // Newest first; map URL on every item.
      for (const it of res.items) expect(it.mapUrl).toContain('api.map.baidu.com')
    }
  })

  it('list with query LIKE-matches label/note', async () => {
    await handleLocationOp('save', { lat: 5, lng: 5, note: '我的车' }, CTX)
    await handleLocationOp('save', { lat: 6, lng: 6, note: '我的伞' }, CTX)
    const r = await handleLocationOp('list', { query: '车' }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { items: Array<{ label: string; note: string }> }
      expect(res.items.length).toBeGreaterThanOrEqual(1)
      // Every match should mention 车 in label OR note.
      for (const it of res.items) {
        expect(`${it.label}${it.note}`).toContain('车')
      }
    }
  })

  it('list scopes per user', async () => {
    await handleLocationOp('save', { lat: 7, lng: 7, note: 'alice-only' }, CTX)
    await handleLocationOp('save', { lat: 8, lng: 8, note: 'bob-only' }, CTX2)
    const ra = await handleLocationOp('list', { query: 'alice-only' }, CTX2)
    expect(ra.ok).toBe(true)
    if (ra.ok) expect((ra.result as { items: unknown[] }).items.length).toBe(0)
  })

  it('delete by id returns ok + cannot cross users', async () => {
    const create = await handleLocationOp('save', { lat: 9, lng: 9, note: 'todelete' }, CTX)
    expect(create.ok).toBe(true)
    if (!create.ok) return
    const id = (create.result as { id: number }).id

    // bob can't delete alice's memo
    const bobAttempt = await handleLocationOp('delete', { id }, CTX2)
    expect(bobAttempt.ok).toBe(false)

    // alice can
    const ok = await handleLocationOp('delete', { id }, CTX)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect((ok.result as { deleted: boolean }).deleted).toBe(true)
  })
})
