// Viewer config — env-driven settings for the long-message render router.
//
// Kept minimal & env-only for v1: the operator sets two variables (a public
// base URL + an enable flag), and the defaults handle everything else. No
// JSON-config schema dance, no on-disk state — change env, restart, done.

import { DEFAULT_THRESHOLDS, type ViewerThresholds } from './render-router.js'

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
  return {
    enabled,
    publicBaseUrl,
    thresholds: {
      chars: parsePositiveInt(process.env.IMHUB_VIEWER_CHARS, DEFAULT_THRESHOLDS.chars),
      lines: parsePositiveInt(process.env.IMHUB_VIEWER_LINES, DEFAULT_THRESHOLDS.lines),
      codeLines: parsePositiveInt(process.env.IMHUB_VIEWER_CODE_LINES, DEFAULT_THRESHOLDS.codeLines),
    },
  }
}

/**
 * Build the URL placed in the IM reply for a saved paste. Returns null if
 * no public base URL is configured AND no fallback was provided. Caller
 * should treat null as "viewer can't produce a usable link — degrade".
 */
export function buildPasteUrl(id: string, fallbackBaseUrl?: string): string | null {
  const cfg = getViewerConfig()
  const base = cfg.publicBaseUrl || fallbackBaseUrl || ''
  if (!base) return null
  return `${base.replace(/\/$/, '')}/v/${id}`
}
