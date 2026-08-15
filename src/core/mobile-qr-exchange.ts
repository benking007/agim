/**
 * Short-TTL one-time exchange codes for mobile QR login.
 *
 * CR P2c — QR landing URLs used to embed the raw access token in
 * `?t=…` (browser history, Referer, OS screenshot OCR, shared logs).
 * Instead we mint a random code that maps to the raw token for a few
 * minutes and is consumed on first successful exchange.
 *
 * Storage is process-local Map (+ optional disk mirror under AGIM_HOME
 * so a soft restart within TTL can still redeem). Not a durable auth
 * store — revoke the underlying token with `agim token revoke <id>`.
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'

const DEFAULT_TTL_MS = 10 * 60 * 1000
const CODE_BYTES = 24

interface ExchangeRow {
  raw: string
  tokenId: string
  expiresAt: number
}

interface DiskFile {
  version: 1
  entries: Record<string, ExchangeRow>
}

function currentHome(): string {
  return process.env.AGIM_HOME || AGIM_HOME
}

function diskPath(): string {
  return join(currentHome(), 'mobile-qr-exchange.json')
}

const memory = new Map<string, ExchangeRow>()

function prune(): void {
  const now = Date.now()
  for (const [code, row] of memory) {
    if (row.expiresAt <= now) memory.delete(code)
  }
}

function loadDisk(): void {
  const path = diskPath()
  if (!existsSync(path)) return
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DiskFile
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return
    const now = Date.now()
    for (const [code, row] of Object.entries(parsed.entries)) {
      if (row && typeof row.raw === 'string' && row.expiresAt > now) {
        memory.set(code, row)
      }
    }
  } catch {
    // corrupt / race — start empty
  }
}

function persistDisk(): void {
  prune()
  const path = diskPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const entries: Record<string, ExchangeRow> = {}
  for (const [code, row] of memory) entries[code] = row
  const payload = `${JSON.stringify({ version: 1, entries } satisfies DiskFile)}\n`
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, path)
    try { chmodSync(path, 0o600) } catch { /* ignore */ }
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

let loaded = false
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  loadDisk()
}

/** Mint a one-time code for the given raw token. */
export function issueMobileQrExchange(
  raw: string,
  tokenId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): { code: string; expiresAt: number } {
  ensureLoaded()
  prune()
  const code = randomBytes(CODE_BYTES).toString('base64url')
  const expiresAt = Date.now() + Math.max(30_000, ttlMs)
  memory.set(code, { raw, tokenId, expiresAt })
  persistDisk()
  return { code, expiresAt }
}

/** Consume a code (one-shot). Returns null if missing/expired. */
export function consumeMobileQrExchange(code: string): { raw: string; tokenId: string } | null {
  ensureLoaded()
  prune()
  const key = (code || '').trim()
  if (!key) return null
  const row = memory.get(key)
  if (!row) return null
  memory.delete(key)
  persistDisk()
  if (row.expiresAt <= Date.now()) return null
  return { raw: row.raw, tokenId: row.tokenId }
}

/** Test helper — clear in-memory + disk state. */
export function __resetMobileQrExchangeForTesting(): void {
  memory.clear()
  loaded = false
  try { unlinkSync(diskPath()) } catch { /* ignore */ }
}

/** Test helper — mark a code expired without waiting for TTL. */
export function __expireMobileQrExchangeForTesting(code: string): void {
  ensureLoaded()
  const row = memory.get(code)
  if (row) {
    memory.set(code, { ...row, expiresAt: Date.now() - 1 })
    persistDisk()
  }
}
