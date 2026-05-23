// Viewer config — env-driven settings for the long-message render router.
//
// Kept minimal & env-only for v1: the operator sets two variables (a public
// base URL + an enable flag), and the defaults handle everything else. No
// JSON-config schema dance, no on-disk state — change env, restart, done.

import { DEFAULT_THRESHOLDS, type ViewerThresholds } from './render-router.js'
import { getCurrentTunnelUrl } from './tunnel.js'

export type ViewerTunnelMode = 'off' | 'quick'

/**
 * v1.2.42 (#viewer-3-mode) — three ways agim can produce a public URL
 * for long markdown:
 *   - 'remote' : POST to an external paste server that returns the URL
 *                (good for users without their own domain — operator
 *                ships agim-cli with a hosted endpoint preconfigured).
 *   - 'local'  : keep the markdown in this host's viewer.db, serve it
 *                from the web server, and rely on an operator-managed
 *                reverse proxy / public DNS (publicBaseUrl).
 *   - 'tunnel' : same as 'local' for storage; URL comes from
 *                cloudflared quick tunnel. Cloudflared may be blocked
 *                in mainland China (DNS) — we surface that as a setup
 *                hint, not a hard failure.
 *   - 'none'   : nothing usable; sink degrades to inline summary.
 *
 * Mode picker order (first non-empty wins):
 *   remote-paste url → public base url → quick tunnel → none
 */
export type ViewerMode = 'remote' | 'local' | 'tunnel' | 'none'

export interface ViewerConfig {
  /** Master switch. When false, all replies are sent inline regardless of length. */
  enabled: boolean
  /**
   * Public-facing base URL of THIS host's agim web console. Used to build the
   * link returned in IM (`<base>/v/<id>`). When empty we fall back to
   * `http://127.0.0.1:<web_port>` — fine for testing on the same machine, but
   * IM clients on phones will obviously not be able to open it.
   */
  publicBaseUrl: string
  /**
   * Auto-tunnel mode for operators without a public URL.
   *   - 'off'   (default): use publicBaseUrl as-is.
   *   - 'quick': launch cloudflared quick tunnel on startup; URL is
   *              `https://*.trycloudflare.com` and changes per agim restart.
   */
  tunnelMode: ViewerTunnelMode
  /**
   * v1.2.42 — Remote paste-server endpoint. When set, message-sink
   * uploads the full markdown to this URL via HTTP POST instead of
   * storing it in viewer.db, and uses the URL returned by the server
   * for the IM link. Lets users without their own domain still get
   * working viewer links (the operator runs a single hosted paste
   * server for everyone).
   *
   * Wire contract (server side): receive `POST <url>`, body =
   * markdown (text/markdown or application/json {markdown}), respond
   * with JSON `{ url: "https://..." }` for the public link. See
   * `services/viewer-paste/README.md` for a reference implementation.
   */
  remotePasteUrl: string
  /** Optional Bearer token forwarded to the remote paste server. */
  remotePasteToken: string
  /** Char / line / code-block thresholds for routing to web. */
  thresholds: ViewerThresholds
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function getViewerConfig(): ViewerConfig {
  const enabledRaw = (process.env.IMHUB_VIEWER_ENABLED || '').toLowerCase()
  const enabled = enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes'
  const publicBaseUrl = (process.env.IMHUB_VIEWER_PUBLIC_BASE_URL || '').replace(/\/$/, '')
  const tunnelModeRaw = (process.env.IMHUB_VIEWER_TUNNEL_MODE || 'off').toLowerCase()
  const tunnelMode: ViewerTunnelMode = tunnelModeRaw === 'quick' ? 'quick' : 'off'
  const remotePasteUrl = (process.env.IMHUB_VIEWER_REMOTE_PASTE_URL || '').replace(/\/$/, '')
  const remotePasteToken = process.env.IMHUB_VIEWER_REMOTE_PASTE_TOKEN || ''
  return {
    enabled,
    publicBaseUrl,
    tunnelMode,
    remotePasteUrl,
    remotePasteToken,
    thresholds: {
      chars: parsePositiveInt(process.env.IMHUB_VIEWER_CHARS, DEFAULT_THRESHOLDS.chars),
      lines: parsePositiveInt(process.env.IMHUB_VIEWER_LINES, DEFAULT_THRESHOLDS.lines),
      codeLines: parsePositiveInt(process.env.IMHUB_VIEWER_CODE_LINES, DEFAULT_THRESHOLDS.codeLines),
    },
  }
}

/**
 * v1.2.42 — pick the active viewer mode. First non-empty source wins.
 * Exported (and pure) so tests + the wizard show the same answer the
 * sink uses at runtime.
 */
export function resolveViewerMode(cfg: ViewerConfig = getViewerConfig()): ViewerMode {
  if (!cfg.enabled) return 'none'
  if (cfg.remotePasteUrl) return 'remote'
  if (cfg.publicBaseUrl) return 'local'
  if (cfg.tunnelMode === 'quick') return 'tunnel'
  return 'none'
}

/**
 * Resolve the effective public base URL. Order of preference:
 *   1. Explicit IMHUB_VIEWER_PUBLIC_BASE_URL (operator-managed reverse proxy)
 *   2. Auto-tunnel URL if tunnel_mode=quick and cloudflared has acquired a URL
 *   3. Caller-supplied fallback
 *
 * Returns empty string when nothing usable is available.
 */
export function getEffectivePublicBaseUrl(fallback?: string): string {
  const cfg = getViewerConfig()
  if (cfg.publicBaseUrl) return cfg.publicBaseUrl
  if (cfg.tunnelMode === 'quick') {
    const tu = getCurrentTunnelUrl()
    if (tu) return tu
  }
  return (fallback || '').replace(/\/$/, '')
}

/**
 * Build the URL placed in the IM reply for a saved paste. Returns null if
 * no public base URL is configured AND no fallback was provided. Caller
 * should treat null as "viewer can't produce a usable link — degrade".
 */
export function buildPasteUrl(id: string, fallbackBaseUrl?: string): string | null {
  const base = getEffectivePublicBaseUrl(fallbackBaseUrl)
  if (!base) return null
  return `${base.replace(/\/$/, '')}/v/${id}`
}
