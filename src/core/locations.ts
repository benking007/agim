// Location memos — "I parked my car at <coords>" style notes.
//
// Storage: ~/.im-hub/locations.db (SQLite, fail-soft via sqlite-helper).
// Owner-scoped per (platform, user_id), same pattern as /remind and /cron.
//
// Two input paths:
//   1. Coords:  "/location 39.908,116.397 [memo]"        — zero deps.
//   2. Address: "/location 国贸三期 [memo]"               — needs IMHUB_BAIDU_MAP_AK.
//
// Render: every memo carries a Baidu Maps URI scheme link
// (https://api.map.baidu.com/marker?...) which opens the user's map app.
// All stored coords are WGS-84 (browser geolocation native + Baidu geocoder
// forced via ret_coordtype=wgs84ll). Baidu marker URL gets coord_type=wgs84
// to match.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'

const log = rootLogger.child({ component: 'locations' })

const DB_FILE = process.env.IMHUB_LOCATIONS_DB || join(homedir(), '.im-hub', 'locations.db')

export interface LocationMemo {
  id: number
  platform: string
  channel_id: string
  thread_id: string
  user_id: string
  lat: number
  lng: number
  label: string
  note: string
  source: 'manual' | 'geocoded' | 'browser'
  created_at: string
}

export interface OwnerOpts {
  /** When set, scope reads/writes/deletes to this user. Empty = unrestricted
   *  (back-compat for non-IM callers / tests). */
  userId?: string
}

const helper = createSqliteHelper({
  file: DB_FILE,
  component: 'locations',
  logger: rootLogger as never,
  schema: `
    CREATE TABLE IF NOT EXISTS location_memos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      platform    TEXT    NOT NULL,
      channel_id  TEXT    NOT NULL,
      thread_id   TEXT    NOT NULL,
      user_id     TEXT    NOT NULL DEFAULT '',
      lat         REAL    NOT NULL,
      lng         REAL    NOT NULL,
      label       TEXT    NOT NULL DEFAULT '',
      note        TEXT    NOT NULL DEFAULT '',
      source      TEXT    NOT NULL DEFAULT 'manual',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_loc_user
      ON location_memos(platform, user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_loc_thread
      ON location_memos(platform, channel_id, thread_id, created_at DESC);
  `,
})

export interface CreateMemoInput {
  platform: string
  channelId: string
  threadId: string
  userId?: string
  lat: number
  lng: number
  label?: string
  note?: string
  source?: LocationMemo['source']
}

/** Sanity-check WGS84 ranges. Out-of-range = caller bug; throw to surface. */
function assertCoords(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(`invalid latitude: ${lat}`)
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error(`invalid longitude: ${lng}`)
  }
}

export function createMemo(input: CreateMemoInput): number {
  assertCoords(input.lat, input.lng)
  const d = helper.get()
  if (!d) throw new Error('locations DB unavailable (sqlite disabled?)')
  const stmt = d.prepare(
    `INSERT INTO location_memos
       (platform, channel_id, thread_id, user_id, lat, lng, label, note, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const r = stmt.run(
    input.platform, input.channelId, input.threadId,
    input.userId ?? '',
    input.lat, input.lng,
    input.label ?? '', input.note ?? '',
    input.source ?? 'manual',
  )
  log.info({
    event: 'locations.created',
    id: r.lastInsertRowid, platform: input.platform, userId: input.userId,
    lat: input.lat, lng: input.lng, source: input.source,
  })
  return Number(r.lastInsertRowid)
}

export function listMemos(opts: OwnerOpts & { limit?: number } = {}): LocationMemo[] {
  return helper.safe((d) => {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
    if (opts.userId) {
      return d.prepare(
        `SELECT * FROM location_memos WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      ).all(opts.userId, limit) as LocationMemo[]
    }
    return d.prepare(
      `SELECT * FROM location_memos ORDER BY id DESC LIMIT ?`,
    ).all(limit) as LocationMemo[]
  }, [])
}

export interface SearchOpts extends OwnerOpts {
  /** Free-text query — matched as `LIKE %query%` against label and note. */
  query?: string
  limit?: number
}

/**
 * Search memos by free-text against label + note. Tencent Maps geocoding
 * fills `label` with the formatted address for `source='geocoded'` rows;
 * agent-driven /location with a note fills `label` directly. Empty query
 * falls back to plain recency listing (= listMemos).
 *
 * The query is treated as a single token; no tokenization, no multi-term
 * AND. For "find my car" use `query='车'`. Wildcards ('%' '_') in the
 * query are escaped to literal characters via `LIKE ESCAPE`.
 */
export function searchMemos(opts: SearchOpts = {}): LocationMemo[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50)
  const q = (opts.query ?? '').trim()
  if (!q) return listMemos({ userId: opts.userId, limit })
  // Escape SQL LIKE wildcards so a query containing % or _ matches literally.
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`)
  const pattern = `%${escaped}%`
  return helper.safe((d) => {
    if (opts.userId) {
      return d.prepare(
        `SELECT * FROM location_memos
         WHERE user_id = ? AND (label LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')
         ORDER BY id DESC LIMIT ?`,
      ).all(opts.userId, pattern, pattern, limit) as LocationMemo[]
    }
    return d.prepare(
      `SELECT * FROM location_memos
       WHERE label LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\'
       ORDER BY id DESC LIMIT ?`,
    ).all(pattern, pattern, limit) as LocationMemo[]
  }, [])
}

export function getMemo(id: number, opts: OwnerOpts = {}): LocationMemo | null {
  return helper.safe((d) => {
    const row = opts.userId
      ? d.prepare('SELECT * FROM location_memos WHERE id = ? AND user_id = ?').get(id, opts.userId)
      : d.prepare('SELECT * FROM location_memos WHERE id = ?').get(id)
    return (row as LocationMemo | undefined) ?? null
  }, null)
}

export function deleteMemo(id: number, opts: OwnerOpts = {}): boolean {
  return helper.safe((d) => {
    const stmt = opts.userId
      ? d.prepare('DELETE FROM location_memos WHERE id = ? AND user_id = ?')
      : d.prepare('DELETE FROM location_memos WHERE id = ?')
    const r = opts.userId ? stmt.run(id, opts.userId) : stmt.run(id)
    return r.changes > 0
  }, false)
}

export function closeLocationsDb(): void {
  helper.close()
}

// ─── Coordinate parsing ─────────────────────────────────────────────────

/**
 * Parse "39.908,116.397" or "39.908 116.397" or "39.908, 116.397".
 * Returns null if the input doesn't look like a coord pair (caller falls back
 * to geocoding). Latitude first, longitude second — matches WGS84 convention
 * and Tencent Maps URI scheme.
 */
export function parseCoordPair(input: string): { lat: number; lng: number } | null {
  const trimmed = input.trim()
  // Match "<float> [,] <float>" with optional sign and optional space.
  const m = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\b/)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

/** Strip the matched coord prefix and return the rest (the memo text). */
export function stripCoordPrefix(input: string): string {
  return input.replace(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\b\s*/, '').trim()
}

// ─── Geocoding (Baidu Maps) ────────────────────────────────────────────
// Why Baidu (not Tencent): Tencent's WebGL JS API requires commercial
// licensing per their console. Baidu's server-side AK works with default
// quota and no SN signing required for most key configs (verified live
// 2026-05-10). Coordinate system: we always request ret_coordtype=wgs84ll
// to keep storage consistent with browser geolocation output.
//
// If you re-enable SN 校验 in Baidu's console, sign per:
//   sn = MD5(URLencode(path?queryString + sk))
// Doc: https://lbsyun.baidu.com/faq/api?title=webapi/appendix
// Not implemented here because the default key flow doesn't need it.

interface BaiduGeocodeResponse {
  status: number
  message?: string
  msg?: string
  result?: {
    location?: { lng: number; lat: number }
    precise?: number
    confidence?: number
    comprehension?: number
    level?: string
  }
}

export interface GeocodeResult {
  lat: number
  lng: number
  formattedAddress: string
}

/** Discriminated outcome surface for geocoding. Lets the command layer give
 *  precise error messages (quota exceeded vs. address not found vs. wrong key
 *  config) instead of a generic "找不到" for every non-success case. */
export type GeocodeOutcome =
  | { ok: true; lat: number; lng: number; formattedAddress: string }
  | { ok: false; reason: 'no_key' | 'quota' | 'signature' | 'not_found' | 'http' | 'unknown'; status?: number; message?: string }

type GeocodeFailReason = 'no_key' | 'quota' | 'signature' | 'not_found' | 'http' | 'unknown'

/** Map Baidu's response status codes to our reason taxonomy.
 *  Codes per https://lbsyun.baidu.com/faq/api?title=webapi/appendix . */
function classifyStatus(status: number): GeocodeFailReason {
  // 0 = success.
  // 1 = ServerInternalError (catch-all). 2 = ParameterInvalid.
  // 3,4 = AddressInvalid / could not geocode.
  // 5 = AppKey/ServiceForbidden. 200/201/202 = SN校验 / Referer / IP 限制.
  // 210/211/220/240 = AK 配置 / 配额 family.
  // 401-405 = 频次/天配额超限.
  if (status === 1 || status === 2 || status === 3 || status === 4) return 'not_found'
  if (status === 200 || status === 201 || status === 202) return 'signature'
  if (status >= 401 && status <= 405) return 'quota'
  if (status === 240 || status === 220 || status === 211 || status === 210) return 'quota'
  if (status === 5) return 'signature'
  return 'unknown'
}

/** Geocode a free-text address via Baidu Maps. Discriminated outcome so the
 *  command can give precise feedback (quota / signature / not-found / etc). */
export async function geocodeAddress(address: string): Promise<GeocodeOutcome> {
  const ak = process.env.IMHUB_BAIDU_MAP_AK
  if (!ak) {
    log.debug({ event: 'locations.geocode.no_key' }, 'Baidu map AK not set; skipping geocode')
    return { ok: false, reason: 'no_key' }
  }
  const url = new URL('https://api.map.baidu.com/geocoding/v3/')
  url.searchParams.set('address', address)
  url.searchParams.set('output', 'json')
  // Force WGS-84 output — Baidu's native is BD-09; without this the saved
  // coords would be 50–500m offset from where browser geolocation said the
  // user was, breaking distance-based searches and re-display.
  url.searchParams.set('ret_coordtype', 'wgs84ll')
  url.searchParams.set('ak', ak)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(url.toString(), { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) {
      log.warn({ event: 'locations.geocode.http_error', status: res.status })
      return { ok: false, reason: 'http', status: res.status }
    }
    const data = (await res.json()) as BaiduGeocodeResponse
    if (data.status === 0 && data.result?.location) {
      const { lat, lng } = data.result.location
      // Baidu doesn't return a formatted address in geocoding/v3 — just the
      // input address, precision, and confidence. Use the raw input as-is
      // for the memo's display label; users can rename later via /location.
      return { ok: true, lat, lng, formattedAddress: address }
    }
    const reason = classifyStatus(data.status)
    const message = data.message || data.msg
    log.info({
      event: 'locations.geocode.miss',
      status: data.status, reason, message, address,
    })
    return { ok: false, reason, status: data.status, message }
  } catch (err) {
    log.warn({
      event: 'locations.geocode.failed',
      err: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'unknown', message: err instanceof Error ? err.message : String(err) }
  }
}

export function isGeocodingAvailable(): boolean {
  return !!process.env.IMHUB_BAIDU_MAP_AK
}

// ─── Map URL builder ────────────────────────────────────────────────────

/**
 * Build a Baidu Maps URI scheme link. Tappable in WeChat: opens the Baidu
 * Maps mini-program / web / native app depending on what's installed.
 *
 * `coord_type=wgs84` is critical — our stored coords are WGS-84 (browser
 * geolocation native, Baidu geocoder forced via ret_coordtype). Without
 * this, Baidu interprets them as BD-09 and shows the marker 50–500m off.
 */
export function mapUrl(lat: number, lng: number, label = '', addr = ''): string {
  const url = new URL('https://api.map.baidu.com/marker')
  url.searchParams.set('location', `${lat},${lng}`)
  if (label) url.searchParams.set('title', label)
  if (addr) url.searchParams.set('content', addr)
  url.searchParams.set('output', 'html')
  url.searchParams.set('coord_type', 'wgs84')
  url.searchParams.set('src', 'imhub')
  return url.toString()
}
