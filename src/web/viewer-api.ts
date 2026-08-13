// viewer-api — Rendered markdown viewer REST surface.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET    /v/:id              → render paste as HTML page (public, unguessable UUID)
//   GET    /api/viewer         → list pastes (newest first)     — admin only
//   GET    /api/viewer/tunnel  → viewer tunnel status            — admin only
//   GET    /api/viewer/:id     → raw JSON of one paste           — admin only
//   DELETE /api/viewer/:id     → remove paste                    — admin only

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from './http-utils.js'
import { requireAdmin } from './auth.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleViewerApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  const viewerMatch = p.match(/^\/v\/([0-9a-f-]{8,})$/i)
  if (viewerMatch && m === 'GET') {
    await handleViewerPage(res, viewerMatch[1]); return true
  }
  if (p === '/api/viewer' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleViewerList(req, res, url); return true
  }
  if (p === '/api/viewer/tunnel' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleViewerTunnelStatus(req, res); return true
  }
  const viewerIdMatch = p.match(/^\/api\/viewer\/([0-9a-f-]{8,})$/i)
  if (viewerIdMatch && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleViewerGet(req, res, viewerIdMatch[1]); return true
  }
  if (viewerIdMatch && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    await handleViewerDelete(req, res, viewerIdMatch[1]); return true
  }
  return false
}

export async function handleViewerPage(res: ServerResponse, id: string): Promise<void> {
  const { getPaste, bumpViewCount } = await import('../core/viewer-local.js')
  const { renderPasteHtml, renderNotFoundHtml } = await import('./viewer-render.js')
  const row = getPaste(id)
  if (!row) {
    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
    })
    res.end(renderNotFoundHtml())
    return
  }
  bumpViewCount(id)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  })
  res.end(renderPasteHtml(row))
}

async function handleViewerList(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { listPastes, countPastes } = await import('../core/viewer-local.js')
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500)
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0)
  const rows = listPastes({ limit, offset })
  const items = rows.map((r) => ({
    id: r.id,
    content_type: r.content_type,
    title: r.title,
    source: r.source,
    job_id: r.job_id,
    created_at: r.created_at,
    view_count: r.view_count,
    bytes: Buffer.byteLength(r.content, 'utf8'),
  }))
  sendJson(res, 200, { total: countPastes(), limit, offset, items })
}

async function handleViewerGet(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const { getPaste } = await import('../core/viewer-local.js')
  const row = getPaste(id)
  if (!row) { sendJson(res, 404, { error: 'not_found' }); return }
  // Strip `source` (thread_key / IM user id) even for admin JSON — the
  // public HTML page never needed it, and a leaked UUID must not also
  // leak the originating conversation identity.
  sendJson(res, 200, { ...row, source: undefined })
}

async function handleViewerDelete(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const { deletePaste } = await import('../core/viewer-local.js')
  const ok = deletePaste(id)
  if (!ok) { sendJson(res, 404, { error: 'not_found' }); return }
  sendJson(res, 200, { ok: true })
}

async function handleViewerTunnelStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { getTunnelStatus } = await import('../core/tunnel.js')
  const { getViewerConfig, getEffectivePublicBaseUrl } = await import('../core/viewer-config.js')
  const cfg = getViewerConfig()
  const tunnel = getTunnelStatus()
  sendJson(res, 200, {
    enabled: cfg.enabled,
    tunnelMode: cfg.tunnelMode,
    staticPublicUrl: cfg.publicBaseUrl,
    effectivePublicUrl: getEffectivePublicBaseUrl(),
    tunnel,
  })
}
