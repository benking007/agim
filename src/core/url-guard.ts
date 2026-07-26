/**
 * Operator-supplied URL safety guard for outbound HTTP integrations.
 *
 * Callers use this before persisting or fetching user-configured URLs
 * that could otherwise probe internal services or leak credentials.
 *
 * The guard:
 *   * Enforces http/https scheme (rejects file:, gopher:, etc.).
 *   * For credentialed calls, requires https.
 *   * Resolves the hostname via DNS and refuses loopback, link-local,
 *     and RFC1918 / IPv6 ULA addresses.
 *
 * Escape hatch (either env disables the private-address block):
 *   - AGIM_ACP_ALLOW_LOOPBACK=1 — historical name kept for old setups
 *   - AGIM_URL_ALLOW_PRIVATE=1  — shared name for LLM/MCP/local URLs
 * Intended for development against `localhost:<port>` / LAN Ollama etc.;
 * never set these in shared deployments.
 *
 * Callers that `fetch()` the URL should also pass `redirect: 'manual'`
 * so an allowed origin can't 302 the request into a blocked address.
 */

import { lookup } from 'node:dns/promises'

const ALLOW_LOOPBACK_ENV = 'AGIM_ACP_ALLOW_LOOPBACK'
const ALLOW_PRIVATE_ENV = 'AGIM_URL_ALLOW_PRIVATE'

export interface AssertSafeOptions {
  /** When true, only https URLs are accepted because the request carries credentials. */
  forwardsCredentials: boolean
}

type LookupHost = (hostname: string) => Promise<{ address: string; family: number }>

export class UnsafeUrlError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

/** @deprecated Use UnsafeUrlError. */
export const UnsafeAcpUrlError = UnsafeUrlError

export async function assertSafeUrl(
  raw: string,
  opts: AssertSafeOptions,
  lookupHost: LookupHost = lookup,
): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${raw}`, 'url_parse')
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UnsafeUrlError(
      `Scheme '${u.protocol}' not allowed (use http: or https:)`,
      'scheme_blocked',
    )
  }
  if (opts.forwardsCredentials && u.protocol !== 'https:') {
    throw new UnsafeUrlError(
      'https required for credentialed HTTP calls',
      'plaintext_credentials',
    )
  }
  if (u.username || u.password) {
    throw new UnsafeUrlError(
      'URL must not embed userinfo',
      'embedded_userinfo',
    )
  }

  let address: string
  let family: 4 | 6
  try {
    const r = await lookupHost(u.hostname)
    address = r.address
    family = (r.family === 6 ? 6 : 4) as 4 | 6
  } catch (err) {
    throw new UnsafeUrlError(
      `DNS lookup failed for ${u.hostname}: ${err instanceof Error ? err.message : String(err)}`,
      'dns_failed',
    )
  }

  const allowPrivate =
    process.env[ALLOW_LOOPBACK_ENV] === '1'
    || process.env[ALLOW_PRIVATE_ENV] === '1'
  if (isPrivateAddr(address, family) && !allowPrivate) {
    throw new UnsafeUrlError(
      `Address ${address} (${u.hostname}) not allowed — set ${ALLOW_PRIVATE_ENV}=1 `
      + `(or ${ALLOW_LOOPBACK_ENV}=1) if intentional`,
      'private_address',
    )
  }

  return u
}

/** @deprecated Use assertSafeUrl. */
export const assertSafeAcpUrl = assertSafeUrl

/** RFC1918 + loopback + link-local + IPv6 ULA + 0.0.0.0. Exported for unit tests. */
export function isPrivateAddr(ip: string, family: 4 | 6): boolean {
  if (family === 4) {
    if (ip === '0.0.0.0') return true
    if (/^127\./.test(ip)) return true
    if (/^10\./.test(ip)) return true
    if (/^192\.168\./.test(ip)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
    if (/^169\.254\./.test(ip)) return true
    return false
  }
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (/^::ffff:/.test(lower)) {
    const v4 = lower.slice(7)
    return isPrivateAddr(v4, 4)
  }
  if (/^f[cd]/.test(lower)) return true
  if (/^fe[89ab]/.test(lower)) return true
  return false
}
