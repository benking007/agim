// One-time tokens for the /location here HTTPS handoff flow.
//
// Lifecycle:
//   1. /location here  → issueToken(ctx) → returns { token, expiresAt }
//   2. Bot sends URL containing token to user → user opens H5 page
//   3. H5 page POSTs { token, lat, lng } → consumeToken(token) → returns ctx
//   4. Server uses the resolved ctx to push the result back to the original
//      IM thread, then drops the token.
//
// Stored in-memory only. Process restart drops all pending tokens (10-min
// TTL means worst case is the user re-runs /location here). No persistence
// because the entire feature is opportunistic — losing pending tokens on
// restart is strictly better than persisting them through a crash and
// risking stale state.

import { randomBytes } from 'node:crypto'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'location-token' })

const TOKEN_TTL_MS = 10 * 60 * 1000  // 10 min — long enough that the user
                                      // can switch apps + grant permission.
const TOKEN_BYTES = 16                // 32 hex chars; ~10^38 keyspace, plenty
                                      // for a per-process map cleared every
                                      // 10 min.
const SWEEP_INTERVAL_MS = 60 * 1000   // expire-sweep cadence

export interface TokenContext {
  platform: string
  channelId: string
  threadId: string
  userId: string
}

/** Optional metadata the issuer may attach. The `note` is shown on the H5
 *  page and stored verbatim into the resulting memo's `label` so users see
 *  "已记录'车' ..." instead of "已记录 #N". Server-side only — never trust
 *  the client to set it. */
export interface TokenMeta {
  note?: string
}

interface StoredToken extends TokenContext {
  token: string
  note: string
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
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const now = Date.now()
  const expiresAt = now + TOKEN_TTL_MS
  // Cap note size — H5 page just renders it back; oversize entries waste
  // memory and could be used to bloat tokens.
  const note = (meta.note || '').toString().slice(0, 80)
  tokens.set(token, { ...ctx, token, note, createdAt: now, expiresAt })
  log.info({
    event: 'location-token.issued',
    platform: ctx.platform, threadId: ctx.threadId, userId: ctx.userId,
    note: note || undefined,
    expiresAt: new Date(expiresAt).toISOString(),
  })
  return { token, expiresAt, ttlSeconds: Math.floor(TOKEN_TTL_MS / 1000) }
}

/** Read-only peek at a token's note — used by GET /api/loc/info so the H5
 *  page can show "正在记录: <note>" without consuming the token. Returns
 *  null when the token is unknown or expired. */
export function peekToken(token: string): { ctx: TokenContext; note: string; expiresAt: number } | null {
  const t = tokens.get(token)
  if (!t) return null
  if (t.expiresAt <= Date.now()) {
    tokens.delete(token)
    return null
  }
  return {
    ctx: { platform: t.platform, channelId: t.channelId, threadId: t.threadId, userId: t.userId },
    note: t.note,
    expiresAt: t.expiresAt,
  }
}

export type ConsumeResult =
  | { ok: true; ctx: TokenContext; note: string }
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
    note: t.note,
  }
}

/** Test/diagnostic helper. */
export function _pendingCount(): number { return tokens.size }
export function _clearAll(): void { tokens.clear() }
export function _stopSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}
