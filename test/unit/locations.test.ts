// Locations unit tests — pure functions + DB CRUD via temp file.
//
// Strategy: temp DB per test file (env var IMHUB_LOCATIONS_DB), pure helpers
// (parseCoordPair, mapUrl) tested directly. geocodeAddress is NOT covered
// (network dependency); we just assert isGeocodingAvailable reflects env.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DIR = join(tmpdir(), `imhub-locations-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
const TEST_DB = join(TEST_DIR, 'locations.db')
process.env.IMHUB_LOCATIONS_DB = TEST_DB

const mod = await import('../../src/core/locations.js')
const {
  createMemo, listMemos, getMemo, deleteMemo,
  parseCoordPair, stripCoordPrefix, mapUrl, mapUrls, wgs84ToGcj02,
  isGeocodingAvailable, closeLocationsDb,
} = mod

beforeAll(async () => { await mkdir(TEST_DIR, { recursive: true }) })
afterAll(async () => {
  closeLocationsDb()
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('parseCoordPair', () => {
  it('accepts comma-separated', () => {
    expect(parseCoordPair('39.908,116.397')).toEqual({ lat: 39.908, lng: 116.397 })
  })
  it('accepts space-separated', () => {
    expect(parseCoordPair('39.908 116.397')).toEqual({ lat: 39.908, lng: 116.397 })
  })
  it('accepts CN comma', () => {
    expect(parseCoordPair('39.908，116.397')).toEqual({ lat: 39.908, lng: 116.397 })
  })
  it('accepts comma + space', () => {
    expect(parseCoordPair('39.908, 116.397')).toEqual({ lat: 39.908, lng: 116.397 })
  })
  it('accepts negative coords (southern hemisphere / americas)', () => {
    expect(parseCoordPair('-33.86,151.21')).toEqual({ lat: -33.86, lng: 151.21 })
    expect(parseCoordPair('40.71,-74.0')).toEqual({ lat: 40.71, lng: -74.0 })
  })
  it('rejects non-coord text', () => {
    expect(parseCoordPair('国贸三期')).toBeNull()
    expect(parseCoordPair('hello world')).toBeNull()
    expect(parseCoordPair('')).toBeNull()
  })
  it('rejects out-of-range values', () => {
    expect(parseCoordPair('200,116.397')).toBeNull() // lat > 90
    expect(parseCoordPair('39.908,200')).toBeNull()  // lng > 180
  })
  it('parses coords with trailing memo (memo not in result)', () => {
    expect(parseCoordPair('39.908,116.397 停车场B区')).toEqual({ lat: 39.908, lng: 116.397 })
  })
})

describe('stripCoordPrefix', () => {
  it('strips coords + leading whitespace, returns memo', () => {
    expect(stripCoordPrefix('39.908,116.397 停车场B区')).toBe('停车场B区')
  })
  it('returns empty when no memo', () => {
    expect(stripCoordPrefix('39.908,116.397')).toBe('')
  })
  it('preserves non-coord input verbatim', () => {
    expect(stripCoordPrefix('国贸三期')).toBe('国贸三期')
  })
})

describe('mapUrl (Baidu)', () => {
  it('builds Baidu marker URI with coords + WGS-84 hint', () => {
    const url = mapUrl(39.908, 116.397)
    expect(url).toContain('api.map.baidu.com/marker')
    expect(url).toContain('location=39.908%2C116.397')
    expect(url).toContain('coord_type=wgs84')
    expect(url).toContain('output=html')
    expect(url).toContain('src=imhub')
  })
  it('includes title and content when given', () => {
    const url = mapUrl(39.908, 116.397, '故宫', '北京市东城区')
    expect(decodeURIComponent(url)).toContain('title=故宫')
    expect(decodeURIComponent(url)).toContain('content=北京市东城区')
  })
})

describe('wgs84ToGcj02', () => {
  it('returns input unchanged outside China (Sydney)', () => {
    const sydney = wgs84ToGcj02(-33.8688, 151.2093)
    expect(sydney.lat).toBeCloseTo(-33.8688, 6)
    expect(sydney.lng).toBeCloseTo(151.2093, 6)
  })
  it('returns input unchanged outside China (NYC)', () => {
    const nyc = wgs84ToGcj02(40.7128, -74.0060)
    expect(nyc.lat).toBeCloseTo(40.7128, 6)
    expect(nyc.lng).toBeCloseTo(-74.0060, 6)
  })
  it('shifts coords inside China (Beijing Tiananmen)', () => {
    // Tiananmen WGS-84 ≈ (39.9055, 116.3911); GCJ-02 shift is ~300-700m,
    // generally the result is east+north of the input.
    const r = wgs84ToGcj02(39.9055, 116.3911)
    expect(Math.abs(r.lat - 39.9055)).toBeGreaterThan(0.001)
    expect(Math.abs(r.lng - 116.3911)).toBeGreaterThan(0.001)
    // Sanity-bound: the offset is always under ~0.01° in either dimension.
    expect(Math.abs(r.lat - 39.9055)).toBeLessThan(0.01)
    expect(Math.abs(r.lng - 116.3911)).toBeLessThan(0.01)
  })
  it('shifts coords inside China (Shanghai)', () => {
    const r = wgs84ToGcj02(31.2304, 121.4737)
    expect(Math.abs(r.lat - 31.2304)).toBeGreaterThan(0.001)
    expect(Math.abs(r.lng - 121.4737)).toBeGreaterThan(0.001)
  })
})

describe('mapUrls (multi-provider)', () => {
  it('returns three provider URLs', () => {
    const u = mapUrls(39.908, 116.397, '故宫')
    expect(u.baidu).toContain('api.map.baidu.com/marker')
    expect(u.amap).toContain('uri.amap.com/marker')
    expect(u.google).toContain('google.com/maps')
  })
  it('Baidu URL keeps WGS-84 (passthrough + coord_type)', () => {
    const u = mapUrls(39.908, 116.397, '故宫')
    expect(u.baidu).toContain('coord_type=wgs84')
    expect(u.baidu).toContain('location=39.908%2C116.397')
  })
  it('Amap URL converts to GCJ-02 (coords differ from input inside China)', () => {
    const u = mapUrls(39.908, 116.397, '故宫')
    // Amap position is "lng,lat" — extract and confirm it's NOT raw WGS-84.
    const m = u.amap.match(/position=([\d.]+)%2C([\d.]+)/)
    expect(m).toBeTruthy()
    if (m) {
      const lng = parseFloat(m[1])
      const lat = parseFloat(m[2])
      expect(Math.abs(lng - 116.397)).toBeGreaterThan(0.001)
      expect(Math.abs(lat - 39.908)).toBeGreaterThan(0.001)
    }
  })
  it('Amap URL passes WGS-84 unchanged outside China', () => {
    const u = mapUrls(40.7128, -74.0060)  // NYC
    expect(u.amap).toContain('position=-74.006%2C40.7128')
  })
  it('Google URL is plain WGS-84', () => {
    const u = mapUrls(39.908, 116.397)
    expect(u.google).toContain('q=39.908%2C116.397')
  })
  it('includes label as Amap name', () => {
    const u = mapUrls(39.908, 116.397, '故宫')
    expect(decodeURIComponent(u.amap)).toContain('name=故宫')
  })
})

describe('isGeocodingAvailable', () => {
  it('reflects IMHUB_BAIDU_MAP_AK presence', () => {
    const orig = process.env.IMHUB_BAIDU_MAP_AK
    delete process.env.IMHUB_BAIDU_MAP_AK
    expect(isGeocodingAvailable()).toBe(false)
    process.env.IMHUB_BAIDU_MAP_AK = 'fake-test-ak'
    expect(isGeocodingAvailable()).toBe(true)
    if (orig === undefined) delete process.env.IMHUB_BAIDU_MAP_AK
    else process.env.IMHUB_BAIDU_MAP_AK = orig
  })
})

// Tencent geocoder + SK signing was replaced with Baidu (no signing
// required for default keys) in 0.2.42-pre. If you ever need to add SN
// signing for a Baidu key with 校验 enabled, the algorithm is:
//   MD5(URLencode(path?qs+sk))
// (different from Tencent's MD5(path?raw_qs+sk) — note the URL-encoding
// of the entire path+qs+sk concat). See locations.ts header comment.

// CRUD tests touch the SQLite layer. Bun's runtime can't load better-sqlite3
// in this dev env (same issue logged across the suite — CI runs real Node and
// passes). Probe once and skip the whole describe block when sqlite is dead.
function sqliteAlive(): boolean {
  try {
    createMemo({
      platform: 'wechat', channelId: 'probe', threadId: 'probe', userId: 'probe-user',
      lat: 0, lng: 0, note: '__probe__',
    })
    return true
  } catch {
    return false
  }
}
const SQLITE_OK = sqliteAlive()
const describeIfSqlite = SQLITE_OK ? describe : describe.skip

describeIfSqlite('memo CRUD', () => {
  it('createMemo + getMemo round-trip', () => {
    const id = createMemo({
      platform: 'wechat', channelId: 'c', threadId: 't', userId: 'alice',
      lat: 39.908, lng: 116.397, note: '故宫午门', source: 'manual',
    })
    expect(id).toBeGreaterThan(0)
    const m = getMemo(id, { userId: 'alice' })
    expect(m).not.toBeNull()
    expect(m?.lat).toBe(39.908)
    expect(m?.note).toBe('故宫午门')
    expect(m?.source).toBe('manual')
  })

  it('listMemos returns most-recent first', () => {
    createMemo({ platform: 'wechat', channelId: 'c', threadId: 't', userId: 'bob', lat: 1, lng: 1, note: 'A' })
    createMemo({ platform: 'wechat', channelId: 'c', threadId: 't', userId: 'bob', lat: 2, lng: 2, note: 'B' })
    const list = listMemos({ userId: 'bob' })
    expect(list.length).toBe(2)
    expect(list[0].note).toBe('B') // newest first
    expect(list[1].note).toBe('A')
  })

  it('owner scoping: alice cannot see bob memos', () => {
    const aliceList = listMemos({ userId: 'alice' })
    const bobList = listMemos({ userId: 'bob' })
    // alice has the one from the first test; bob has 2 from second
    for (const m of aliceList) expect(m.user_id).toBe('alice')
    for (const m of bobList) expect(m.user_id).toBe('bob')
  })

  it('owner scoping: getMemo across users returns null', () => {
    const id = createMemo({
      platform: 'wechat', channelId: 'c', threadId: 't', userId: 'alice',
      lat: 5, lng: 5, note: 'private',
    })
    expect(getMemo(id, { userId: 'bob' })).toBeNull()
    expect(getMemo(id, { userId: 'alice' })).not.toBeNull()
  })

  it('deleteMemo: own → ok, other-user → no-op', () => {
    const id = createMemo({
      platform: 'wechat', channelId: 'c', threadId: 't', userId: 'alice',
      lat: 9, lng: 9, note: 'todelete',
    })
    expect(deleteMemo(id, { userId: 'bob' })).toBe(false)  // foreign user
    expect(getMemo(id, { userId: 'alice' })).not.toBeNull() // still there
    expect(deleteMemo(id, { userId: 'alice' })).toBe(true)
    expect(getMemo(id, { userId: 'alice' })).toBeNull()
  })

  it('createMemo rejects out-of-range coords', () => {
    expect(() => createMemo({
      platform: 'wechat', channelId: 'c', threadId: 't', userId: 'x',
      lat: 200, lng: 0,
    })).toThrow('invalid latitude')
    expect(() => createMemo({
      platform: 'wechat', channelId: 'c', threadId: 't', userId: 'x',
      lat: 0, lng: 200,
    })).toThrow('invalid longitude')
  })

  it('listMemos respects limit (clamped 1..100)', () => {
    for (let i = 0; i < 5; i++) {
      createMemo({ platform: 'wechat', channelId: 'c', threadId: 't', userId: 'limit-user', lat: i, lng: i, note: `n${i}` })
    }
    expect(listMemos({ userId: 'limit-user', limit: 3 }).length).toBe(3)
    expect(listMemos({ userId: 'limit-user', limit: 0 }).length).toBe(1)   // clamped to min 1
    expect(listMemos({ userId: 'limit-user', limit: 999 }).length).toBe(5) // clamped to 100, only 5 exist
  })
})
