// Tests for coord-systems.ts — verifies:
//   1. Forward / inverse conversions round-trip to sub-meter precision.
//   2. BD-09 ↔ GCJ-02 ↔ WGS-84 chain composes correctly.
//   3. outOfChina bypass: every converter is a no-op outside the bbox.
//   4. `normalizeIncomingCoords` applies the right policy per source +
//      respects env-flag overrides for telegram-native + h5-browser-geolocation.
//
// We intentionally don't pin coords to a hard-coded "correct GCJ value"
// for some real city — the math is well-tested upstream and our
// implementation is the standard formula. We test the round-trip and the
// policy switch, which is what we actually own.

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  wgs84ToGcj02,
  gcj02ToWgs84,
  bd09ToGcj02,
  gcj02ToBd09,
  bd09ToWgs84,
  wgs84ToBd09,
  outOfChina,
  normalizeIncomingCoords,
} from './coord-systems.js'

// (lat, lng) inside mainland China — Hangzhou, near the Huanglong area.
// Sub-meter precision = 1e-5 degrees ≈ 1m at this latitude.
const HZ_WGS = { lat: 30.275796, lng: 120.127970 }

// (lat, lng) clearly outside the China bbox — Times Square, NYC.
const NYC = { lat: 40.7580, lng: -73.9855 }

describe('coord math', () => {
  it('WGS → GCJ → WGS round-trips to sub-meter', () => {
    const gcj = wgs84ToGcj02(HZ_WGS.lat, HZ_WGS.lng)
    const back = gcj02ToWgs84(gcj.lat, gcj.lng)
    expect(Math.abs(back.lat - HZ_WGS.lat)).toBeLessThan(1e-5)
    expect(Math.abs(back.lng - HZ_WGS.lng)).toBeLessThan(1e-5)
  })

  it('GCJ → BD-09 → GCJ round-trips to sub-meter', () => {
    const gcj = wgs84ToGcj02(HZ_WGS.lat, HZ_WGS.lng)
    const bd = gcj02ToBd09(gcj.lat, gcj.lng)
    const back = bd09ToGcj02(bd.lat, bd.lng)
    expect(Math.abs(back.lat - gcj.lat)).toBeLessThan(1e-5)
    expect(Math.abs(back.lng - gcj.lng)).toBeLessThan(1e-5)
  })

  it('BD-09 → WGS-84 → BD-09 round-trips to sub-meter', () => {
    const bd = wgs84ToBd09(HZ_WGS.lat, HZ_WGS.lng)
    const back = wgs84ToBd09(bd09ToWgs84(bd.lat, bd.lng).lat, bd09ToWgs84(bd.lat, bd.lng).lng)
    expect(Math.abs(back.lat - bd.lat)).toBeLessThan(1e-5)
    expect(Math.abs(back.lng - bd.lng)).toBeLessThan(1e-5)
  })

  it('actual offsets are ~hundreds of meters in China (sanity check)', () => {
    // GCJ offsets WGS by ~500m at this latitude. If our math is broken
    // (e.g., wrong constants) the offset would be 0 or unrealistically
    // large. Bounds chosen to fail loudly on a constant typo.
    const gcj = wgs84ToGcj02(HZ_WGS.lat, HZ_WGS.lng)
    const dLat = Math.abs(gcj.lat - HZ_WGS.lat)
    const dLng = Math.abs(gcj.lng - HZ_WGS.lng)
    expect(dLat).toBeGreaterThan(0.0001) // > ~10m
    expect(dLat).toBeLessThan(0.01)      // < ~1km
    expect(dLng).toBeGreaterThan(0.0001)
    expect(dLng).toBeLessThan(0.01)
    // BD-09 sits a further ~500m beyond GCJ.
    const bd = gcj02ToBd09(gcj.lat, gcj.lng)
    expect(Math.abs(bd.lat - gcj.lat)).toBeGreaterThan(0.0001)
    expect(Math.abs(bd.lng - gcj.lng)).toBeGreaterThan(0.0001)
  })

  it('outOfChina returns true for NYC, false for Hangzhou', () => {
    expect(outOfChina(NYC.lat, NYC.lng)).toBe(true)
    expect(outOfChina(HZ_WGS.lat, HZ_WGS.lng)).toBe(false)
  })

  it('every converter is identity for out-of-China coords', () => {
    expect(wgs84ToGcj02(NYC.lat, NYC.lng)).toEqual(NYC)
    expect(gcj02ToWgs84(NYC.lat, NYC.lng)).toEqual(NYC)
    expect(bd09ToGcj02(NYC.lat, NYC.lng)).toEqual(NYC)
    expect(bd09ToWgs84(NYC.lat, NYC.lng)).toEqual(NYC)
    expect(wgs84ToBd09(NYC.lat, NYC.lng)).toEqual(NYC)
  })
})

describe('normalizeIncomingCoords — per-source policy', () => {
  beforeEach(() => {
    delete process.env.AGIM_TELEGRAM_COORDS_GCJ02
    delete process.env.AGIM_H5_COORDS_GCJ02
  })

  // ─── feishu-native: always GCJ→WGS (server-mandated, no flag) ──
  it('feishu-native applies gcj02-to-wgs84', () => {
    const gcj = wgs84ToGcj02(HZ_WGS.lat, HZ_WGS.lng)
    const r = normalizeIncomingCoords('feishu-native', gcj.lat, gcj.lng)
    expect(r.applied).toBe('gcj02-to-wgs84')
    expect(Math.abs(r.lat - HZ_WGS.lat)).toBeLessThan(1e-5)
    expect(Math.abs(r.lng - HZ_WGS.lng)).toBeLessThan(1e-5)
  })

  // ─── telegram-native: Plan C (2026-05-22) default = GCJ→WGS in China,
  //     env=0 forces pass-through. force opt always wins. ──
  it('telegram-native default in-China = GCJ→WGS (Apple iOS Core Location case)', () => {
    delete process.env.AGIM_TELEGRAM_COORDS_GCJ02
    const gcj = wgs84ToGcj02(HZ_WGS.lat, HZ_WGS.lng)
    const r = normalizeIncomingCoords('telegram-native', gcj.lat, gcj.lng)
    expect(r.applied).toBe('gcj02-to-wgs84')
    expect(Math.abs(r.lat - HZ_WGS.lat)).toBeLessThan(1e-5)
  })

  it('telegram-native with AGIM_TELEGRAM_COORDS_GCJ02=0 = pass-through (Android / Desktop)', () => {
    process.env.AGIM_TELEGRAM_COORDS_GCJ02 = '0'
    const r = normalizeIncomingCoords('telegram-native', HZ_WGS.lat, HZ_WGS.lng)
    expect(r.applied).toBe('none')
    expect(r.lat).toBe(HZ_WGS.lat)
    expect(r.lng).toBe(HZ_WGS.lng)
    delete process.env.AGIM_TELEGRAM_COORDS_GCJ02
  })

  it('force=wgs84 overrides the in-China default (Plan C per-user pref)', () => {
    delete process.env.AGIM_TELEGRAM_COORDS_GCJ02
    const r = normalizeIncomingCoords('telegram-native', HZ_WGS.lat, HZ_WGS.lng, { force: 'wgs84' })
    expect(r.applied).toBe('none')
    expect(r.lat).toBe(HZ_WGS.lat)
    expect(r.lng).toBe(HZ_WGS.lng)
  })

  it('force=bd09 applies BD→WGS regardless of source heuristics', () => {
    const bd = { lat: 30.2532, lng: 120.2147 } // arbitrary BD-09 near 杭州
    const r = normalizeIncomingCoords('telegram-native', bd.lat, bd.lng, { force: 'bd09' })
    expect(r.applied).toBe('bd09-to-wgs84')
    // BD-09 → WGS-84 should shift ~1km+, definitely > 1e-3 in either axis
    expect(Math.abs(r.lat - bd.lat) + Math.abs(r.lng - bd.lng)).toBeGreaterThan(1e-3)
  })

  // ─── h5-browser-geolocation: default pass-through (the bug fix) ──
  it('h5 default = pass-through (the WeChat-X5 case)', () => {
    const r = normalizeIncomingCoords('h5-browser-geolocation', HZ_WGS.lat, HZ_WGS.lng)
    expect(r.applied).toBe('none')
    expect(r.lat).toBe(HZ_WGS.lat)
    expect(r.lng).toBe(HZ_WGS.lng)
  })

  it('h5 with AGIM_H5_COORDS_GCJ02=1 applies GCJ→WGS (iOS Safari case)', () => {
    process.env.AGIM_H5_COORDS_GCJ02 = '1'
    const gcj = wgs84ToGcj02(HZ_WGS.lat, HZ_WGS.lng)
    const r = normalizeIncomingCoords('h5-browser-geolocation', gcj.lat, gcj.lng)
    expect(r.applied).toBe('gcj02-to-wgs84')
    expect(Math.abs(r.lat - HZ_WGS.lat)).toBeLessThan(1e-5)
  })

  // ─── dingtalk-link-{amap,tencent,baidu,unknown} ──
  it('dingtalk-link-amap applies GCJ→WGS', () => {
    const gcj = wgs84ToGcj02(HZ_WGS.lat, HZ_WGS.lng)
    const r = normalizeIncomingCoords('dingtalk-link-amap', gcj.lat, gcj.lng)
    expect(r.applied).toBe('gcj02-to-wgs84')
  })

  it('dingtalk-link-tencent applies GCJ→WGS', () => {
    const gcj = wgs84ToGcj02(HZ_WGS.lat, HZ_WGS.lng)
    const r = normalizeIncomingCoords('dingtalk-link-tencent', gcj.lat, gcj.lng)
    expect(r.applied).toBe('gcj02-to-wgs84')
  })

  it('dingtalk-link-baidu applies BD-09→WGS', () => {
    const bd = wgs84ToBd09(HZ_WGS.lat, HZ_WGS.lng)
    const r = normalizeIncomingCoords('dingtalk-link-baidu', bd.lat, bd.lng)
    expect(r.applied).toBe('bd09-to-wgs84')
    expect(Math.abs(r.lat - HZ_WGS.lat)).toBeLessThan(1e-4)
    expect(Math.abs(r.lng - HZ_WGS.lng)).toBeLessThan(1e-4)
  })

  it('dingtalk-link-unknown passes through', () => {
    const r = normalizeIncomingCoords('dingtalk-link-unknown', HZ_WGS.lat, HZ_WGS.lng)
    expect(r.applied).toBe('none')
  })

  // ─── out-of-China is universal pass-through regardless of source ──
  it('NYC coords pass through every source unchanged', () => {
    for (const source of [
      'telegram-native', 'feishu-native', 'h5-browser-geolocation',
      'dingtalk-link-amap', 'dingtalk-link-baidu', 'dingtalk-link-unknown',
    ] as const) {
      const r = normalizeIncomingCoords(source, NYC.lat, NYC.lng)
      expect(r.applied).toBe('none')
      expect(r.outOfChina).toBe(true)
      expect(r.lat).toBe(NYC.lat)
      expect(r.lng).toBe(NYC.lng)
    }
  })

  // ─── NaN guard ──
  it('NaN inputs pass through without crash', () => {
    const r = normalizeIncomingCoords('feishu-native', NaN, NaN)
    expect(Number.isNaN(r.lat)).toBe(true)
    expect(Number.isNaN(r.lng)).toBe(true)
    expect(r.applied).toBe('none')
  })
})
