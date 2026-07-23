// memos-api — Memos list/delete + location capture endpoints.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET    /api/loc/info          → peek token for H5 page (public, single-use token)
//   POST   /api/loc               → consume token + record location (public, single-use token)
//   GET    /api/memos             → search / list memos              — admin only
//   DELETE /api/memos/:id         → delete memo by id                — admin only

import type { IncomingMessage, ServerResponse } from 'node:http'
import { logger as rootLogger } from '../core/logger.js'
import { consumeToken, peekToken } from '../core/location-token.js'
import { createMemo, updateMemo, getMemo, mapUrls } from '../core/memos.js'
import { normalizeIncomingCoords } from '../core/coord-systems.js'
import { sink } from '../core/message-sink.js'
import { readBody, sendJson } from './http-utils.js'
import { requireAdmin } from './auth.js'

const log = rootLogger.child({ component: 'web' })

/**
 * Match-and-handle dispatcher for authenticated /api/memos routes.
 * Returns `true` when the request was served; `false` when not matched.
 *
 * The /api/loc routes remain public and are exported as handleLocInfo /
 * handleLocPost for direct call from the server's pre-auth block.
 */
export async function handleMemosApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/memos' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleListMemos(req, res, url); return true
  }
  const memoIdMatch = p.match(/^\/api\/memos\/(\d+)$/)
  if (memoIdMatch && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    await handleDeleteMemo(req, res, Number.parseInt(memoIdMatch[1], 10)); return true
  }
  return false
}

/** GET /api/loc/info?t=… — public peek (does NOT consume the token). */
export async function handleLocInfo(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const tk = url.searchParams.get('t') || ''
  if (!tk) { sendJson(res, 400, { error: 'missing t' }); return }
  const peek = peekToken(tk)
  if (!peek) { sendJson(res, 410, { error: 'token expired or unknown' }); return }
  let augmentLabel: string | undefined
  if (peek.memoId != null) {
    const existing = getMemo(peek.memoId, { userId: peek.ctx.userId })
    if (existing) augmentLabel = existing.what
  }
  sendJson(res, 200, {
    ok: true,
    what: peek.what,
    memoId: peek.memoId ?? undefined,
    augmentLabel,
    expiresAt: new Date(peek.expiresAt).toISOString(),
  })
}

/** POST /api/loc — public; consumes single-use token and records location. */
export async function handleLocPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, res)
  let parsed: { t?: string; lat?: number; lng?: number; accuracy?: number }
  try { parsed = JSON.parse(body) } catch {
    sendJson(res, 400, { error: 'invalid JSON' }); return
  }
  const tk = typeof parsed.t === 'string' ? parsed.t : ''
  const rawLat = typeof parsed.lat === 'number' ? parsed.lat : NaN
  const rawLng = typeof parsed.lng === 'number' ? parsed.lng : NaN
  if (!tk || !Number.isFinite(rawLat) || !Number.isFinite(rawLng)) {
    sendJson(res, 400, { error: '请求体缺少 t / lat / lng' }); return
  }
  if (rawLat < -90 || rawLat > 90 || rawLng < -180 || rawLng > 180) {
    sendJson(res, 400, { error: '坐标超出有效范围' }); return
  }
  const norm = normalizeIncomingCoords('h5-browser-geolocation', rawLat, rawLng)
  const lat = norm.lat
  const lng = norm.lng
  const cr = consumeToken(tk)
  if (!cr.ok) {
    const msg = cr.reason === 'expired' ? '链接已过期，请重新让 bot 发起记录' : '链接无效或已被使用'
    sendJson(res, 410, { error: msg }); return
  }
  const ctx = cr.ctx
  const what = cr.what || ''
  const accuracy = typeof parsed.accuracy === 'number' ? parsed.accuracy : 0

  let memoId: number | null = null
  let displayWhat = what
  try {
    if (cr.memoId != null) {
      const existing = getMemo(cr.memoId, { userId: ctx.userId })
      if (existing) {
        updateMemo(cr.memoId, {
          whereLat: lat,
          whereLng: lng,
        }, { userId: ctx.userId })
        memoId = cr.memoId
        displayWhat = existing.what
      } else {
        memoId = createMemo({
          platform: ctx.platform, channelId: ctx.channelId,
          threadId: ctx.threadId, userId: ctx.userId,
          what: what || '位置',
          whereLat: lat, whereLng: lng,
          source: 'browser',
        })
      }
    } else {
      memoId = createMemo({
        platform: ctx.platform, channelId: ctx.channelId,
        threadId: ctx.threadId, userId: ctx.userId,
        what: what || '位置',
        whereLat: lat, whereLng: lng,
        source: 'browser',
      })
    }
  } catch (err) {
    log.warn({ event: 'web.loc.memo_failed', err: String(err) }, 'failed to write/update memo')
  }

  const idTag = memoId ? `#${memoId}` : ''
  const accTxt = accuracy > 0 ? ` (±${Math.round(accuracy)}m)` : ''
  const headLabel = displayWhat ? `'${displayWhat}'` : ''
  const urls = mapUrls(lat, lng, displayWhat || '当前位置', '')
  const verb = cr.memoId != null ? '已补全' : '已记下'
  const reply = [
    `✅ ${verb}${headLabel} ${idTag}`.trim(),
    `   坐标: ${lat.toFixed(6)}, ${lng.toFixed(6)}${accTxt}`,
    '',
    `   🗺 [百度地图](${urls.baidu}) · [高德地图](${urls.amap}) · [Google](${urls.google})`,
  ].filter(Boolean).join('\n')
  sink.deliver({
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    payload: reply,
    kind: 'text',
  }).catch((err) => {
    log.warn({ event: 'web.loc.dispatch_failed', threadId: ctx.threadId, err: String(err) })
  })

  sendJson(res, 200, { ok: true, id: memoId, lat, lng })
}

async function handleListMemos(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const { searchMemos } = await import('../core/memos.js')
    const query = url.searchParams.get('query') || undefined
    const who = url.searchParams.get('who') || undefined
    const what = url.searchParams.get('what') || undefined
    const hasLocation = url.searchParams.get('has_location') === 'true' ? true : undefined
    const includeExpired = url.searchParams.get('include_expired') === 'true' ? true : undefined
    const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
    const rows = searchMemos({ query, who, what, hasLocation, includeExpired, limit })
    const { mapUrls: makeMapUrls } = await import('../core/memos.js')
    const items = rows.map((m) => {
      const out: Record<string, unknown> = {
        id: m.id,
        platform: m.platform,
        userId: m.user_id,
        what: m.what,
        who: m.who,
        whenAt: m.when_at,
        whenText: m.when_text,
        where_lat: m.where_lat,
        where_lng: m.where_lng,
        where_label: m.where_label,
        how: m.how,
        why: m.why,
        memo: m.memo,
        source: m.source,
        expiresAt: m.expires_at,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      }
      if (m.where_lat != null && m.where_lng != null) {
        out.mapUrls = makeMapUrls(m.where_lat, m.where_lng, m.where_label || m.what, '')
      }
      return out
    })
    sendJson(res, 200, { memos: items })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleDeleteMemo(_req: IncomingMessage, res: ServerResponse, id: number): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) { sendJson(res, 400, { error: 'invalid id' }); return }
  try {
    const { deleteMemo } = await import('../core/memos.js')
    const ok = deleteMemo(id)
    if (!ok) { sendJson(res, 404, { error: `memo #${id} not found` }); return }
    sendJson(res, 200, { ok: true, id })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
