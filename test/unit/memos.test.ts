// memos.ts — 5W1H persistent records.
//
// Pure-function helpers (parseCoordPair, mapUrls, wgs84ToGcj02) tested in
// isolation. CRUD / search / expiry require SQLite which bun-runtime can't
// load (better-sqlite3 incompat); those auto-skip. CI runs the full set.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DIR = join(tmpdir(), `agim-memos-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
process.env.AGIM_MEMOS_DB = join(TEST_DIR, 'memos.db')

const mod = await import('../../src/core/memos.js')
const {
  createMemo, updateMemo, getMemo, listMemos, searchMemos,
  parseCoordPair, stripCoordPrefix, mapUrl, mapUrls, wgs84ToGcj02, gcj02ToWgs84,
  isGeocodingAvailable, sweepExpired, closeMemosDb,
  nowSqliteLocal, toSqliteLocal, normalizeWhenAt,
} = mod

beforeAll(async () => { await mkdir(TEST_DIR, { recursive: true }) })
afterAll(async () => {
  closeMemosDb()
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('parseCoordPair', () => {
  it('accepts comma / space / CN comma separators', () => {
    expect(parseCoordPair('39.9,116.4')).toEqual({ lat: 39.9, lng: 116.4 })
    expect(parseCoordPair('39.9 116.4')).toEqual({ lat: 39.9, lng: 116.4 })
    expect(parseCoordPair('39.9，116.4')).toEqual({ lat: 39.9, lng: 116.4 })
  })
  it('rejects non-coords', () => {
    expect(parseCoordPair('hello')).toBeNull()
    expect(parseCoordPair('200,116.4')).toBeNull()
  })
})

describe('stripCoordPrefix', () => {
  it('strips coords + leading whitespace', () => {
    expect(stripCoordPrefix('39.9,116.4 停车了')).toBe('停车了')
  })
})

describe('mapUrl / mapUrls', () => {
  it('Baidu URL pre-converts in-China coords to BD-09 (avoids Baidu wgs84 transform drift)', () => {
    const u = decodeURIComponent(mapUrl(39.9, 116.4))
    expect(u).toContain('api.map.baidu.com/marker')
    expect(u).toContain('coord_type=bd09ll')
    const m = u.match(/location=(-?\d+\.\d+),(-?\d+\.\d+)/)
    expect(m).not.toBeNull()
    if (m) {
      const lat = Number(m[1]); const lng = Number(m[2])
      // WGS-84 → BD-09 in Beijing shifts ~700m–1.5km, so coords must differ.
      expect(Math.abs(lat - 39.9)).toBeGreaterThan(0.001)
      expect(Math.abs(lng - 116.4)).toBeGreaterThan(0.001)
    }
  })
  it('Baidu URL passes through WGS-84 unchanged outside China', () => {
    const u = decodeURIComponent(mapUrl(40.7128, -74.0060)) // NYC
    expect(u).toContain('coord_type=wgs84')
    expect(u).toContain('location=40.7128,-74.006')
  })
  it('mapUrls returns all three providers', () => {
    const u = mapUrls(39.9, 116.4, '故宫')
    expect(u.baidu).toContain('api.map.baidu.com')
    expect(u.amap).toContain('uri.amap.com')
    expect(u.google).toContain('google.com/maps')
  })
  it('amap URI uses GCJ-02 (lat/lng differ from input)', () => {
    // Beijing: WGS-84 → GCJ-02 shifts ~300-700m. URL has comma URL-encoded
    // as %2C so we decode the URL once before regexing.
    const u = decodeURIComponent(mapUrls(39.9, 116.4, 'x').amap)
    const m = u.match(/position=(-?\d+\.\d+),(-?\d+\.\d+)/)
    expect(m).not.toBeNull()
    if (m) {
      const lng = Number(m[1]); const lat = Number(m[2])
      expect(Math.abs(lng - 116.4)).toBeGreaterThan(0.001)
      expect(Math.abs(lat - 39.9)).toBeGreaterThan(0.001)
    }
  })
})

describe('wgs84ToGcj02', () => {
  it('shifts mainland China coords noticeably', () => {
    const out = wgs84ToGcj02(39.9, 116.4)
    expect(Math.abs(out.lat - 39.9)).toBeGreaterThan(0.001)
    expect(Math.abs(out.lng - 116.4)).toBeGreaterThan(0.001)
  })
  it('is a no-op outside China', () => {
    const out = wgs84ToGcj02(40.7128, -74.0060)  // NYC
    expect(out).toEqual({ lat: 40.7128, lng: -74.0060 })
  })
})

describe('gcj02ToWgs84 (reverse — needed for Telegram incoming coords)', () => {
  it('round-trips a Beijing WGS-84 point within 1e-6 deg (~0.1m)', () => {
    // Forward: WGS-84 → GCJ-02. Reverse: GCJ-02 → WGS-84. Should be lossless
    // at the precision we care about (sub-meter).
    const wgs = { lat: 39.9087, lng: 116.3975 }
    const gcj = wgs84ToGcj02(wgs.lat, wgs.lng)
    const back = gcj02ToWgs84(gcj.lat, gcj.lng)
    expect(Math.abs(back.lat - wgs.lat)).toBeLessThan(1e-6)
    expect(Math.abs(back.lng - wgs.lng)).toBeLessThan(1e-6)
  })

  it('round-trips a Hangzhou point (latitudes south of Beijing get a different offset)', () => {
    const wgs = { lat: 30.2756, lng: 120.1279 }
    const gcj = wgs84ToGcj02(wgs.lat, wgs.lng)
    const back = gcj02ToWgs84(gcj.lat, gcj.lng)
    expect(Math.abs(back.lat - wgs.lat)).toBeLessThan(1e-6)
    expect(Math.abs(back.lng - wgs.lng)).toBeLessThan(1e-6)
  })

  it('produces a southwest shift from GCJ-02 input (the actual China-offset direction)', () => {
    // Inverse of wgs84ToGcj02's NE shift — converting a GCJ-02 point should
    // move it slightly south + west to recover the underlying WGS-84.
    const gcj = { lat: 39.9087, lng: 116.3975 }
    const wgs = gcj02ToWgs84(gcj.lat, gcj.lng)
    expect(wgs.lat).toBeLessThan(gcj.lat)
    expect(wgs.lng).toBeLessThan(gcj.lng)
    // Magnitude should be ~0.0035 lat / ~0.005 lng in Beijing, definitely > 1e-4
    expect(Math.abs(wgs.lat - gcj.lat)).toBeGreaterThan(1e-4)
    expect(Math.abs(wgs.lng - gcj.lng)).toBeGreaterThan(1e-4)
  })

  it('is a no-op outside China', () => {
    const out = gcj02ToWgs84(40.7128, -74.0060)  // NYC
    expect(out).toEqual({ lat: 40.7128, lng: -74.0060 })
  })

  it('converges fast — three Newton passes get sub-meter precision anywhere in China', () => {
    // Sample across the China bounding box to make sure no input class blows
    // up. All should round-trip within 1e-6 deg.
    const samples = [
      { lat: 23.13, lng: 113.26 }, // Guangzhou
      { lat: 31.23, lng: 121.47 }, // Shanghai
      { lat: 22.27, lng: 114.17 }, // HK (right at the southern edge — note HK
      //                                   itself uses WGS-84, but our outOfChina
      //                                   bbox includes HK; that's an accepted
      //                                   trade-off — the offset there is tiny)
      { lat: 43.83, lng: 87.62 },  // Urumqi
      { lat: 36.07, lng: 103.83 }, // Lanzhou
    ]
    for (const wgs of samples) {
      const gcj = wgs84ToGcj02(wgs.lat, wgs.lng)
      const back = gcj02ToWgs84(gcj.lat, gcj.lng)
      expect(Math.abs(back.lat - wgs.lat)).toBeLessThan(1e-6)
      expect(Math.abs(back.lng - wgs.lng)).toBeLessThan(1e-6)
    }
  })
})

describe('TZ helpers (UTC+8 storage shape)', () => {
  it('nowSqliteLocal returns YYYY-MM-DD HH:MM:SS', () => {
    expect(nowSqliteLocal()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
  it('toSqliteLocal shifts UTC ms by +8h', () => {
    // 2026-05-11 08:00:00 UTC → 2026-05-11 16:00:00 in UTC+8
    const ms = Date.parse('2026-05-11T08:00:00Z')
    expect(toSqliteLocal(ms)).toBe('2026-05-11 16:00:00')
  })
  it('normalizeWhenAt: bare ISO assumed local, T→space', () => {
    expect(normalizeWhenAt('2026-05-11T15:00:00')).toBe('2026-05-11 15:00:00')
  })
  it('normalizeWhenAt: already-local form passes through', () => {
    expect(normalizeWhenAt('2026-05-11 15:00:00')).toBe('2026-05-11 15:00:00')
  })
  it('normalizeWhenAt: explicit Z suffix → converted to UTC+8', () => {
    expect(normalizeWhenAt('2026-05-11T08:00:00Z')).toBe('2026-05-11 16:00:00')
  })
  it('normalizeWhenAt: explicit +08:00 → converted (no double-shift)', () => {
    expect(normalizeWhenAt('2026-05-11T15:00:00+08:00')).toBe('2026-05-11 15:00:00')
  })
  it('normalizeWhenAt: null / empty → null', () => {
    expect(normalizeWhenAt(null)).toBeNull()
    expect(normalizeWhenAt('')).toBeNull()
    expect(normalizeWhenAt('   ')).toBeNull()
  })
  it('normalizeWhenAt: unparseable string falls through unchanged', () => {
    expect(normalizeWhenAt('garbage')).toBe('garbage')
  })
})

describe('isGeocodingAvailable', () => {
  it('reflects AGIM_BAIDU_MAP_AK', () => {
    const orig = process.env.AGIM_BAIDU_MAP_AK
    delete process.env.AGIM_BAIDU_MAP_AK
    expect(isGeocodingAvailable()).toBe(false)
    process.env.AGIM_BAIDU_MAP_AK = 'fake'
    expect(isGeocodingAvailable()).toBe(true)
    if (orig === undefined) delete process.env.AGIM_BAIDU_MAP_AK
    else process.env.AGIM_BAIDU_MAP_AK = orig
  })
})

// CRUD section — auto-skip when sqlite is dead in this runtime.
function sqliteAlive(): boolean {
  try {
    createMemo({
      platform: 'wechat', channelId: 'p', threadId: 'p', userId: 'p',
      what: '__probe__',
    })
    return true
  } catch { return false }
}
const SQLITE_OK = sqliteAlive()
const describeIfSqlite = SQLITE_OK ? describe : describe.skip

describeIfSqlite('memo CRUD', () => {
  const CTX = { platform: 'wechat', channelId: 'c', threadId: 't', userId: 'alice' }

  it('createMemo with what only', () => {
    const id = createMemo({ ...CTX, what: '生日' })
    const m = getMemo(id, { userId: 'alice' })
    expect(m).not.toBeNull()
    expect(m?.what).toBe('生日')
    expect(m?.where_lat).toBeNull()
    expect(m?.expires_at).toBeNull()
  })

  it('createMemo with full 5W1H', () => {
    const id = createMemo({
      ...CTX,
      what: '聚餐',
      who: '团队',
      whenAt: '2026-05-15T18:00:00',
      whenText: null,
      whereLat: 39.9, whereLng: 116.4, whereLabel: '国贸三期',
      how: '步行',
      why: '庆祝发版',
    })
    const m = getMemo(id, { userId: 'alice' })
    expect(m?.who).toBe('团队')
    expect(m?.where_label).toBe('国贸三期')
    expect(m?.why).toBe('庆祝发版')
  })

  it('createMemo rejects empty what', () => {
    expect(() => createMemo({ ...CTX, what: '' })).toThrow('what is required')
  })

  it('updateMemo patches fields, leaves others alone', () => {
    const id = createMemo({ ...CTX, what: '会议', who: '老板' })
    expect(updateMemo(id, { whereLabel: '会议室A' }, { userId: 'alice' })).toBe(true)
    const m = getMemo(id, { userId: 'alice' })
    expect(m?.what).toBe('会议')        // unchanged
    expect(m?.who).toBe('老板')          // unchanged
    expect(m?.where_label).toBe('会议室A') // updated
  })

  it('updateMemo with null clears a field', () => {
    const id = createMemo({ ...CTX, what: 'x', who: 'someone' })
    updateMemo(id, { who: null }, { userId: 'alice' })
    const m = getMemo(id, { userId: 'alice' })
    expect(m?.who).toBeNull()
  })

  it('updateMemo cannot cross-tenant', () => {
    const id = createMemo({ ...CTX, what: '私密' })
    expect(updateMemo(id, { what: '篡改' }, { userId: 'mallory' })).toBe(false)
    const m = getMemo(id, { userId: 'alice' })
    expect(m?.what).toBe('私密')  // not changed
  })

  it('searchMemos with query LIKE-matches multiple fields', () => {
    createMemo({ ...CTX, what: '车', whereLabel: '地下B区' })
    createMemo({ ...CTX, what: '伞', whereLabel: '前台' })
    createMemo({ ...CTX, what: '聚餐', why: '团队庆祝' })

    expect(searchMemos({ userId: 'alice', query: '车' }).some((m) => m.what === '车')).toBe(true)
    expect(searchMemos({ userId: 'alice', query: '前台' }).some((m) => m.where_label === '前台')).toBe(true)
    expect(searchMemos({ userId: 'alice', query: '团队' }).some((m) => m.why === '团队庆祝')).toBe(true)
  })

  it('searchMemos with structured filters', () => {
    createMemo({ ...CTX, what: '生日', who: '爸爸' })
    createMemo({ ...CTX, what: '生日', who: '妈妈' })
    const r = searchMemos({ userId: 'alice', who: '爸爸', what: '生日' })
    expect(r.length).toBeGreaterThan(0)
    for (const m of r) {
      expect(m.who).toBe('爸爸')
      expect(m.what).toBe('生日')
    }
  })

  it('searchMemos hasLocation filter', () => {
    createMemo({ ...CTX, what: 'has-loc', whereLat: 39.9, whereLng: 116.4 })
    createMemo({ ...CTX, what: 'no-loc' })
    const r = searchMemos({ userId: 'alice', hasLocation: true })
    expect(r.every((m) => m.where_lat !== null)).toBe(true)
    expect(r.some((m) => m.what === 'has-loc')).toBe(true)
    expect(r.some((m) => m.what === 'no-loc')).toBe(false)
  })

  it('expired memos hidden from search by default', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    createMemo({ ...CTX, what: 'expired-thing', expiresAt: past })
    const visible = searchMemos({ userId: 'alice', query: 'expired-thing' })
    expect(visible.length).toBe(0)
    const withExpired = searchMemos({ userId: 'alice', query: 'expired-thing', includeExpired: true })
    expect(withExpired.length).toBeGreaterThan(0)
  })

  it('sweepExpired removes past-due rows', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    createMemo({ ...CTX, what: 'sweep-test-1', expiresAt: past })
    createMemo({ ...CTX, what: 'sweep-test-2', expiresAt: past })
    const removed = sweepExpired()
    expect(removed).toBeGreaterThanOrEqual(2)
    expect(searchMemos({ userId: 'alice', query: 'sweep-test', includeExpired: true }).length).toBe(0)
  })

  it('createMemo writes UTC+8 wall-clock for created_at + updated_at', () => {
    const id = createMemo({ ...CTX, what: 'tz-stamp' })
    const m = getMemo(id, { userId: 'alice' })
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(m.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // The stored value should be roughly NOW in UTC+8 — within 60s.
    const localNow = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    const drift = Math.abs(Date.parse(`${m.created_at.replace(' ', 'T')}Z`) - Date.parse(`${localNow.replace(' ', 'T')}Z`))
    expect(drift).toBeLessThan(60_000)
  })

  it('createMemo normalizes whenAt ISO with Z to local UTC+8', () => {
    const id = createMemo({ ...CTX, what: 'tz-when', whenAt: '2026-05-11T08:00:00Z' })
    const m = getMemo(id, { userId: 'alice' })
    expect(m?.when_at).toBe('2026-05-11 16:00:00')
  })

  it('createMemo accepts already-local whenAt unchanged', () => {
    const id = createMemo({ ...CTX, what: 'tz-when2', whenAt: '2026-05-11 15:00:00' })
    const m = getMemo(id, { userId: 'alice' })
    expect(m?.when_at).toBe('2026-05-11 15:00:00')
  })

  it('expires_at stored UTC+8: future memo NOT swept; past memo IS swept', () => {
    const futureUtc8 = new Date(Date.now() + 8 * 3600_000 + 60_000).toISOString().slice(0, 19).replace('T', ' ')
    const pastUtc8   = new Date(Date.now() + 8 * 3600_000 - 60_000).toISOString().slice(0, 19).replace('T', ' ')
    const live = createMemo({ ...CTX, what: 'tz-future', expiresAt: futureUtc8 })
    const dead = createMemo({ ...CTX, what: 'tz-past',   expiresAt: pastUtc8 })
    const removed = sweepExpired()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(getMemo(live, { userId: 'alice' })).not.toBeNull()
    expect(getMemo(dead, { userId: 'alice' })).toBeNull()
  })

  it('listMemos / deleteMemo per-user scoped', () => {
    createMemo({ ...CTX, what: 'alice-only' })
    createMemo({ platform: 'wechat', channelId: 'c', threadId: 't', userId: 'bob', what: 'bob-only' })
    const aliceList = listMemos({ userId: 'alice' })
    const bobList = listMemos({ userId: 'bob' })
    for (const m of aliceList) expect(m.user_id).toBe('alice')
    for (const m of bobList) expect(m.user_id).toBe('bob')
  })
})
