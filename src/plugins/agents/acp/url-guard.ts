/**
 * Operator-supplied URL safety guard for the ACP REST endpoints.
 *
 * Two operator-controlled paths reach `fetch()` in this codebase:
 *   1. POST /api/agents/acp/discover  → discoverAgents(baseUrl)         (no auth forwarded)
 *   2. POST /api/agents/acp/test      → new ACPClient({endpoint, auth}) (auth IS forwarded)
 *
 * Without validation, an authenticated operator (or someone holding a
 * leaked admin token) could:
 *   * SSRF: probe internal services via http://127.0.0.1:6379/...,
 *     http://169.254.169.254/latest/meta-data/, IPv6 ULA, link-local.
 *   * Credential exfil: send `auth.token` to an attacker-chosen host
 *     (via /test).
 *
 * The guard:
 *   * Enforces http/https scheme (rejects file:, gopher:, etc.).
 *   * For credentialed calls, requires https.
 *   * Resolves the hostname via DNS and refuses loopback, link-local,
 *     and RFC1918 / IPv6 ULA addresses. This catches both a literal IP
 *     (192.168.1.1) and a name that resolves to one
 *     (metadata.internal → 169.254.169.254).
 *
 * Escape hatch: AGIM_ACP_ALLOW_LOOPBACK=1 disables the private-address
 * block. Intended for development against `localhost:<port>` ACP
 * services; never set this in shared deployments.
 *
 * Callers should also pass `redirect: 'manual'` to fetch() so an
 * allowed origin can't 302 the request into a blocked address.
 */

import { lookup } from 'node:dns/promises'

const ALLOW_LOOPBACK_ENV = 'AGIM_ACP_ALLOW_LOOPBACK'

export interface AssertSafeOptions {
  /** When true, only https URLs are accepted (the request will carry a
   *  bearer / apikey token). Drops the http allowance entirely so a
   *  passive on-path observer can't sniff the token. */
  forwardsCredentials: boolean
}

type LookupHost = (hostname: string) => Promise<{ address: string; family: number }>

export class UnsafeAcpUrlError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message)
    this.name = 'UnsafeAcpUrlError'
  }
}

export async function assertSafeAcpUrl(
  raw: string,
  opts: AssertSafeOptions,
  lookupHost: LookupHost = lookup,
): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UnsafeAcpUrlError(`Not a valid URL: ${raw}`, 'url_parse')
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UnsafeAcpUrlError(
      `Scheme '${u.protocol}' not allowed (use http: or https:)`,
      'scheme_blocked',
    )
  }
  if (opts.forwardsCredentials && u.protocol !== 'https:') {
    throw new UnsafeAcpUrlError(
      'https required for credentialed ACP calls',
      'plaintext_credentials',
    )
  }
  if (u.username || u.password) {
    // Don't allow operator-supplied `user:pass@host` — we already pass
    // creds via headers, and the URL form leaks into logs.
    throw new UnsafeAcpUrlError(
      'URL must not embed userinfo',
      'embedded_userinfo',
    )
  }

  // DNS resolve to detect names that point at private space.
  let address: string
  let family: 4 | 6
  try {
    const r = await lookupHost(u.hostname)
    address = r.address
    family = (r.family === 6 ? 6 : 4) as 4 | 6
  } catch (err) {
    throw new UnsafeAcpUrlError(
      `DNS lookup failed for ${u.hostname}: ${err instanceof Error ? err.message : String(err)}`,
      'dns_failed',
    )
  }

  const allowLoopback = process.env[ALLOW_LOOPBACK_ENV] === '1'
  if (isPrivateAddr(address, family) && !allowLoopback) {
    throw new UnsafeAcpUrlError(
      `Address ${address} (${u.hostname}) not allowed — set ${ALLOW_LOOPBACK_ENV}=1 if intentional`,
      'private_address',
    )
  }

  return u
}

/** RFC1918 + loopback + link-local + IPv6 ULA + 0.0.0.0. Exported for
 *  unit tests. */
export function isPrivateAddr(ip: string, family: 4 | 6): boolean {
  if (family === 4) {
    if (ip === '0.0.0.0') return true
    if (/^127\./.test(ip)) return true                       // loopback
    if (/^10\./.test(ip)) return true                        // RFC1918
    if (/^192\.168\./.test(ip)) return true                  // RFC1918
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true   // RFC1918
    if (/^169\.254\./.test(ip)) return true                  // link-local (incl. AWS/GCP metadata 169.254.169.254)
    return false
  }
  // IPv6
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (/^::ffff:/.test(lower)) {
    // IPv4-mapped IPv6 — check the embedded v4
    const v4 = lower.slice(7)
    return isPrivateAddr(v4, 4)
  }
  if (/^f[cd]/.test(lower)) return true   // ULA fc00::/7
  if (/^fe[89ab]/.test(lower)) return true // link-local fe80::/10
  return false
}
