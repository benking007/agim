// coord-systems.ts — every coordinate-system conversion + the
// "normalize an incoming location" policy that adapters route through.
//
// Why this module exists (incident background, 2026-05-12):
//   The old behavior was "treat every incoming lat/lng as GCJ-02 if it
//   falls inside the China bbox" — true for iOS Core Location and
//   Apple/Google GMS-with-China-region, FALSE for the WeChat X5
//   webview, raw Android Chrome, Telegram Desktop, and other paths
//   where the JS / IM payload is already WGS-84.
//
//   The user observed wrong markers in WeChat — `/memo here` H5 capture
//   landed coords ~500m–1km off on both 高德 and 百度 maps. Root cause:
//   X5 webview hands the page genuine WGS-84, but server.ts applied an
//   inverse GCJ→WGS offset on top, so the stored value was *anti-shifted*
//   and every downstream map URL re-shifted it back the wrong way.
//
//   Per-platform reality (empirically known as of 2026-05):
//
//   | Source                                | Coord system    |
//   |---------------------------------------|-----------------|
//   | Telegram native location (iOS in China)        | GCJ-02 |
//   | Telegram native location (iOS outside China)   | WGS-84 |
//   | Telegram native location (Telegram Desktop)    | WGS-84 |
//   | Telegram native location (most Android cases)  | WGS-84 |
//   | Feishu native location                          | GCJ-02 (mandated) |
//   | DingTalk native location                        | n/a (not delivered to bots) |
//   | DingTalk link msgtype → Amap/Tencent URL        | GCJ-02 |
//   | DingTalk link msgtype → Baidu Maps URL          | BD-09  |
//   | H5 `navigator.geolocation` in iOS Safari (CN)   | GCJ-02 |
//   | H5 `navigator.geolocation` in WeChat X5 / Chrome| WGS-84 |
//
//   There is no reliable server-side way to know which of the two
//   ambiguous paths produced any given coord, so we ship sensible
//   defaults + env-var overrides for the edge cases.

import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'coord-systems' })

// ─── inputs the wizard / adapters tag the source with ───────────────
export type CoordSource =
  | 'telegram-native'
  | 'feishu-native'
  | 'dingtalk-link-amap'      // amap.com / uri.amap.com / restapi.amap.com
  | 'dingtalk-link-tencent'   // apis.map.qq.com / map.qq.com
  | 'dingtalk-link-baidu'     // api.map.baidu.com / map.baidu.com
  | 'dingtalk-link-unknown'   // unrecognised host; pass through as WGS-84
  | 'h5-browser-geolocation'  // /loc POST from /memo here capture page
  | 'web-admin'               // Web Admin / Web Chat console (developer-side)

export interface NormalizeResult {
  /** Latitude in WGS-84 after any conversion. */
  lat: number
  /** Longitude in WGS-84. */
  lng: number
  /** Which conversion was applied. Useful for log post-mortems. */
  applied: 'none' | 'gcj02-to-wgs84' | 'bd09-to-wgs84'
  /** True iff the input was outside the China bbox (conversions skipped
   *  there because GCJ-02 is only defined for in-China coords). */
  outOfChina: boolean
}

/**
 * Convert any incoming (lat, lng) to WGS-84 based on what we know about
 * the source. Adapters route every native coord through this. Defaults
 * favor "trust the payload as WGS-84" because that's the safer assumption
 * when the source is ambiguous — applying an inverse GCJ offset to a
 * value that's actually already WGS produces a 500m-1km error, while
 * pass-through on actual GCJ leaves the user with the same ~1km error
 * but in a recoverable direction. Both error modes get the user roughly
 * the right country / city; an `AGIM_*_COORDS_GCJ02=1` env flag flips
 * the default for any source whose users tell us their device DOES apply
 * the offset (Apple devices in China + Chinese region most often).
 */
/** Plan C (2026-05-22): caller can force the source coord-system,
 *  bypassing the env-flag heuristic. Used by IM adapters that have
 *  looked up a per-user preference (see core/user-coord-prefs.ts). */
export interface NormalizeOptions {
  /** Pre-known source coord-system, e.g. learned from the user's
   *  earlier `#wgs` / `#gcj` / `#bd` reply. When set, all other
   *  heuristics are ignored. */
  force?: 'wgs84' | 'gcj02' | 'bd09'
}

export function normalizeIncomingCoords(
  source: CoordSource,
  lat: number,
  lng: number,
  opts?: NormalizeOptions,
): NormalizeResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { lat, lng, applied: 'none', outOfChina: true }
  }
  if (outOfChina(lat, lng)) {
    return { lat, lng, applied: 'none', outOfChina: true }
  }

  // ─── Plan C override path ─────────────────────────────────────────
  // The IM adapter has looked up a stored preference for this user; we
  // trust it and skip the heuristic table below. This is how
  // `#wgs` / `#gcj` / `#bd` self-learn flow takes effect.
  if (opts?.force) {
    if (opts.force === 'bd09') {
      const wgs = bd09ToWgs84(lat, lng)
      log.debug({
        event: 'coord.normalized', source, forced: 'bd09',
        raw_lat: lat, raw_lng: lng, wgs_lat: wgs.lat, wgs_lng: wgs.lng,
        applied: 'bd09-to-wgs84',
      })
      return { lat: wgs.lat, lng: wgs.lng, applied: 'bd09-to-wgs84', outOfChina: false }
    }
    if (opts.force === 'gcj02') {
      const wgs = gcj02ToWgs84(lat, lng)
      log.debug({
        event: 'coord.normalized', source, forced: 'gcj02',
        raw_lat: lat, raw_lng: lng, wgs_lat: wgs.lat, wgs_lng: wgs.lng,
        applied: 'gcj02-to-wgs84',
      })
      return { lat: wgs.lat, lng: wgs.lng, applied: 'gcj02-to-wgs84', outOfChina: false }
    }
    // force === 'wgs84' → pass-through
    log.debug({
      event: 'coord.normalized', source, forced: 'wgs84',
      raw_lat: lat, raw_lng: lng, wgs_lat: lat, wgs_lng: lng, applied: 'none',
    })
    return { lat, lng, applied: 'none', outOfChina: false }
  }

  // Per-source policy. The flag-overrideable defaults reflect the empirical
  // table at the top of this file. See env table at the bottom.
  const treatAsGcj = ((): boolean => {
    switch (source) {
      case 'telegram-native':
        // Plan C (2026-05-22): in the absence of a stored per-user
        // preference, default to GCJ-02 *if* we're inside China. This
        // covers the most common iOS path (Core Location auto-offsets)
        // which we found to be the majority of real-world deployments.
        // The env flag is retained as an inverter for ops that know
        // their crowd is predominantly Android/Desktop. Mismatched
        // first-time users get one wrong marker → reply `#wgs` → fixed
        // for the rest of time.
        if (process.env.AGIM_TELEGRAM_COORDS_GCJ02 === '0') return false
        return true
      case 'feishu-native':
        // Feishu is mandated GCJ-02 server-side, no override expected.
        return true
      case 'dingtalk-link-amap':
      case 'dingtalk-link-tencent':
        return true
      case 'dingtalk-link-baidu':
        return false // BD-09, handled below
      case 'dingtalk-link-unknown':
        return false // pass-through; don't guess
      case 'h5-browser-geolocation':
        // Default WGS-84. THIS IS THE INCIDENT FIX (2026-05-12): WeChat
        // X5 + Android Chrome without GMS hand the page raw WGS-84 and
        // the old "always GCJ" assumption put markers ~1km off in WeChat.
        // iOS Safari users in China can flip the flag to restore the old
        // GCJ→WGS path.
        return process.env.AGIM_H5_COORDS_GCJ02 === '1'
      case 'web-admin':
        // Developer-facing console; PC browser is overwhelmingly WGS-84.
        return false
    }
  })()

  if (source === 'dingtalk-link-baidu') {
    const wgs = bd09ToWgs84(lat, lng)
    log.debug({
      event: 'coord.normalized',
      source,
      raw_lat: lat, raw_lng: lng,
      wgs_lat: wgs.lat, wgs_lng: wgs.lng,
      applied: 'bd09-to-wgs84',
    })
    return { lat: wgs.lat, lng: wgs.lng, applied: 'bd09-to-wgs84', outOfChina: false }
  }

  if (treatAsGcj) {
    const wgs = gcj02ToWgs84(lat, lng)
    log.debug({
      event: 'coord.normalized',
      source,
      raw_lat: lat, raw_lng: lng,
      wgs_lat: wgs.lat, wgs_lng: wgs.lng,
      applied: 'gcj02-to-wgs84',
    })
    return { lat: wgs.lat, lng: wgs.lng, applied: 'gcj02-to-wgs84', outOfChina: false }
  }

  log.debug({
    event: 'coord.normalized',
    source,
    raw_lat: lat, raw_lng: lng,
    wgs_lat: lat, wgs_lng: lng,
    applied: 'none',
  })
  return { lat, lng, applied: 'none', outOfChina: false }
}

// ─── coord-system math ──────────────────────────────────────────────
// We keep the GCJ pair in this file alongside BD-09 (rather than
// re-exporting from memos.ts) so all coord math lives in one place.
// The originals in memos.ts are still exported for backwards-compat;
// new code should import from here.

const A = 6378245.0
const EE = 0.006693421622965943
const PI = Math.PI

/** WGS-84 → GCJ-02. */
export function wgs84ToGcj02(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat); magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lat: lat + dLat, lng: lng + dLng }
}

/** GCJ-02 → WGS-84 (Newton iteration; converges to sub-meter in 3 passes). */
export function gcj02ToWgs84(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  let wgsLat = lat
  let wgsLng = lng
  for (let i = 0; i < 3; i++) {
    const forward = wgs84ToGcj02(wgsLat, wgsLng)
    wgsLat = lat - (forward.lat - wgsLat)
    wgsLng = lng - (forward.lng - wgsLng)
  }
  return { lat: wgsLat, lng: wgsLng }
}

/**
 * Baidu BD-09 → GCJ-02. BD-09 is GCJ-02 plus an additional radial offset
 * applied by Baidu. The math is well-known (cf. open-source `coordtransform`
 * libraries); we lift the formula verbatim and add a comment so the next
 * reader doesn't have to derive it.
 */
export function bd09ToGcj02(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  const X_PI = (PI * 3000.0) / 180.0
  const x = lng - 0.0065
  const y = lat - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI)
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI)
  return { lat: z * Math.sin(theta), lng: z * Math.cos(theta) }
}

/** GCJ-02 → Baidu BD-09 (forward; closed form). */
export function gcj02ToBd09(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  const X_PI = (PI * 3000.0) / 180.0
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI)
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI)
  return { lat: z * Math.sin(theta) + 0.006, lng: z * Math.cos(theta) + 0.0065 }
}

/** BD-09 → WGS-84 via GCJ-02 intermediate. */
export function bd09ToWgs84(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  const gcj = bd09ToGcj02(lat, lng)
  return gcj02ToWgs84(gcj.lat, gcj.lng)
}

/** WGS-84 → BD-09 via GCJ-02 intermediate. Useful for building Baidu
 *  Maps URLs from our WGS-stored coords. */
export function wgs84ToBd09(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  const gcj = wgs84ToGcj02(lat, lng)
  return gcj02ToBd09(gcj.lat, gcj.lng)
}

// ─── internals ──────────────────────────────────────────────────────

/** GCJ-02 offset is only defined for mainland China + the bbox below.
 *  Outside, every conversion in this module is a no-op pass-through. */
export function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  r += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  r += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return r
}

function transformLng(x: number, y: number): number {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  r += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  r += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return r
}

// ─── env vars exposed by this module ────────────────────────────────
//
// AGIM_TELEGRAM_COORDS_GCJ02=1
//   Apply GCJ-02 → WGS-84 to Telegram native location/venue messages.
//   Default off (WGS pass-through). Turn ON if your Telegram clients are
//   Apple devices in China (iOS Core Location applies the offset).
//
// AGIM_H5_COORDS_GCJ02=1
//   Apply GCJ-02 → WGS-84 to coordinates POSTed from the /memo here H5
//   capture page. Default off (WGS pass-through). Turn ON if your users
//   open the H5 link in iOS Safari / iOS WebKit in mainland China —
//   navigator.geolocation respects Apple's GCJ offset there.
//
// (Feishu always GCJ→WGS, DingTalk amap/qmap always GCJ→WGS,
//  DingTalk baidu always BD-09→WGS — those are server-mandated and
//  don't need overrides.)
