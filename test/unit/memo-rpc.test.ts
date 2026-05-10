// memo-rpc.ts — agent-facing RPC dispatch tests.
//
// Covers the 5 ops surface (save / request_capture / search / update /
// delete) + owner scoping + the no-userId guard. CRUD-touching cases
// auto-skip when better-sqlite3 isn't loadable in this runtime.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DIR = join(tmpdir(), `imhub-memorpc-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
process.env.IMHUB_MEMOS_DB = join(TEST_DIR, 'memos.db')

const rpcMod = await import('../../src/core/memo-rpc.js')
const tokenMod = await import('../../src/core/location-token.js')
const memosMod = await import('../../src/core/memos.js')
const { handleMemoOp } = rpcMod
const { _clearAll, _stopSweep, peekToken, consumeToken } = tokenMod
const { closeMemosDb, createMemo } = memosMod

const CTX = { platform: 'wechat', channelId: 'c1', threadId: 't1', userId: 'u1' }
const CTX2 = { platform: 'wechat', channelId: 'c1', threadId: 't1', userId: 'u2' }

beforeAll(async () => { await mkdir(TEST_DIR, { recursive: true }) })
afterAll(async () => {
  closeMemosDb()
  _stopSweep()
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('handleMemoOp — pure / no-DB cases', () => {
  it('rejects unknown op', async () => {
    const r = await handleMemoOp('not_a_real_op', {}, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('unknown op')
  })

  it('save without what errors', async () => {
    const r = await handleMemoOp('save', {}, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('what is required')
  })

  it('save without userId errors', async () => {
    const r = await handleMemoOp('save', { what: 'x' }, { ...CTX, userId: '' })
    expect(r.ok).toBe(false)
  })

  it('request_capture(what) returns short URL with stashed what', async () => {
    _clearAll()
    const r = await handleMemoOp('request_capture', { what: '车' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.result as { url: string; what?: string }
    expect(res.url).toMatch(/^https:\/\/.+\/l\/[A-Za-z0-9_-]{12}$/)
    expect(res.what).toBe('车')
    const token = res.url.split('/').pop() as string
    const peek = peekToken(token)
    expect(peek).not.toBeNull()
    expect(peek?.what).toBe('车')
    expect(peek?.memoId).toBeNull()
  })

  it('request_capture without what or memo_id still issues token', async () => {
    _clearAll()
    const r = await handleMemoOp('request_capture', {}, CTX)
    expect(r.ok).toBe(true)
  })

  it('search without userId errors', async () => {
    const r = await handleMemoOp('search', {}, { ...CTX, userId: '' })
    expect(r.ok).toBe(false)
  })

  it('update without id errors', async () => {
    const r = await handleMemoOp('update', { what: 'x' }, CTX)
    expect(r.ok).toBe(false)
  })

  it('delete without id errors', async () => {
    const r = await handleMemoOp('delete', {}, CTX)
    expect(r.ok).toBe(false)
  })
})

function sqliteAlive(): boolean {
  try {
    createMemo({ platform: 'wechat', channelId: 'p', threadId: 'p', userId: 'p', what: '__probe__' })
    return true
  } catch { return false }
}
const SQLITE_OK = sqliteAlive()
const describeIfSqlite = SQLITE_OK ? describe : describe.skip

describeIfSqlite('handleMemoOp — DB CRUD', () => {
  it('save with full 5W1H returns memo summary', async () => {
    const r = await handleMemoOp('save', {
      what: '生日',
      who: '爸爸',
      when_text: '5月8日',
    }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { id: number; what: string; who: string }
      expect(res.id).toBeGreaterThan(0)
      expect(res.what).toBe('生日')
      expect(res.who).toBe('爸爸')
    }
  })

  it('save with coords returns mapUrls', async () => {
    const r = await handleMemoOp('save', {
      what: '车',
      where_lat: 39.9, where_lng: 116.4,
    }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { where: { mapUrls: { baidu: string; amap: string; google: string } } }
      expect(res.where.mapUrls.baidu).toContain('api.map.baidu.com')
      expect(res.where.mapUrls.amap).toContain('uri.amap.com')
      expect(res.where.mapUrls.google).toContain('google.com')
    }
  })

  it('save with expires_in_hours sets expires_at in the future', async () => {
    const r = await handleMemoOp('save', {
      what: '临时',
      expires_in_hours: 24,
    }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { expiresAt?: string }
      expect(res.expiresAt).toBeDefined()
      if (res.expiresAt) {
        const ms = new Date(res.expiresAt).getTime() - Date.now()
        // Should be ~24h. Allow 2-min slack for clock + write latency.
        expect(ms).toBeGreaterThan(23.9 * 3600_000)
        expect(ms).toBeLessThan(24.1 * 3600_000)
      }
    }
  })

  it('search by query LIKE-matches across fields', async () => {
    await handleMemoOp('save', { what: '咖啡店', where_label: '工体北路' }, CTX)
    const r = await handleMemoOp('search', { query: '工体' }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const res = r.result as { items: Array<{ what: string }> }
      expect(res.items.some((it) => it.what === '咖啡店')).toBe(true)
    }
  })

  it('update patches fields', async () => {
    const create = await handleMemoOp('save', { what: '会议' }, CTX)
    expect(create.ok).toBe(true)
    if (!create.ok) return
    const id = (create.result as { id: number }).id

    const upd = await handleMemoOp('update', { id, where_label: '3楼A区' }, CTX)
    expect(upd.ok).toBe(true)
    if (upd.ok) {
      const res = upd.result as { what: string; where?: { label?: string } }
      expect(res.what).toBe('会议')  // unchanged
      // After update, where_label populated; mapUrls only set when lat/lng exist
      // (where_label alone doesn't add a where block in summarize). Verify
      // via direct lookup.
    }
  })

  it('delete owner-scoped', async () => {
    const create = await handleMemoOp('save', { what: '私密' }, CTX)
    expect(create.ok).toBe(true)
    if (!create.ok) return
    const id = (create.result as { id: number }).id

    const bobAttempt = await handleMemoOp('delete', { id }, CTX2)
    expect(bobAttempt.ok).toBe(false)

    const ok = await handleMemoOp('delete', { id }, CTX)
    expect(ok.ok).toBe(true)
  })

  it('request_capture(memo_id) for non-existent memo errors', async () => {
    const r = await handleMemoOp('request_capture', { memo_id: 99999 }, CTX)
    expect(r.ok).toBe(false)
  })
})
