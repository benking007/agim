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

export interface TokenRow {
  id: string
  label: string
  /** sha256 hex of the raw token string. */
  hash: string
  created_at: number
  last_used_at: number | null
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
export function createToken(label: string, opts?: { actor?: string; traceId?: string }): { id: string; raw: string; createdAt: number } {
  const data = readFile()
  const raw = generateRawToken()
  const id = newId()
  const row: TokenRow = {
    id,
    label: label || `token-${data.tokens.length + 1}`,
    hash: sha256Hex(raw),
    created_at: Math.floor(Date.now() / 1000),
    last_used_at: null,
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
        details: { label: row.label },
      })
    } catch { /* best-effort */ }
  })()
  return { id, raw, createdAt: row.created_at }
}

/** List tokens with secrets stripped. */
export function listTokens(): Array<Omit<TokenRow, 'hash'>> {
  return readFile().tokens.map((t) => ({
    id: t.id,
    label: t.label,
    created_at: t.created_at,
    last_used_at: t.last_used_at,
  }))
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

/**
 * First-launch helper. If no token exists and IMHUB_WEB_AUTH !== 'off',
 * create a bootstrap token and surface the raw value to stdout + the pino
 * logger. Idempotent — does nothing if any token already exists. Returns
 * the raw value when generated, null otherwise.
 */
export function bootstrapIfEmpty(): string | null {
  if ((process.env.IMHUB_WEB_AUTH || '').toLowerCase() === 'off') return null
  if (hasAnyToken()) return null
  const t = createToken('bootstrap')
  log.warn({
    event: 'access-token.bootstrap_generated',
    id: t.id,
    msg: 'web auth bootstrap token generated (see stdout for the raw value)',
  })
  const banner = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🔑 Web auth bootstrap token (paste this at /login):',
    '',
    `   ${t.raw}`,
    '',
    `   id    : ${t.id}`,
    `   path  : ${TOKENS_FILE}`,
    '',
    '   Manage tokens later with:  agim token list | create | revoke',
    '   Disable auth entirely with:  IMHUB_WEB_AUTH=off',
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
