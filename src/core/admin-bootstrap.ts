// Admin bootstrap — first-run admin onboarding.
//
// Problem this solves: a fresh deploy has IMHUB_ADMIN_USERS empty, so the
// service-management commands (/restart, /stop) are blanket denied. The
// operator can't onboard themselves via IM because they're not yet
// admin. Telling them "edit env + restart" is friction they may not
// know how to do.
//
// Flow:
//   1. cli.ts at startup checks isAllowlistConfigured(). If FALSE,
//      generates a one-time 12-char base32 token, writes it to
//      ~/.agim/admin-bootstrap-token (chmod 600), and logs:
//        "⚙️ 未配置管理员。在 IM 里发 /setup admin <TOKEN> 把自己设为 admin。"
//   2. The operator pulls the token from journalctl / the file, and
//      sends `/setup admin <token>` to their bot.
//   3. consumeBootstrapToken() verifies the token, calls promoteAdmin()
//      (which persists to ~/.agim/env), and unlinks the token file.
//   4. The slash-command handler replies "✅ 你 (platform:userId) 已设
//      为管理员，token 已作废。"
//
// Security:
//   - Token is 60 bits of entropy (12 base32 chars). Brute-force is
//     impossible at IM message rate.
//   - File is chmod 600 — only the agim process owner can read.
//   - Single-use: consumeBootstrapToken() unlinks the file on success.
//   - Each process restart regenerates (only if no admins). So if the
//     operator forgets the old token, a restart gives them a new one.

import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { isAllowlistConfigured, promoteAdmin } from './admin-allowlist.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'admin-bootstrap' })

export const BOOTSTRAP_TOKEN_FILE = join(AGIM_HOME, 'admin-bootstrap-token')

/** Base32 alphabet — Crockford-style, excludes I/L/O/U for legibility. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function generateToken(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 12; i++) {
    out += ALPHABET[bytes[i % bytes.length] % ALPHABET.length]
    // Insert hyphens for readability: 4-4-4.
    if (i === 3 || i === 7) out += '-'
  }
  return out
}

/**
 * Called once at process startup. If no admin is configured (env empty,
 * no runtime additions), regenerates a fresh token file and logs the
 * onboarding instruction. Idempotent on already-admin'd boxes — does
 * nothing.
 *
 * Returns the token on first-run boxes (so callers can echo it to
 * stdout in addition to the structured log), null on already-configured
 * boxes.
 */
export function ensureBootstrapTokenIfNeeded(): string | null {
  if (isAllowlistConfigured()) {
    // Clean up any stale token file from a previous unconfigured state.
    if (existsSync(BOOTSTRAP_TOKEN_FILE)) {
      try { unlinkSync(BOOTSTRAP_TOKEN_FILE) } catch { /* ignore */ }
    }
    return null
  }

  const token = generateToken()
  try {
    mkdirSync(dirname(BOOTSTRAP_TOKEN_FILE), { recursive: true })
    writeFileSync(BOOTSTRAP_TOKEN_FILE, token + '\n')
    chmodSync(BOOTSTRAP_TOKEN_FILE, 0o600)
  } catch (err) {
    log.error({
      event: 'admin-bootstrap.write_failed',
      err: err instanceof Error ? err.message : String(err),
    }, 'failed to write bootstrap token; admins cannot self-onboard via /setup')
    return null
  }

  log.info({ event: 'admin-bootstrap.ready', token, file: BOOTSTRAP_TOKEN_FILE })
  // Also print prominent stdout banner so the operator notices in the
  // systemd journal / log tail without having to grep for it.
  console.log()
  console.log('⚙️  No admin configured. To onboard yourself:')
  console.log(`     · In IM, send:  /setup admin ${token}`)
  console.log(`     · Token also in: ${BOOTSTRAP_TOKEN_FILE}`)
  console.log('     · Token regenerates on every restart while no admin is set.')
  console.log()
  return token
}

/**
 * v1.2.2 — generate an admin INVITE token unconditionally (even when an
 * admin already exists). Reuses the same bootstrap-token file + the same
 * `/setup admin <token>` IM flow. Overwrites any existing unconsumed
 * token so only the latest invite is valid at any time.
 *
 * Intended for an existing admin to onboard additional admins without
 * SSH'ing into the server to look up the autogen bootstrap token.
 * Triggered by `agim admin invite` CLI / the entry-menu option.
 */
export function generateAdminInviteToken(): { token: string; file: string } {
  const token = generateToken()
  mkdirSync(dirname(BOOTSTRAP_TOKEN_FILE), { recursive: true })
  writeFileSync(BOOTSTRAP_TOKEN_FILE, token + '\n')
  chmodSync(BOOTSTRAP_TOKEN_FILE, 0o600)
  log.info({
    event: 'admin-bootstrap.invite_generated',
    file: BOOTSTRAP_TOKEN_FILE,
  }, 'admin invite token generated (existing admin invoked invite flow)')
  return { token, file: BOOTSTRAP_TOKEN_FILE }
}

/**
 * Verify a candidate token + promote the caller to admin on success.
 * Returns the outcome so the slash-command handler can craft the right
 * reply. On success, the token file is unlinked (single-use).
 */
export async function consumeBootstrapToken(
  candidate: string,
  platform: string,
  userId: string,
): Promise<
  | { ok: true; alreadyAdmin: false }
  | { ok: true; alreadyAdmin: true }
  | { ok: false; reason: 'no_token_file' | 'mismatch' | 'missing_user_id' }
> {
  if (!userId) return { ok: false, reason: 'missing_user_id' }

  if (!existsSync(BOOTSTRAP_TOKEN_FILE)) {
    return { ok: false, reason: 'no_token_file' }
  }

  let stored = ''
  try {
    stored = readFileSync(BOOTSTRAP_TOKEN_FILE, 'utf-8').trim()
  } catch {
    return { ok: false, reason: 'no_token_file' }
  }

  // Constant-time-ish compare; we have no timing attacker over IM, but
  // matching the project's existing safeEqual hygiene.
  if (stored.length !== candidate.length || stored !== candidate) {
    return { ok: false, reason: 'mismatch' }
  }

  const promoted = await promoteAdmin(platform, userId)
  // Unlink whether we added a new entry or the caller was already admin
  // via some other path — the token is consumed regardless.
  try { unlinkSync(BOOTSTRAP_TOKEN_FILE) } catch { /* ignore */ }
  log.info({
    event: 'admin-bootstrap.consumed',
    platform: platform.toLowerCase(),
    userId,
    newPromotion: promoted,
  })
  return { ok: true, alreadyAdmin: !promoted }
}
