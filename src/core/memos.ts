// memos.ts — generalized "记下来" memory database.
//
// Each memo carries optional 5W1H fields:
//   what       — the core thing (REQUIRED, the only required column)
//   who        — person / org / role involved
//   when_at    — ISO-8601 local datetime, parseable timestamp
//   when_text  — raw user phrase if not parseable ("明年5月" etc.)
//   where_lat / where_lng / where_label  — geo location (full triple, partial, or none)
//   how        — manner / process
//   why        — reason / motivation
//
// Lifecycle: every row carries an optional `expires_at`. NULL = permanent;
// otherwise a background sweep purges rows past their expiry. Used to make
// transient state (parking spot, today's meeting room) self-clean while
// durable info (birthdays, contacts) persists.
//
// Storage: ~/.im-hub/memos.db (SQLite, fail-soft via sqlite-helper).
// Owner-scoped per (platform, user_id), same pattern as /remind, /cron.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'

const log = rootLogger.child({ component: 'memos' })

const DB_FILE = process.env.IMHUB_MEMOS_DB || join(homedir(), '.im-hub', 'memos.db')

// ─── Time / timezone ───────────────────────────────────────────────────
// All timestamps are stored in UTC+8 (Asia/Shanghai) wall-clock format,
// matching SQLite's `datetime()` shape: "YYYY-MM-DD HH:MM:SS". This keeps
// JS-set values (expires_at, created_at when overridden) and SQL-set
// values (`datetime('now', '+8 hours')` in default + sweep + search)
// lexicographically comparable. UTC+8 matches the deployment's user base
// (CN); for other regions, the offset is overridable via env.

const TZ_OFFSET_HOURS = Number(process.env.IMHUB_TZ_OFFSET_HOURS ?? 8)
const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 3600_000
const TZ_SHIFT_SQL = `'+${TZ_OFFSET_HOURS} hours'`  // for datetime('now', ...)

/** UTC+8 wall-clock as `YYYY-MM-DD HH:MM:SS` — matches SQLite's `datetime()`
 *  output shape so cross-source comparisons are well-defined. */
export function nowSqliteLocal(): string {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}

/** Convert an absolute Date (or ms) to the local-storage shape. */
export function toSqliteLocal(d: Date | number): string {
  const ms = typeof d === 'number' ? d : d.getTime()
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}

/** Normalize whatever the agent passes for `when_at` into our storage shape.
 *  Accepts: bare ISO (assumed already local), ISO with `Z` or `±HH:MM` offset,
 *  or already-normalized "YYYY-MM-DD HH:MM:SS". Output: "YYYY-MM-DD HH:MM:SS"
 *  in UTC+8. Falls through unchanged on parse failure rather than throwing
 *  so an agent typo doesn't kill the save. */
export function normalizeWhenAt(s: string | null | undefined): string | null {
  if (!s) return null
  const trimmed = s.trim()
  if (!trimmed) return null
  // Has explicit TZ marker → parse + convert.
  if (/Z$|[+\-]\d{2}:\d{2}$/.test(trimmed)) {
    const ms = Date.parse(trimmed)
    if (!Number.isFinite(ms)) return trimmed
    return toSqliteLocal(ms)
  }
  // Bare — assume already in our local zone. Normalize T→space, trim ms.
  return trimmed.replace('T', ' ').slice(0, 19)
}

export type MemoSource = 'manual' | 'agent' | 'geocoded' | 'browser'

export interface Memo {
  id: number
  platform: string
  channel_id: string
  thread_id: string
  user_id: string

  what: string
  who: string | null
  when_at: string | null
  when_text: string | null
  where_lat: number | null
  where_lng: number | null
  where_label: string | null
  how: string | null
  why: string | null
  /** Free-text full intent — preserves the user's complete phrasing when
   *  `what` is an extracted short noun. Optional; null when unset. */
  memo: string | null

  expires_at: string | null
  source: MemoSource
  created_at: string
  updated_at: string
}

export interface OwnerOpts {
  /** Scope reads/writes/deletes to this user. Empty = unrestricted (tests
   *  / non-IM callers only). Production calls always pass userId. */
  userId?: string
}

const helper = createSqliteHelper({
  file: DB_FILE,
  component: 'memos',
  logger: rootLogger as never,
  schema: `
    CREATE TABLE IF NOT EXISTS memos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      platform    TEXT    NOT NULL,
      channel_id  TEXT    NOT NULL,
      thread_id   TEXT    NOT NULL,
      user_id     TEXT    NOT NULL DEFAULT '',

      what        TEXT    NOT NULL,
      who         TEXT,
      when_at     TEXT,
      when_text   TEXT,
      where_lat   REAL,
      where_lng   REAL,
      where_label TEXT,
      how         TEXT,
      why         TEXT,
      memo        TEXT,

      expires_at  TEXT,
      source      TEXT    NOT NULL DEFAULT 'agent',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now', '+8 hours')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now', '+8 hours'))
    );
    -- Idempotent migration for DBs that pre-date the memo column. SQLite
    -- doesn't have ADD COLUMN IF NOT EXISTS; the helper's exec ignores
    -- "duplicate column" errors via the migrate hook below.
    CREATE INDEX IF NOT EXISTS idx_memos_user_recent
      ON memos(platform, user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memos_expires
      ON memos(expires_at);
    CREATE INDEX IF NOT EXISTS idx_memos_what  ON memos(what);
    CREATE INDEX IF NOT EXISTS idx_memos_who   ON memos(who);
  `,
  init: (db) => {
    // ALTER TABLE ADD COLUMN — idempotent: catch "duplicate column" and
    // proceed. New DBs already got the column via CREATE TABLE above;
    // old DBs (created before this column existed) get it here.
    try {
      db.exec("ALTER TABLE memos ADD COLUMN memo TEXT")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/duplicate column|already exists/i.test(msg)) throw err
    }
  },
})

// ─── Validation ─────────────────────────────────────────────────────────

function assertCoords(lat: number | null | undefined, lng: number | null | undefined): void {
  if (lat == null && lng == null) return  // both null is fine — no location
  if (lat == null || lng == null) throw new Error('lat and lng must both be set or both null')
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`invalid latitude: ${lat}`)
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error(`invalid longitude: ${lng}`)
}

// ─── Create / Update / Get / Delete ─────────────────────────────────────

export interface CreateMemoInput {
  platform: string
  channelId: string
  threadId: string
  userId?: string

  what: string
  who?: string | null
  whenAt?: string | null
  whenText?: string | null
  whereLat?: number | null
  whereLng?: number | null
  whereLabel?: string | null
  how?: string | null
  why?: string | null
  /** Free-text full intent — preserve user's complete phrasing when `what`
   *  is a shorter extracted noun. Optional. */
  memo?: string | null

  expiresAt?: string | null
  source?: MemoSource
}

export function createMemo(input: CreateMemoInput): number {
  if (!input.what || !input.what.trim()) throw new Error('what is required')
  assertCoords(input.whereLat, input.whereLng)
  const d = helper.get()
  if (!d) throw new Error('memos DB unavailable (sqlite disabled?)')
  const now = nowSqliteLocal()  // UTC+8 wall-clock — same shape as SQLite default
  const whenAt = normalizeWhenAt(input.whenAt)
  const expiresAt = normalizeWhenAt(input.expiresAt) // accept agent-supplied ISO with TZ offset
  const stmt = d.prepare(
    `INSERT INTO memos
       (platform, channel_id, thread_id, user_id,
        what, who, when_at, when_text,
        where_lat, where_lng, where_label,
        how, why, memo,
        expires_at, source,
        created_at, updated_at)
     VALUES (?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?)`,
  )
  const r = stmt.run(
    input.platform, input.channelId, input.threadId, input.userId ?? '',
    input.what.trim().slice(0, 200),
    input.who ?? null,
    whenAt,
    input.whenText ?? null,
    input.whereLat ?? null,
    input.whereLng ?? null,
    input.whereLabel ?? null,
    input.how ?? null,
    input.why ?? null,
    input.memo ?? null,
    expiresAt,
    input.source ?? 'agent',
    now, now,
  )
  log.info({
    event: 'memos.created',
    id: r.lastInsertRowid, platform: input.platform, userId: input.userId,
    what: input.what, hasLocation: input.whereLat != null,
    expiresAt, source: input.source,
  })
  return Number(r.lastInsertRowid)
}

export interface UpdateMemoInput {
  what?: string
  who?: string | null
  whenAt?: string | null
  whenText?: string | null
  whereLat?: number | null
  whereLng?: number | null
  whereLabel?: string | null
  how?: string | null
  why?: string | null
  memo?: string | null
  expiresAt?: string | null
}

/** Patch-style update — only fields explicitly present in the input are
 *  written. Pass `null` to clear a field (vs `undefined` = leave alone). */
export function updateMemo(id: number, input: UpdateMemoInput, opts: OwnerOpts = {}): boolean {
  if (input.what !== undefined && (!input.what || !input.what.trim())) {
    throw new Error('what cannot be empty when updating')
  }
  if (input.whereLat !== undefined || input.whereLng !== undefined) {
    // Only validate if BOTH fields are being set; partial updates of just
    // one half are caller bugs but we don't want to assert against null
    // when the other is being set to null too.
    if (input.whereLat != null && input.whereLng != null) {
      assertCoords(input.whereLat, input.whereLng)
    }
  }

  const d = helper.get()
  if (!d) return false
  const sets: string[] = []
  const args: unknown[] = []
  const setIf = (col: string, val: unknown): void => {
    sets.push(`${col} = ?`)
    args.push(val)
  }
  if (input.what !== undefined)      setIf('what', input.what.trim().slice(0, 200))
  if (input.who !== undefined)       setIf('who', input.who)
  if (input.whenAt !== undefined)    setIf('when_at', input.whenAt === null ? null : normalizeWhenAt(input.whenAt))
  if (input.whenText !== undefined)  setIf('when_text', input.whenText)
  if (input.whereLat !== undefined)  setIf('where_lat', input.whereLat)
  if (input.whereLng !== undefined)  setIf('where_lng', input.whereLng)
  if (input.whereLabel !== undefined) setIf('where_label', input.whereLabel)
  if (input.how !== undefined)       setIf('how', input.how)
  if (input.why !== undefined)       setIf('why', input.why)
  if (input.memo !== undefined)      setIf('memo', input.memo)
  if (input.expiresAt !== undefined) setIf('expires_at', input.expiresAt === null ? null : normalizeWhenAt(input.expiresAt))
  if (sets.length === 0) return false
  // Stamp updated_at with the same UTC+8 shape as create + sweep.
  sets.push(`updated_at = ?`)
  args.push(nowSqliteLocal())

  const where = opts.userId ? 'id = ? AND user_id = ?' : 'id = ?'
  const sql = `UPDATE memos SET ${sets.join(', ')} WHERE ${where}`
  args.push(id)
  if (opts.userId) args.push(opts.userId)

  try {
    const r = d.prepare(sql).run(...args)
    log.info({ event: 'memos.updated', id, fields: sets.length - 1, changed: r.changes > 0 })
    return r.changes > 0
  } catch (err) {
    log.warn({ event: 'memos.update_failed', err: err instanceof Error ? err.message : String(err) })
    return false
  }
}

export function getMemo(id: number, opts: OwnerOpts = {}): Memo | null {
  return helper.safe((d) => {
    const row = opts.userId
      ? d.prepare('SELECT * FROM memos WHERE id = ? AND user_id = ?').get(id, opts.userId)
      : d.prepare('SELECT * FROM memos WHERE id = ?').get(id)
    return (row as Memo | undefined) ?? null
  }, null)
}

export function deleteMemo(id: number, opts: OwnerOpts = {}): boolean {
  return helper.safe((d) => {
    const stmt = opts.userId
      ? d.prepare('DELETE FROM memos WHERE id = ? AND user_id = ?')
      : d.prepare('DELETE FROM memos WHERE id = ?')
    const r = opts.userId ? stmt.run(id, opts.userId) : stmt.run(id)
    return r.changes > 0
  }, false)
}

// ─── List / Search ──────────────────────────────────────────────────────

export interface SearchOpts extends OwnerOpts {
  /** Free-text — matched as `LIKE %query%` against what / who / where_label /
   *  how / why / when_text. Single token; no AND splitting. */
  query?: string
  /** LIKE filter on `who` only. */
  who?: string
  /** LIKE filter on `what` only. */
  what?: string
  /** When true, filter to rows where where_lat IS NOT NULL. */
  hasLocation?: boolean
  /** ISO range on `when_at` (or fall back to `created_at` when when_at is null). */
  whenAfter?: string
  whenBefore?: string
  /** When true, include expired rows in the result. Default: exclude. */
  includeExpired?: boolean
  limit?: number
}

/**
 * Search memos. All filters are AND-combined. Empty filter set returns the
 * most recent memos (= same as listMemos).
 *
 * Sort: `created_at DESC` (newest first). Future: relevance score.
 *
 * Wildcard escaping: SQL LIKE `%` and `_` in the query become literal chars
 * via `LIKE ESCAPE '\\'` — the user's question-mark or percent doesn't blow
 * the search wide open.
 */
export function searchMemos(opts: SearchOpts = {}): Memo[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50)
  const wheres: string[] = []
  const args: unknown[] = []

  if (opts.userId) { wheres.push('user_id = ?'); args.push(opts.userId) }
  if (!opts.includeExpired) {
    // Keep rows where expires_at IS NULL (permanent) OR > now (UTC+8).
    // Comparing UTC+8 stored shape against UTC+8 wall-clock — same TZ both
    // sides, lexicographic compare correct around midnight crossings.
    wheres.push(`(expires_at IS NULL OR expires_at > datetime('now', ${TZ_SHIFT_SQL}))`)
  }
  if (opts.hasLocation) wheres.push('where_lat IS NOT NULL')

  const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)
  if (opts.query?.trim()) {
    const p = `%${escapeLike(opts.query.trim())}%`
    wheres.push(`(
      what LIKE ? ESCAPE '\\' OR who LIKE ? ESCAPE '\\' OR
      where_label LIKE ? ESCAPE '\\' OR how LIKE ? ESCAPE '\\' OR
      why LIKE ? ESCAPE '\\' OR when_text LIKE ? ESCAPE '\\' OR
      memo LIKE ? ESCAPE '\\'
    )`)
    for (let i = 0; i < 7; i++) args.push(p)
  }
  if (opts.who?.trim()) {
    wheres.push(`who LIKE ? ESCAPE '\\'`); args.push(`%${escapeLike(opts.who.trim())}%`)
  }
  if (opts.what?.trim()) {
    wheres.push(`what LIKE ? ESCAPE '\\'`); args.push(`%${escapeLike(opts.what.trim())}%`)
  }
  if (opts.whenAfter) {
    const v = normalizeWhenAt(opts.whenAfter)
    if (v) { wheres.push(`COALESCE(when_at, created_at) >= ?`); args.push(v) }
  }
  if (opts.whenBefore) {
    const v = normalizeWhenAt(opts.whenBefore)
    if (v) { wheres.push(`COALESCE(when_at, created_at) <= ?`); args.push(v) }
  }

  const sql = `SELECT * FROM memos${wheres.length ? ' WHERE ' + wheres.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  args.push(limit)
  return helper.safe((d) => d.prepare(sql).all(...args) as Memo[], [])
}

/** Recent memos for this user. Convenience wrapper around searchMemos. */
export function listMemos(opts: OwnerOpts & { limit?: number } = {}): Memo[] {
  return searchMemos({ userId: opts.userId, limit: opts.limit })
}

// ─── Expiry sweep ───────────────────────────────────────────────────────

let sweepTimer: ReturnType<typeof setInterval> | null = null
const SWEEP_INTERVAL_MS = 5 * 60 * 1000  // every 5 min

export function sweepExpired(): number {
  return helper.safe((d) => {
    const r = d.prepare(
      `DELETE FROM memos WHERE expires_at IS NOT NULL AND expires_at <= datetime('now', ${TZ_SHIFT_SQL})`,
    ).run()
    if (r.changes > 0) log.info({ event: 'memos.sweep', removed: r.changes })
    return r.changes
  }, 0)
}

export function startSweepTimer(): void {
  if (sweepTimer) return
  // First sweep on startup so anything stale from before this process boot
  // gets cleaned promptly; subsequent sweeps every interval.
  sweepExpired()
  sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS)
  sweepTimer.unref()
  log.info({ event: 'memos.sweep_timer_started', intervalMs: SWEEP_INTERVAL_MS })
}

export function stopSweepTimer(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}

export function closeMemosDb(): void {
  stopSweepTimer()
  helper.close()
}

// ─── Coordinate helpers (kept from old locations.ts) ────────────────────

export function parseCoordPair(input: string): { lat: number; lng: number } | null {
  const trimmed = input.trim()
  const m = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\b/)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

export function stripCoordPrefix(input: string): string {
  return input.replace(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\b\s*/, '').trim()
}

// ─── Geocoding (Baidu Maps) ─────────────────────────────────────────────

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

export type GeocodeOutcome =
  | { ok: true; lat: number; lng: number; formattedAddress: string }
  | { ok: false; reason: 'no_key' | 'quota' | 'signature' | 'not_found' | 'http' | 'unknown'; status?: number; message?: string }

type GeocodeFailReason = 'no_key' | 'quota' | 'signature' | 'not_found' | 'http' | 'unknown'

function classifyStatus(status: number): GeocodeFailReason {
  if (status === 1 || status === 2 || status === 3 || status === 4) return 'not_found'
  if (status === 200 || status === 201 || status === 202) return 'signature'
  if (status >= 401 && status <= 405) return 'quota'
  if (status === 240 || status === 220 || status === 211 || status === 210) return 'quota'
  if (status === 5) return 'signature'
  return 'unknown'
}

export async function geocodeAddress(address: string): Promise<GeocodeOutcome> {
  const ak = process.env.IMHUB_BAIDU_MAP_AK
  if (!ak) {
    log.debug({ event: 'memos.geocode.no_key' })
    return { ok: false, reason: 'no_key' }
  }
  const url = new URL('https://api.map.baidu.com/geocoding/v3/')
  url.searchParams.set('address', address)
  url.searchParams.set('output', 'json')
  url.searchParams.set('ret_coordtype', 'wgs84ll')
  url.searchParams.set('ak', ak)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(url.toString(), { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, reason: 'http', status: res.status }
    const data = (await res.json()) as BaiduGeocodeResponse
    if (data.status === 0 && data.result?.location) {
      const { lat, lng } = data.result.location
      return { ok: true, lat, lng, formattedAddress: address }
    }
    const reason = classifyStatus(data.status)
    log.info({ event: 'memos.geocode.miss', status: data.status, reason, address })
    return { ok: false, reason, status: data.status, message: data.message || data.msg }
  } catch (err) {
    return { ok: false, reason: 'unknown', message: err instanceof Error ? err.message : String(err) }
  }
}

export function isGeocodingAvailable(): boolean {
  return !!process.env.IMHUB_BAIDU_MAP_AK
}

// ─── Map URL builders (Baidu / Amap / Google) ───────────────────────────
// Same WGS-84 → provider-coords plumbing as before. Stored coords are always
// WGS-84; each provider URI gets the right coord-type hint.

export function wgs84ToGcj02(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  const A = 6378245.0
  const EE = 0.006693421622965943
  const PI = Math.PI
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat); magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lat: lat + dLat, lng: lng + dLng }
}

function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  const PI = Math.PI
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  r += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  r += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return r
}

function transformLng(x: number, y: number): number {
  const PI = Math.PI
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  r += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  r += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return r
}

export interface MapUrls { baidu: string; amap: string; google: string }

export function mapUrls(lat: number, lng: number, label = '', addr = ''): MapUrls {
  return {
    baidu: buildBaiduUrl(lat, lng, label, addr),
    amap: buildAmapUrl(lat, lng, label),
    google: buildGoogleUrl(lat, lng),
  }
}

export function mapUrl(lat: number, lng: number, label = '', addr = ''): string {
  return buildBaiduUrl(lat, lng, label, addr)
}

function buildBaiduUrl(lat: number, lng: number, label: string, addr: string): string {
  const url = new URL('https://api.map.baidu.com/marker')
  url.searchParams.set('location', `${lat},${lng}`)
  if (label) url.searchParams.set('title', label)
  if (addr) url.searchParams.set('content', addr)
  url.searchParams.set('output', 'html')
  url.searchParams.set('coord_type', 'wgs84')
  url.searchParams.set('src', 'imhub')
  return url.toString()
}

function buildAmapUrl(lat: number, lng: number, label: string): string {
  const gcj = wgs84ToGcj02(lat, lng)
  const url = new URL('https://uri.amap.com/marker')
  url.searchParams.set('position', `${gcj.lng},${gcj.lat}`)
  if (label) url.searchParams.set('name', label)
  url.searchParams.set('src', 'imhub')
  url.searchParams.set('coordinate', 'gaode')
  return url.toString()
}

function buildGoogleUrl(lat: number, lng: number): string {
  const url = new URL('https://www.google.com/maps')
  url.searchParams.set('q', `${lat},${lng}`)
  return url.toString()
}
