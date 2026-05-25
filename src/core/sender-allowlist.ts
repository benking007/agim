// sender-allowlist — controls WHO can reach the agent (v1.2.66, P1 #7).
//
// Distinct from `admin-allowlist.ts`:
//   - admin-allowlist:  who can run /restart, /stop, web mutating endpoints
//   - sender-allowlist: who can SEND ANY MESSAGE to the bot at all
//
// Source: IMHUB_ALLOWED_USERS env, comma-separated `platform:userId` pairs.
// Same syntax as IMHUB_ADMIN_USERS:
//   IMHUB_ALLOWED_USERS=telegram:8754479311,wechat-ilink:wxid_abc
//
// **Default policy when env is UNSET: OPEN** (no filtering).
// Rationale: agim is also used by hobbyists / personal bots where the
// IM credentials are themselves the security boundary. Forcing a
// list-or-deny on first run would break every existing deployment.
// Instead, when sender-allowlist is empty, the boot path emits a single
// OPEN_IM_ACCESS warning + a hint about how to lock down.
//
// Set `IMHUB_ALLOWED_USERS=*` to explicitly mark "everyone allowed"
// (suppresses the boot warning while preserving open behaviour).
//
// Platform matching is case-insensitive (telegram == Telegram). userId is
// case-sensitive (most IMs use case-sensitive ids).

import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'sender-allowlist' })

interface Entry {
  platform: string  // lower-cased
  userId: string
}

let cachedEntries: Entry[] | null = null
let cachedRaw = ''
let cachedWildcard = false

function parse(raw: string): { entries: Entry[]; wildcard: boolean } {
  const entries: Entry[] = []
  let wildcard = false
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    if (trimmed === '*') { wildcard = true; continue }
    const idx = trimmed.indexOf(':')
    if (idx <= 0 || idx === trimmed.length - 1) {
      log.warn({ event: 'sender.allowlist.malformed', entry: trimmed },
        'IMHUB_ALLOWED_USERS entry must be platform:userId or "*" — skipping')
      continue
    }
    entries.push({
      platform: trimmed.slice(0, idx).toLowerCase(),
      userId: trimmed.slice(idx + 1),
    })
  }
  return { entries, wildcard }
}

function load(): { entries: Entry[]; wildcard: boolean } {
  const raw = process.env.IMHUB_ALLOWED_USERS ?? ''
  if (raw !== cachedRaw) {
    cachedRaw = raw
    const r = parse(raw)
    cachedEntries = r.entries
    cachedWildcard = r.wildcard
  }
  return { entries: cachedEntries ?? [], wildcard: cachedWildcard }
}

/** Returns `true` iff the env var is set to something non-empty (and
 *  not just whitespace). When false, all senders are allowed. */
export function isSenderAllowlistConfigured(): boolean {
  const { entries, wildcard } = load()
  return wildcard || entries.length > 0
}

/** Returns `true` iff (platform, userId) is allowed to use the bot.
 *  When allowlist is unconfigured: returns `true` (open access).
 *  When `*` is in the list: returns `true` for any caller.
 *  Otherwise: requires exact (platform, userId) match. */
export function isSenderAllowed(platform: string, userId: string | undefined): boolean {
  const { entries, wildcard } = load()
  // Unconfigured → open. The boot-time warning is the operator's nudge.
  if (!wildcard && entries.length === 0) return true
  if (wildcard) return true
  if (!userId) return false
  const p = platform.toLowerCase()
  return entries.some((e) => e.platform === p && e.userId === userId)
}

/** Localized refusal message for IM users. Terse — the bot shouldn't
 *  reveal who IS on the allowlist. */
export function senderDenialMessage(platform: string, userId: string | undefined): string {
  return (
    '🛑 This bot is access-controlled and your account is not on the allowlist.\n' +
    '   If you believe this is wrong, contact the bot operator.\n' +
    `   (Your id: ${platform.toLowerCase()}:${userId ?? '<unknown>'})`
  )
}

/** Startup log — one-shot. Called from cli.ts after the bus is up.
 *  Emits a clear warning when sender allowlist is empty (OPEN_IM_ACCESS),
 *  and a normal info line when configured. */
let loggedOnce = false
export function logStartupResolution(): void {
  if (loggedOnce) return
  loggedOnce = true
  const { entries, wildcard } = load()
  if (wildcard) {
    log.info({
      event: 'sender.allowlist.loaded',
      mode: 'wildcard',
    }, 'sender allowlist: IMHUB_ALLOWED_USERS=* (open access, explicit)')
    return
  }
  if (entries.length === 0) {
    log.warn({
      event: 'sender.allowlist.OPEN_IM_ACCESS',
      hint: 'set IMHUB_ALLOWED_USERS=platform:userId,... to restrict; set =* to suppress this warning',
    }, '⚠ OPEN_IM_ACCESS: anyone who can reach the IM bot can use it (no sender allowlist configured)')
    return
  }
  log.info({
    event: 'sender.allowlist.loaded',
    count: entries.length,
  }, `sender allowlist: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
}

/** Test-only reset. */
export function _resetCache(): void {
  cachedEntries = null
  cachedRaw = ''
  cachedWildcard = false
  loggedOnce = false
}
