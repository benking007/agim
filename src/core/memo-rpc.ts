// memo-rpc.ts — RPC handlers for agent-initiated memo operations.
//
// Replaces the old location-rpc.ts. Generalized from "geo memos" to
// arbitrary 5W1H records. Five ops:
//
//   save              create a memo with whatever 5W1H fields the agent
//                     extracted from the user's natural language
//   request_capture   issue a one-time URL for browser GPS capture; can
//                     either create a NEW memo on capture (pass `what`) or
//                     UPDATE an existing memo (pass `memo_id`)
//   search            query existing memos by free-text + structured
//                     filters (who / what / has_location / when range)
//   update            patch an existing memo (e.g. user added context)
//   delete            drop one memo by id

import { logger as rootLogger } from './logger.js'
import {
  createMemo, getMemo, updateMemo, deleteMemo, searchMemos, listMemos,
  geocodeAddress, isGeocodingAvailable, mapUrl, mapUrls,
  toSqliteLocal,
  type Memo, type MemoSource,
} from './memos.js'
import { issueToken } from './location-token.js'
import type { RunContext } from './approval-bus.js'

const log = rootLogger.child({ component: 'memo-rpc' })

const DEFAULT_LOC_BASE_URL = 'https://agent.iclaw.host'

export type MemoOp = 'save' | 'request_capture' | 'search' | 'update' | 'delete'

export type MemoRpcResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

export async function handleMemoOp(
  op: string,
  payload: Record<string, unknown>,
  ctx: RunContext,
): Promise<MemoRpcResult> {
  try {
    switch (op) {
      case 'save':            return await handleSave(payload, ctx)
      case 'request_capture': return handleRequestCapture(payload, ctx)
      case 'search':          return handleSearch(payload, ctx)
      case 'update':          return await handleUpdate(payload, ctx)
      case 'delete':          return handleDelete(payload, ctx)
      default: return { ok: false, error: `unknown op: ${op}` }
    }
  } catch (err) {
    log.warn({ event: 'rpc.unhandled', err: err instanceof Error ? err.message : String(err) })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Compute expires_at from `expires_in_hours`, or null for permanent.
 *  Output shape matches the rest of the storage: UTC+8 wall-clock,
 *  "YYYY-MM-DD HH:MM:SS" — so comparison against the sweep's
 *  `datetime('now', '+8 hours')` is well-defined. */
function expiresAtFrom(expiresInHours: unknown): string | null {
  if (typeof expiresInHours !== 'number' || !Number.isFinite(expiresInHours) || expiresInHours <= 0) {
    return null
  }
  return toSqliteLocal(Date.now() + expiresInHours * 3600_000)
}

/** Public-facing summary of a memo (camelCase, only-set fields, includes
 *  rendered map links if where_lat is set). The agent uses this to compose
 *  reply text for the user. */
function summarizeMemo(m: Memo): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    what: m.what,
    source: m.source,
    createdAt: m.created_at,
  }
  if (m.who) out.who = m.who
  if (m.when_at) out.whenAt = m.when_at
  if (m.when_text) out.whenText = m.when_text
  if (m.where_lat != null && m.where_lng != null) {
    out.where = {
      lat: m.where_lat,
      lng: m.where_lng,
      label: m.where_label || undefined,
      mapUrl: mapUrl(m.where_lat, m.where_lng, m.where_label || m.what, ''),
      mapUrls: mapUrls(m.where_lat, m.where_lng, m.where_label || m.what, ''),
      // Plan C (2026-05-22): tell the calling agent to surface the
      // "marker off? reply #wgs/#gcj/#bd" hint to the user. The agent
      // composes its own IM reply; this gives it the exact phrasing
      // so users learn the recovery path. The bot's router auto-detects
      // those tags (see core/router.ts:parseMessage + commands/coord.ts).
      coordHint: '若 marker 偏移：回复 #wgs / #gcj / #bd 即可记住坐标系并自动重生成最近一条 memo 的地图链接。',
    }
  }
  if (m.how) out.how = m.how
  if (m.why) out.why = m.why
  if (m.memo) out.memo = m.memo
  if (m.expires_at) out.expiresAt = m.expires_at
  return out
}

// ─── save ───────────────────────────────────────────────────────────────

async function handleSave(payload: Record<string, unknown>, ctx: RunContext): Promise<MemoRpcResult> {
  if (!ctx.userId) return { ok: false, error: 'no userId in run context' }
  const what = typeof payload.what === 'string' ? payload.what.trim() : ''
  if (!what) return { ok: false, error: 'what is required' }

  const who       = typeof payload.who === 'string' ? payload.who.trim().slice(0, 80) : null
  const whenAt    = typeof payload.when_at === 'string' ? payload.when_at : null
  const whenText  = typeof payload.when_text === 'string' ? payload.when_text.trim().slice(0, 80) : null
  const how       = typeof payload.how === 'string' ? payload.how.trim().slice(0, 200) : null
  const why       = typeof payload.why === 'string' ? payload.why.trim().slice(0, 200) : null
  const memo      = typeof payload.memo === 'string' ? payload.memo.trim().slice(0, 1000) : null

  // Location: accept either coords directly OR a geocodable address.
  let whereLat: number | null = typeof payload.where_lat === 'number' ? payload.where_lat : null
  let whereLng: number | null = typeof payload.where_lng === 'number' ? payload.where_lng : null
  let whereLabel: string | null = typeof payload.where_label === 'string' ? payload.where_label.trim().slice(0, 120) : null
  const address = typeof payload.address === 'string' ? payload.address.trim() : ''
  let source: MemoSource = 'agent'

  if ((whereLat == null || whereLng == null) && address) {
    if (!isGeocodingAvailable()) {
      return { ok: false, error: 'geocoding not configured (AGIM_BAIDU_MAP_AK unset). Pass where_lat/where_lng directly.' }
    }
    const geo = await geocodeAddress(address)
    if (!geo.ok) {
      return { ok: false, error: `geocode failed: ${geo.reason}${geo.message ? ` (${geo.message})` : ''}` }
    }
    whereLat = geo.lat
    whereLng = geo.lng
    if (!whereLabel) whereLabel = geo.formattedAddress
    source = 'geocoded'
  }

  const expiresAt = expiresAtFrom(payload.expires_in_hours)

  let id: number
  try {
    id = createMemo({
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId,
      what, who, whenAt, whenText,
      whereLat, whereLng, whereLabel,
      how, why, memo,
      expiresAt,
      source,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const m = getMemo(id, { userId: ctx.userId })
  return m ? { ok: true, result: summarizeMemo(m) } : { ok: true, result: { id } }
}

// ─── request_capture ────────────────────────────────────────────────────

interface RequestCaptureResult {
  url: string
  expiresAt: string
  ttlSeconds: number
  what?: string
  memoId?: number
}

function handleRequestCapture(payload: Record<string, unknown>, ctx: RunContext): MemoRpcResult {
  if (!ctx.userId) return { ok: false, error: 'no userId in run context' }

  const what = typeof payload.what === 'string' ? payload.what.trim().slice(0, 80) : ''
  const memoIdRaw = typeof payload.memo_id === 'number' ? payload.memo_id : NaN
  const memoId = Number.isFinite(memoIdRaw) && memoIdRaw > 0 ? memoIdRaw : null

  // If memoId is set, verify the memo exists + belongs to this user before
  // burning a token. Avoids dangling tokens that can never resolve cleanly.
  if (memoId != null) {
    const existing = getMemo(memoId, { userId: ctx.userId })
    if (!existing) {
      return { ok: false, error: `memo #${memoId} not found (or not yours)` }
    }
  }

  const baseUrl = (process.env.AGIM_LOC_BASE_URL || DEFAULT_LOC_BASE_URL).replace(/\/+$/, '')
  const { token, expiresAt, ttlSeconds } = issueToken(
    {
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId,
    },
    {
      what: what || undefined,
      memoId: memoId ?? undefined,
    },
  )
  const result: RequestCaptureResult = {
    url: `${baseUrl}/l/${token}`,
    expiresAt: new Date(expiresAt).toISOString(),
    ttlSeconds,
  }
  if (what) result.what = what
  if (memoId != null) result.memoId = memoId
  return { ok: true, result }
}

// ─── search ─────────────────────────────────────────────────────────────

function handleSearch(payload: Record<string, unknown>, ctx: RunContext): MemoRpcResult {
  if (!ctx.userId) return { ok: false, error: 'no userId in run context' }

  const query = typeof payload.query === 'string' ? payload.query : ''
  const who   = typeof payload.who === 'string' ? payload.who : ''
  const what  = typeof payload.what === 'string' ? payload.what : ''
  const hasLocation = payload.has_location === true
  const whenAfter   = typeof payload.when_after === 'string' ? payload.when_after : undefined
  const whenBefore  = typeof payload.when_before === 'string' ? payload.when_before : undefined
  const includeExpired = payload.include_expired === true
  const limitRaw = typeof payload.limit === 'number' ? payload.limit : 10
  const limit = Math.min(Math.max(Math.floor(limitRaw), 1), 50)

  const rows: Memo[] = searchMemos({
    userId: ctx.userId,
    query, who, what,
    hasLocation,
    whenAfter, whenBefore,
    includeExpired,
    limit,
  })
  return { ok: true, result: { items: rows.map(summarizeMemo) } }
}

// ─── update ─────────────────────────────────────────────────────────────

async function handleUpdate(payload: Record<string, unknown>, ctx: RunContext): Promise<MemoRpcResult> {
  if (!ctx.userId) return { ok: false, error: 'no userId in run context' }
  const id = typeof payload.id === 'number' ? payload.id : NaN
  if (!Number.isFinite(id)) return { ok: false, error: 'id (number) required' }

  // Pass through only the fields the caller actually included, so we can
  // distinguish "set to null" from "leave alone".
  const u: Record<string, unknown> = {}
  if ('what' in payload)        u.what = payload.what
  if ('who' in payload)         u.who = payload.who
  if ('when_at' in payload)     u.whenAt = payload.when_at
  if ('when_text' in payload)   u.whenText = payload.when_text
  if ('where_lat' in payload)   u.whereLat = payload.where_lat
  if ('where_lng' in payload)   u.whereLng = payload.where_lng
  if ('where_label' in payload) u.whereLabel = payload.where_label
  if ('how' in payload)         u.how = payload.how
  if ('why' in payload)         u.why = payload.why
  if ('memo' in payload)        u.memo = payload.memo
  if ('expires_in_hours' in payload) u.expiresAt = expiresAtFrom(payload.expires_in_hours)
  if ('expires_at' in payload && typeof payload.expires_at === 'string') {
    u.expiresAt = payload.expires_at
  }
  if ('expires_at' in payload && payload.expires_at === null) {
    u.expiresAt = null
  }

  // Convenience: agent can pass `address` and we geocode + populate
  // where_lat / where_lng / where_label in one shot. This is the "user
  // told me 'X 路 Y 号', augment the existing memo" path that follows the
  // place-memo proactive prompt. If lat/lng are also explicitly passed,
  // those take precedence (caller knows what they're doing).
  if (typeof payload.address === 'string' && payload.address.trim()) {
    if (u.whereLat === undefined && u.whereLng === undefined) {
      if (!isGeocodingAvailable()) {
        return { ok: false, error: 'geocoding not configured (AGIM_BAIDU_MAP_AK unset). Pass where_lat/where_lng directly.' }
      }
      const geo = await geocodeAddress(payload.address.trim())
      if (!geo.ok) {
        return { ok: false, error: `geocode failed: ${geo.reason}${geo.message ? ` (${geo.message})` : ''}` }
      }
      u.whereLat = geo.lat
      u.whereLng = geo.lng
      // Only set where_label from geocoder if the caller didn't explicitly
      // override it — preserves user-typed labels like "老孙家".
      if (u.whereLabel === undefined) u.whereLabel = geo.formattedAddress
    }
  }

  let changed = false
  try {
    changed = updateMemo(id, u, { userId: ctx.userId })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (!changed) return { ok: false, error: `memo #${id} not found, not yours, or no fields to change` }
  const m = getMemo(id, { userId: ctx.userId })
  return m ? { ok: true, result: summarizeMemo(m) } : { ok: true, result: { id, updated: true } }
}

// ─── delete ─────────────────────────────────────────────────────────────

function handleDelete(payload: Record<string, unknown>, ctx: RunContext): MemoRpcResult {
  if (!ctx.userId) return { ok: false, error: 'no userId in run context' }
  const id = typeof payload.id === 'number' ? payload.id : NaN
  if (!Number.isFinite(id)) return { ok: false, error: 'id (number) required' }
  const existing = getMemo(id, { userId: ctx.userId })
  if (!existing) return { ok: false, error: `memo #${id} not found (or not yours)` }
  const dropped = deleteMemo(id, { userId: ctx.userId })
  return {
    ok: true,
    result: {
      id, deleted: dropped,
      what: existing.what,
      who: existing.who,
    },
  }
}

// ─── Re-export listMemos for backwards-compat call sites (none currently) ─
export { listMemos }
