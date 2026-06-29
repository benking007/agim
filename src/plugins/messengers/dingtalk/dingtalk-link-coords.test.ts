// Tests for tryExtractLatLng — verifies the URL host → CoordSource
// mapping that drives which coord-system conversion gets applied to a
// shared link's lat/lng. Without correct host classification the
// downstream `normalizeIncomingCoords` would treat a Baidu BD-09 URL as
// GCJ-02 and the marker would land ~500m off (the chained-offset bug
// that 2026-05-12 fixed for the H5 path; this guards against the same
// failure mode in the DingTalk path).

import { describe, it, expect } from 'bun:test'
// Import from the standalone link-coords module rather than dingtalk-adapter.
// The adapter pulls in media-store → telegram/media-download which captures
// AGIM_MEDIA_ROOT at import time; loading it inside the test runner
// polluted the module cache for telegram's own test file. Keep this test
// light by going straight to the URL helpers.
import { tryExtractLatLng } from './link-coords.js'

describe('tryExtractLatLng — host classification', () => {
  it('amap.com → source=dingtalk-link-amap (GCJ-02)', () => {
    const r = tryExtractLatLng('https://uri.amap.com/marker?position=120.128,30.276&name=Test')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('dingtalk-link-amap')
    // position is "lng,lat" — verify we got the parse direction right.
    expect(r!.lat).toBeCloseTo(30.276, 3)
    expect(r!.lng).toBeCloseTo(120.128, 3)
  })

  it('apis.map.qq.com → source=dingtalk-link-tencent (GCJ-02)', () => {
    const r = tryExtractLatLng('https://apis.map.qq.com/uri/v1/marker?marker=coord:30.276,120.128;title:Test')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('dingtalk-link-tencent')
    expect(r!.lat).toBeCloseTo(30.276, 3)
    expect(r!.lng).toBeCloseTo(120.128, 3)
  })

  it('api.map.baidu.com → source=dingtalk-link-baidu (BD-09)', () => {
    const r = tryExtractLatLng('https://api.map.baidu.com/marker?location=30.282,120.139&title=Test')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('dingtalk-link-baidu')
    expect(r!.lat).toBeCloseTo(30.282, 3)
    expect(r!.lng).toBeCloseTo(120.139, 3)
  })

  it('unknown host → source=dingtalk-link-unknown (pass-through)', () => {
    const r = tryExtractLatLng('https://example.com/?lat=30.276&lng=120.128')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('dingtalk-link-unknown')
  })

  it('returns null for non-map URLs', () => {
    expect(tryExtractLatLng('https://example.com/about')).toBeNull()
    expect(tryExtractLatLng('not a url')).toBeNull()
    expect(tryExtractLatLng('')).toBeNull()
  })

  it('generic ?location= falls back to host classification', () => {
    // A baidu URL using generic location= param still gets baidu classification
    const r = tryExtractLatLng('https://map.baidu.com/?location=30.282,120.139')
    expect(r!.source).toBe('dingtalk-link-baidu')
  })
})
