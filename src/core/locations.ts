// Location memos — "I parked my car at <coords>" style notes.
//
// Storage: ~/.im-hub/locations.db (SQLite, fail-soft via sqlite-helper).
// Owner-scoped per (platform, user_id), same pattern as /remind and /cron.
//
// Two input paths:
//   1. Coords:  "/location 39.908,116.397 [memo]"        — zero deps.
//   2. Address: "/location 国贸三期 [memo]"               — needs IMHUB_TENCENT_MAP_KEY.
//
// Render: every memo carries a Tencent Maps URI scheme link
// (https://apis.map.qq.com/uri/v1/marker?...) which opens the user's map app
// (Tencent / WeChat in-app browser / Amap on Android intent dispatch).

import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
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

// ─── Geocoding (Tencent Maps) ──────────────────────────────────────────

interface TencentGeocodeResponse {
  status: number
  message?: string
  result?: {
    location?: { lat: number; lng: number }
    title?: string
    address?: string
    formatted_addresses?: { recommend?: string; rough?: string }
    address_components?: {
      province?: string
      city?: string
      district?: string
      street?: string
      street_number?: string
    }
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

/**
 * Tencent Maps WebService SK signing.
 *
 * Algorithm (verified against the live API): sort params alphabetically by
 * key, build `k=v&...` with **un-URL-encoded** values, concat
 * `path + '?' + raw_qs + sk`, MD5 → 32-char lowercase hex. The actual HTTP
 * request URL still uses URL-encoded values; only the signing input uses raw.
 *
 * If IMHUB_TENCENT_MAP_SK is unset, returns null (= unsigned mode; key must
 * have signature requirement disabled in the lbs.qq.com console).
 */
export function signTencent(path: string, params: Record<string, string>): string | null {
  const sk = process.env.IMHUB_TENCENT_MAP_SK
  if (!sk) return null
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  const rawQs = sorted.map(([k, v]) => `${k}=${v}`).join('&')
  return createHash('md5').update(`${path}?${rawQs}${sk}`).digest('hex')
}

type GeocodeFailReason = 'no_key' | 'quota' | 'signature' | 'not_found' | 'http' | 'unknown'

/** Map Tencent's response status codes to our reason taxonomy.
 *  Codes per https://lbs.qq.com/service/webService/webServiceGuide/status . */
function classifyStatus(status: number): GeocodeFailReason {
  // 0 = success, 1xx = auth/sig family, 3xx = data/quota family
  if (status === 110 || status === 111 || status === 112 || status === 113) return 'signature'
  if (status === 120 || status === 121 || status === 122) return 'quota'
  if (status === 347 || status === 348 || status === 349) return 'not_found'
  return 'unknown'
}

/** Geocode a free-text address via Tencent Maps. Discriminated outcome so the
 *  command can give precise feedback (quota / signature / not-found / etc). */
export async function geocodeAddress(address: string): Promise<GeocodeOutcome> {
  const key = process.env.IMHUB_TENCENT_MAP_KEY
  if (!key) {
    log.debug({ event: 'locations.geocode.no_key' }, 'Tencent map key not set; skipping geocode')
    return { ok: false, reason: 'no_key' }
  }
  const path = '/ws/geocoder/v1/'
  const params: Record<string, string> = { address, key }
  const sig = signTencent(path, params)
  const url = new URL(`https://apis.map.qq.com${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  if (sig) url.searchParams.set('sig', sig)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(url.toString(), { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) {
      log.warn({ event: 'locations.geocode.http_error', status: res.status })
      return { ok: false, reason: 'http', status: res.status }
    }
    const data = (await res.json()) as TencentGeocodeResponse
    if (data.status === 0 && data.result?.location) {
      const { lat, lng } = data.result.location
      const formatted =
        data.result.formatted_addresses?.recommend ??
        data.result.formatted_addresses?.rough ??
        data.result.address ??
        data.result.title ??
        address
      return { ok: true, lat, lng, formattedAddress: formatted }
    }
    const reason = classifyStatus(data.status)
    log.info({
      event: 'locations.geocode.miss',
      status: data.status, reason, message: data.message, address,
    })
    return { ok: false, reason, status: data.status, message: data.message }
  } catch (err) {
    log.warn({
      event: 'locations.geocode.failed',
      err: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'unknown', message: err instanceof Error ? err.message : String(err) }
  }
}

export function isGeocodingAvailable(): boolean {
  return !!process.env.IMHUB_TENCENT_MAP_KEY
}

// ─── Map URL builder ────────────────────────────────────────────────────

/**
 * Build a Tencent Maps URI scheme link. WeChat's in-app browser dispatches
 * `https://apis.map.qq.com/uri/v1/marker?...` to the user's preferred map app
 * (Tencent / Amap / Baidu via Android intent picker on Android; Tencent Maps
 * web on iOS if no app installed).
 */
export function mapUrl(lat: number, lng: number, label = '', addr = ''): string {
  const url = new URL('https://apis.map.qq.com/uri/v1/marker')
  const marker = [`coord:${lat},${lng}`]
  if (label) marker.push(`title:${label}`)
  if (addr) marker.push(`addr:${addr}`)
  url.searchParams.set('marker', marker.join(';'))
  url.searchParams.set('referer', 'imhub')
  return url.toString()
}
