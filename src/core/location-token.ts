// One-time tokens for the GPS-via-H5 handoff flow.
//
// Lifecycle:
//   1. Agent calls request_location_capture({what} | {memoId}) → issueToken
//   2. Bot sends URL containing token to user → user opens H5 page
//   3. H5 page POSTs { token, lat, lng } → consumeToken(token) → returns
//      ctx + meta (what / memoId). Server then either CREATES a new memo
//      with the supplied what + lat/lng, or UPDATES an existing memo by
//      memoId.
//   4. Server pushes a result message back to the original IM thread,
//      then drops the token.
//
// Stored in-memory only. Process restart drops all pending tokens (10-min
// TTL means worst case is the user re-clicks the bot's request). No
// persistence because the entire feature is opportunistic — losing pending
// tokens on restart is strictly better than persisting them through a
// crash and risking stale state.

import { randomBytes } from 'node:crypto'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'location-token' })

const TOKEN_TTL_MS = 10 * 60 * 1000  // 10 min — long enough that the user
                                      // can switch apps + grant permission.
const TOKEN_BYTES = 9                 // 9 random bytes → 12 base64url chars,
                                      // ~10^16 keyspace (per-process Map cleared
                                      // every 10 min — single-shot, brute-force
                                      // doesn't apply). Halves the URL length
                                      // vs the original 32-hex token, which
                                      // matters for IM-side display.
const SWEEP_INTERVAL_MS = 60 * 1000   // expire-sweep cadence

export interface TokenContext {
  platform: string
  channelId: string
  threadId: string
  userId: string
}

/**
 * Optional metadata the issuer may attach.
 *
 *  - `what`   : label shown on the H5 page and used as the new memo's
 *               `what` field if the token's flow CREATES a memo.
 *  - `memoId` : when set, the H5 callback UPDATES an existing memo's
 *               where_lat / where_lng instead of creating a new one.
 *               Used when agent already created the memo via save_memo
 *               and is now augmenting it with GPS.
 *
 * Server-side only — clients (the H5 page) can READ what/memoId via
 * /api/loc/info but never inject them.
 */
export interface TokenMeta {
  what?: string
  memoId?: number
}

interface StoredToken extends TokenContext {
  token: string
  what: string
  memoId: number | null
  createdAt: number
  expiresAt: number
}

const tokens = new Map<string, StoredToken>()
let sweepTimer: ReturnType<typeof setInterval> | null = null

function startSweepIfNeeded(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    let removed = 0
    for (const [tk, t] of tokens) {
      if (t.expiresAt <= now) {
        tokens.delete(tk)
        removed++
      }
    }
    if (removed > 0) log.debug({ event: 'location-token.sweep', removed, remaining: tokens.size })
  }, SWEEP_INTERVAL_MS)
  // Don't keep the process alive for this — it's purely a cleanup timer.
  sweepTimer.unref()
}

export function issueToken(ctx: TokenContext, meta: TokenMeta = {}): { token: string; expiresAt: number; ttlSeconds: number } {
  startSweepIfNeeded()
  // base64url — 9 bytes → 12 chars, URL-safe, padding stripped.
  const token = randomBytes(TOKEN_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const now = Date.now()
  const expiresAt = now + TOKEN_TTL_MS
  // Cap what size to avoid memory bloat from a malformed caller.
  const what = (meta.what || '').toString().slice(0, 80)
  const memoId = typeof meta.memoId === 'number' && Number.isFinite(meta.memoId) ? meta.memoId : null
  tokens.set(token, { ...ctx, token, what, memoId, createdAt: now, expiresAt })
  log.info({
    event: 'location-token.issued',
    platform: ctx.platform, threadId: ctx.threadId, userId: ctx.userId,
    what: what || undefined,
    memoId: memoId ?? undefined,
    expiresAt: new Date(expiresAt).toISOString(),
  })
  return { token, expiresAt, ttlSeconds: Math.floor(TOKEN_TTL_MS / 1000) }
}

/** Read-only peek — used by GET /api/loc/info so the H5 page can render
 *  "正在记录: <what>" without consuming the token. Returns null when the
 *  token is unknown or expired (auto-evicts expired). */
export function peekToken(token: string): { ctx: TokenContext; what: string; memoId: number | null; expiresAt: number } | null {
  const t = tokens.get(token)
  if (!t) return null
  if (t.expiresAt <= Date.now()) {
    tokens.delete(token)
    return null
  }
  return {
    ctx: { platform: t.platform, channelId: t.channelId, threadId: t.threadId, userId: t.userId },
    what: t.what,
    memoId: t.memoId,
    expiresAt: t.expiresAt,
  }
}

export type ConsumeResult =
  | { ok: true; ctx: TokenContext; what: string; memoId: number | null }
  | { ok: false; reason: 'unknown' | 'expired' }

/**
 * Consume a token — single-shot. After this call, the token is removed
 * from the store regardless of outcome (`expired` tokens are also dropped
 * to prevent retry brute-force scanning).
 */
export function consumeToken(token: string): ConsumeResult {
  const t = tokens.get(token)
  if (!t) {
    log.info({ event: 'location-token.consume.unknown' })
    return { ok: false, reason: 'unknown' }
  }
  tokens.delete(token)
  if (t.expiresAt <= Date.now()) {
    log.info({ event: 'location-token.consume.expired', token: token.slice(0, 8) })
    return { ok: false, reason: 'expired' }
  }
  log.info({
    event: 'location-token.consume.ok',
    platform: t.platform, threadId: t.threadId, userId: t.userId,
    ageMs: Date.now() - t.createdAt,
  })
  return {
    ok: true,
    ctx: { platform: t.platform, channelId: t.channelId, threadId: t.threadId, userId: t.userId },
    what: t.what,
    memoId: t.memoId,
  }
}

/** Test/diagnostic helper. */
export function _pendingCount(): number { return tokens.size }
export function _clearAll(): void { tokens.clear() }
export function _stopSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}
