// Access token — token-based authentication for the web console.
//
// Why exist (v1.1.10): the web console used to ship with "no built-in auth"
// (per the comment at the top of web/server.ts). For single-user / locally-
// bound deployments that was fine, but as soon as operators expose the web
// port through a tunnel / reverse proxy, the dashboard becomes anyone-with-
// the-URL territory. This module adds a simple token gate so casual access
// from an exposed URL is blocked.
//
// Storage:
//   ~/.agim/tokens.json — { tokens: [{ id, label, hash, created_at, last_used_at }] }
//   Token raw value is shown to the operator exactly once at create time.
//   Server stores only the sha256 hex digest.
//
// Bootstrap:
//   On first startup, if tokens.json is missing OR empty, generate a single
//   "bootstrap" token, persist its hash, and print the raw value to stdout +
//   the pino logger so the operator finds it in `journalctl -u agim`.
//
// Auth exemptions (the web layer enforces; this module just verifies):
//   - Loopback peers (127.0.0.1 / ::1) bypass auth entirely. Local CLI / curl
//     / browser-on-the-same-host need no token.
//   - /v/:id viewer pages and their direct JSON endpoint are public (the
//     uuidv4 URL is the credential; matches /loc + /l/ pattern).
//   - /api/health is public (liveness probe).
//
// Override:
//   IMHUB_WEB_AUTH=off disables the gate entirely (for operators who do auth
//   at the reverse proxy layer and don't want a second factor).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { AGIM_HOME } from './agim-paths.js'

const TOKENS_FILE = join(AGIM_HOME, 'tokens.json')
const log = rootLogger.child({ component: 'access-token' })

export type TokenRole = 'admin' | 'user'

export interface TokenRow {
  id: string
  label: string
  /** sha256 hex of the raw token string. */
  hash: string
  created_at: number
  last_used_at: number | null
  /** Granted role. Optional on disk for back-compat with pre-R12 token
   *  files — readers MUST treat missing field as 'admin' since that was
   *  the implicit behaviour before role gating landed. New tokens
   *  default to 'admin' too (operator-friendly); the operator can
   *  explicitly demote by passing `role: 'user'` to createToken or via
   *  the PATCH /api/tokens/:id endpoint. */
  role?: TokenRole
}

interface TokenFile {
  tokens: TokenRow[]
}

function readFile(): TokenFile {
  if (!existsSync(TOKENS_FILE)) return { tokens: [] }
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf-8')) as TokenFile
  } catch (err) {
    log.warn({ event: 'access-token.read_failed', err: String(err) },
      'tokens.json corrupt; starting with empty list')
    return { tokens: [] }
  }
}

function writeFile(data: TokenFile): void {
  mkdirSync(dirname(TOKENS_FILE), { recursive: true })
  writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2), 'utf-8')
  try { chmodSync(TOKENS_FILE, 0o600) } catch { /* ignore non-POSIX */ }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex')
}

/** Raw token format: `agim_` + 40 hex chars. Easy to identify in logs. */
export function generateRawToken(): string {
  return 'agim_' + randomBytes(20).toString('hex')
}

function newId(): string {
  return 'tk_' + randomBytes(4).toString('hex')
}

/** Create + persist a new token. Returns the raw value (caller must
 *  surface it to the operator immediately — it is NOT recoverable later). */
export function createToken(label: string, opts?: { actor?: string; traceId?: string; role?: TokenRole }): { id: string; raw: string; createdAt: number; role: TokenRole } {
  const data = readFile()
  const raw = generateRawToken()
  const id = newId()
  const role: TokenRole = opts?.role === 'user' ? 'user' : 'admin'
  const row: TokenRow = {
    id,
    label: label || `token-${data.tokens.length + 1}`,
    hash: sha256Hex(raw),
    created_at: Math.floor(Date.now() / 1000),
    last_used_at: null,
    role,
  }
  data.tokens.push(row)
  writeFile(data)
  // R12 ⑤ — persistent audit row. Label is operator-supplied and
  // intended for display, so it goes into details (not the raw token).
  void (async () => {
    try {
      const { logAuditEvent } = await import('./audit-log.js')
      logAuditEvent({
        traceId: opts?.traceId,
        eventType: 'token.create',
        actor: opts?.actor ?? 'system',
        target: id,
        outcome: 'ok',
        details: { label: row.label, role },
      })
    } catch { /* best-effort */ }
  })()
  return { id, raw, createdAt: row.created_at, role }
}

/** List tokens with secrets stripped. */
export function listTokens(): Array<Omit<TokenRow, 'hash'>> {
  return readFile().tokens.map((t) => ({
    id: t.id,
    label: t.label,
    created_at: t.created_at,
    last_used_at: t.last_used_at,
    role: t.role ?? 'admin',
  }))
}

/** Resolve the role of a token by id. Missing field reads as 'admin'
 *  for back-compat with pre-R12 tokens.json files. */
export function getTokenRole(id: string): TokenRole {
  if (!id) return 'admin'  // empty id never returned by verifyToken; defensive default
  const row = readFile().tokens.find((t) => t.id === id)
  return row?.role ?? 'admin'
}

/** Convenience: true iff the token's role is 'admin'. */
export function isAdminTokenId(id: string): boolean {
  return getTokenRole(id) === 'admin'
}

/** Demote / promote an existing token. Returns true on change. */
export function setTokenRole(id: string, role: TokenRole, opts?: { actor?: string; traceId?: string }): boolean {
  const data = readFile()
  const row = data.tokens.find((t) => t.id === id)
  if (!row) return false
  const prev: TokenRole = row.role ?? 'admin'
  if (prev === role) return false
  row.role = role
  writeFile(data)
  void (async () => {
    try {
      const { logAuditEvent } = await import('./audit-log.js')
      logAuditEvent({
        traceId: opts?.traceId,
        eventType: role === 'admin' ? 'admin.elevate' : 'admin.revoke',
        actor: opts?.actor ?? 'system',
        target: id,
        outcome: 'ok',
        details: { from: prev, to: role, label: row.label },
      })
    } catch { /* best-effort */ }
  })()
  return true
}

/** Revoke (delete) a token by id. Returns true if a row was removed. */
export function revokeToken(id: string, opts?: { actor?: string; traceId?: string }): boolean {
  const data = readFile()
  const before = data.tokens.length
  data.tokens = data.tokens.filter((t) => t.id !== id)
  if (data.tokens.length === before) return false
  writeFile(data)
  void (async () => {
    try {
      const { logAuditEvent } = await import('./audit-log.js')
      logAuditEvent({
        traceId: opts?.traceId,
        eventType: 'token.revoke',
        actor: opts?.actor ?? 'system',
        target: id,
        outcome: 'ok',
      })
    } catch { /* best-effort */ }
  })()
  return true
}

/**
 * Verify a raw token. Updates `last_used_at` on success. Returns the
 * matching row id, or null if no match. Uses timing-safe comparison on
 * the sha256 digest.
 */
export function verifyToken(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null
  const candidate = sha256Hex(raw)
  const data = readFile()
  const cBuf = Buffer.from(candidate, 'hex')
  for (const row of data.tokens) {
    let stored: Buffer
    try {
      stored = Buffer.from(row.hash, 'hex')
    } catch { continue }
    if (stored.length !== cBuf.length) continue
    if (timingSafeEqual(stored, cBuf)) {
      row.last_used_at = Math.floor(Date.now() / 1000)
      try { writeFile(data) } catch { /* don't fail auth on write error */ }
      return row.id
    }
  }
  return null
}

/** True when at least one token is registered. */
export function hasAnyToken(): boolean {
  return readFile().tokens.length > 0
}

/** Cache the raw bootstrap token so a one-shot CLI (`agim token bootstrap`)
 *  can fetch it via an in-process call without parsing stdout. Cleared
 *  after first retrieval. Process-local; never written to disk. */
let _bootstrapRawHolder: { raw: string; id: string } | null = null

/** Consume the in-memory bootstrap-token holder. Intended for interactive
 *  CLI flows that need the raw value once and then drop it. Returns null
 *  after the first call or when no bootstrap happened. */
export function consumeBootstrapTokenRaw(): { raw: string; id: string } | null {
  const v = _bootstrapRawHolder
  _bootstrapRawHolder = null
  return v
}

/**
 * First-launch helper. If no token exists and IMHUB_WEB_AUTH !== 'off',
 * create a bootstrap token. Idempotent — does nothing if any token
 * already exists. Returns the raw value when generated, null otherwise.
 *
 * Compliance note (R13 A3): the raw token value is NEVER written to
 * stdout or pino — both go to journald in systemd deployments where any
 * `journalctl -u agim` reader could harvest the token before the
 * operator consumes it. Instead we:
 *
 *   - print a banner that *points* at tokens.json + invites the
 *     operator to run `agim token bootstrap` (an interactive CLI that
 *     reads the cached value via consumeBootstrapTokenRaw)
 *   - emit a structured log with the id only (no raw)
 *
 * The raw is still returned from this function (callers like the
 * interactive setup may print it directly to their TTY), so existing
 * behaviour for non-systemd installs is preserved.
 */
export function bootstrapIfEmpty(): string | null {
  if ((process.env.IMHUB_WEB_AUTH || '').toLowerCase() === 'off') return null
  if (hasAnyToken()) return null
  const t = createToken('bootstrap', { role: 'admin' })
  _bootstrapRawHolder = { raw: t.raw, id: t.id }
  log.warn({
    event: 'access-token.bootstrap_generated',
    id: t.id,
  }, 'web auth bootstrap token generated (run `agim token bootstrap` on the host to print the raw value once)')
  const banner = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🔑 Web auth bootstrap token generated.',
    '',
    `   id    : ${t.id}`,
    `   file  : ${TOKENS_FILE}  (chmod 0o600)`,
    '',
    '   To retrieve the raw token (one-time, on this host):',
    '       agim token bootstrap',
    '',
    '   Or rotate to a fresh token:',
    '       agim token create <label>',
    '',
    '   Disable auth entirely:  IMHUB_WEB_AUTH=off',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n')
  process.stdout.write(banner)
  return t.raw
}

/** True iff token auth is enabled (env opt-out turned off). */
export function isAuthEnabled(): boolean {
  return (process.env.IMHUB_WEB_AUTH || '').toLowerCase() !== 'off'
}

/** Path to the tokens file (for diagnostics / external tools). */
export const TOKENS_FILE_PATH = TOKENS_FILE
