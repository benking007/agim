// location-rpc.ts — RPC handlers for agent-initiated location operations.
//
// Mirrors reminder-rpc.ts: the MCP sidecar parses tool calls from the
// agent, sends them as `type:'location'` messages on the bus, and the bus
// delegates to handleLocationOp() here. Keeps approval-bus.ts focused on
// transport.
//
// Four ops:
//   request_capture  → issue a one-time URL the user taps to share GPS
//   save             → store coords (or geocode an address) directly
//   list             → recent or query-matched memos for this user
//   delete           → drop one memo by id

import { logger as rootLogger } from './logger.js'
import {
  createMemo, getMemo, deleteMemo, searchMemos, listMemos,
  geocodeAddress, isGeocodingAvailable, mapUrl,
  type LocationMemo,
} from './locations.js'
import { issueToken } from './location-token.js'
import type { RunContext } from './approval-bus.js'

const log = rootLogger.child({ component: 'location-rpc' })

const DEFAULT_LOC_BASE_URL = 'https://agent.iclaw.host'

export type LocationOp = 'request_capture' | 'save' | 'list' | 'delete'

export type LocationRpcResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

export async function handleLocationOp(
  op: string,
  payload: Record<string, unknown>,
  ctx: RunContext,
): Promise<LocationRpcResult> {
  try {
    switch (op) {
      case 'request_capture': return handleRequestCapture(payload, ctx)
      case 'save':            return handleSave(payload, ctx)
      case 'list':            return handleList(payload, ctx)
      case 'delete':          return handleDelete(payload, ctx)
      default: return { ok: false, error: `unknown op: ${op}` }
    }
  } catch (err) {
    log.warn({ event: 'rpc.unhandled', err: err instanceof Error ? err.message : String(err) })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── request_capture ────────────────────────────────────────────────
// Agent calls this when the user wants to record their CURRENT device
// location ("帮我记一下，我的车停在这"). Returns a one-time URL the agent
// then surfaces in its reply text. The actual coords arrive asynchronously
// via POST /api/loc → memo write → push-back to the IM thread.

interface RequestCaptureResult {
  url: string
  expiresAt: string
  ttlSeconds: number
  note: string
}

function handleRequestCapture(
  payload: Record<string, unknown>,
  ctx: RunContext,
): LocationRpcResult {
  if (!ctx.userId) {
    return { ok: false, error: 'no userId in run context — cannot scope memo to a user' }
  }
  const note = typeof payload.note === 'string' ? payload.note.trim().slice(0, 80) : ''
  const baseUrl = (process.env.IMHUB_LOC_BASE_URL || DEFAULT_LOC_BASE_URL).replace(/\/+$/, '')
  const { token, expiresAt, ttlSeconds } = issueToken(
    {
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId,
    },
    note ? { note } : {},
  )
  const result: RequestCaptureResult = {
    url: `${baseUrl}/loc?t=${token}`,
    expiresAt: new Date(expiresAt).toISOString(),
    ttlSeconds,
    note,
  }
  return { ok: true, result }
}

// ─── save ───────────────────────────────────────────────────────────
// Agent calls this when it ALREADY has coordinates or a geocodable
// address. Saves directly without an H5 round-trip. Useful for:
//   "记一下 39.908,116.397 是我家"  → coords path
//   "记一下国贸三期的位置"           → address path (needs map key)

interface SaveResult {
  id: number
  lat: number
  lng: number
  label: string
  mapUrl: string
  source: LocationMemo['source']
}

async function handleSave(
  payload: Record<string, unknown>,
  ctx: RunContext,
): Promise<LocationRpcResult> {
  if (!ctx.userId) return { ok: false, error: 'no userId in run context' }
  const note = typeof payload.note === 'string' ? payload.note.trim().slice(0, 80) : ''
  const latRaw = payload.lat
  const lngRaw = payload.lng
  const address = typeof payload.address === 'string' ? payload.address.trim() : ''

  let lat: number; let lng: number; let label = ''
  let source: LocationMemo['source'] = 'manual'

  if (typeof latRaw === 'number' && typeof lngRaw === 'number') {
    lat = latRaw; lng = lngRaw
    label = note  // when caller had coords, the human-readable bit is the note
  } else if (address) {
    if (!isGeocodingAvailable()) {
      return { ok: false, error: 'geocoding not configured (IMHUB_TENCENT_MAP_KEY unset). Pass lat/lng directly.' }
    }
    const geo = await geocodeAddress(address)
    if (!geo.ok) {
      return { ok: false, error: `geocode failed: ${geo.reason}${geo.message ? ' (' + geo.message + ')' : ''}` }
    }
    lat = geo.lat; lng = geo.lng
    label = note || geo.formattedAddress
    source = 'geocoded'
  } else {
    return { ok: false, error: 'pass either lat+lng or address' }
  }

  let id: number
  try {
    id = createMemo({
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId,
      lat, lng, label, note,
      source,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const result: SaveResult = {
    id, lat, lng, label, source,
    mapUrl: mapUrl(lat, lng, label || `位置 #${id}`, ''),
  }
  return { ok: true, result }
}

// ─── list / search ──────────────────────────────────────────────────
// Agent calls this when the user asks where they put / parked something
// ("我的车在哪？"). With `query`, fuzzy-matches label + note; without,
// returns recent memos.

interface ListResult {
  items: Array<{
    id: number
    lat: number
    lng: number
    label: string
    note: string
    source: string
    created_at: string
    mapUrl: string
  }>
}

function handleList(
  payload: Record<string, unknown>,
  ctx: RunContext,
): LocationRpcResult {
  if (!ctx.userId) return { ok: false, error: 'no userId in run context' }
  const query = typeof payload.query === 'string' ? payload.query.trim() : ''
  const limitRaw = typeof payload.limit === 'number' ? payload.limit : 10
  const limit = Math.min(Math.max(Math.floor(limitRaw), 1), 50)
  const rows: LocationMemo[] = query
    ? searchMemos({ userId: ctx.userId, query, limit })
    : listMemos({ userId: ctx.userId, limit })
  const result: ListResult = {
    items: rows.map((r) => ({
      id: r.id,
      lat: r.lat,
      lng: r.lng,
      label: r.label,
      note: r.note,
      source: r.source,
      created_at: r.created_at,
      mapUrl: mapUrl(r.lat, r.lng, r.label || r.note || `位置 #${r.id}`, ''),
    })),
  }
  return { ok: true, result }
}

// ─── delete ─────────────────────────────────────────────────────────

function handleDelete(
  payload: Record<string, unknown>,
  ctx: RunContext,
): LocationRpcResult {
  if (!ctx.userId) return { ok: false, error: 'no userId in run context' }
  const id = typeof payload.id === 'number' ? payload.id : NaN
  if (!Number.isFinite(id)) return { ok: false, error: 'id (number) required' }
  // Resolve first so we can return a friendlier message on miss.
  const existing = getMemo(id, { userId: ctx.userId })
  if (!existing) return { ok: false, error: `memo #${id} not found (or not yours)` }
  const dropped = deleteMemo(id, { userId: ctx.userId })
  return { ok: true, result: { id, deleted: dropped, label: existing.label, note: existing.note } }
}
