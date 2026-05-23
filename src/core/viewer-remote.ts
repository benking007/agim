// v1.2.42 — viewer-remote.ts
//
// Three-mode viewer routing (see viewer-config.ts) — this file is the
// "remote" mode. Upload the full markdown to an external paste server
// and use the URL it returns instead of storing locally + relying on
// the operator's reverse proxy.
//
// Why this mode exists
// --------------------
// Most agim users (especially in mainland China) don't have a public
// domain or a working cloudflared tunnel. Asking them to set up a
// reverse proxy just to make IM long-message links work is a tall
// order. With this mode the maintainer (or a community-hosted
// service) runs ONE paste server, and every agim install POSTs its
// markdown there.
//
// Privacy trade-off
// -----------------
// Activating this mode means the user's agent output LEAVES the host
// over HTTPS. Default is OFF; users opt in via env / config. The CLI
// wizard explains this trade-off explicitly.
//
// Wire contract
// -------------
// Request:
//   POST <IMHUB_VIEWER_REMOTE_PASTE_URL>
//   Content-Type: application/json
//   Authorization: Bearer <token>  (optional; sent only when set)
//   Body: { "content": "<markdown>", "source": "<thread-key>",
//           "ttlSeconds": 2592000  // optional TTL hint (30 days)
//         }
//
// Response (2xx):
//   { "url": "https://paste.example/v/<id>" }
//
// Anything else → return null; the sink degrades to inline summary.

import { logger as rootLogger } from './logger.js'
import { getViewerConfig, getEffectiveRemotePasteUrl } from './viewer-config.js'

const log = rootLogger.child({ component: 'viewer-remote' })

const POST_TIMEOUT_MS = 10_000
const MAX_UPLOAD_BYTES = 1_000_000  // 1 MB. Bigger than this, degrade.

export interface PostRemoteOpts {
  content: string
  source?: string
  /** Server-suggested retention. The server is free to clamp or ignore. */
  ttlSeconds?: number
}

/**
 * Upload markdown to the configured remote paste server. Returns the
 * shareable URL on success, null otherwise (caller should degrade).
 *
 * Failure modes that return null (without throwing):
 *   - env not configured
 *   - upload body too large
 *   - network timeout / DNS / 5xx
 *   - non-JSON or missing `url` in response
 *
 * Returns null instead of throwing so the message-sink degradation
 * path is the same as for "no public URL configured at all".
 */
export async function postPasteRemote(opts: PostRemoteOpts): Promise<string | null> {
  const cfg = getViewerConfig()
  const endpoint = getEffectiveRemotePasteUrl(cfg)
  if (!endpoint) return null

  const bytes = Buffer.byteLength(opts.content, 'utf-8')
  if (bytes > MAX_UPLOAD_BYTES) {
    log.warn({
      event: 'viewer.remote.too_large',
      bytes, cap: MAX_UPLOAD_BYTES,
    }, 'markdown too large for remote paste; degrading to inline')
    return null
  }

  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), POST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'agim-cli viewer-remote',
          ...(cfg.remotePasteToken ? { Authorization: `Bearer ${cfg.remotePasteToken}` } : {}),
        },
        body: JSON.stringify({
          content: opts.content,
          source: opts.source,
          ttlSeconds: opts.ttlSeconds,
        }),
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      log.warn({
        event: 'viewer.remote.bad_status',
        status: res.status,
      }, 'remote paste server returned non-2xx')
      return null
    }
    let data: { url?: string }
    try {
      data = await res.json() as { url?: string }
    } catch (err) {
      log.warn({
        event: 'viewer.remote.bad_json',
        err: err instanceof Error ? err.message : String(err),
      }, 'remote paste response was not JSON')
      return null
    }
    if (!data.url || typeof data.url !== 'string' || !/^https?:\/\//.test(data.url)) {
      log.warn({
        event: 'viewer.remote.missing_url',
        sampleKeys: Object.keys(data || {}).slice(0, 5),
      }, 'remote paste response had no usable url field')
      return null
    }
    log.debug({ event: 'viewer.remote.posted', bytes, url: data.url })
    return data.url
  } catch (err) {
    log.warn({
      event: 'viewer.remote.failed',
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
