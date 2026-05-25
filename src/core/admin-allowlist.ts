// Admin allowlist — gates service-management commands (`/restart`, `/stop`,
// natural-language "重启服务", web /api/service/* mutating endpoints).
//
// Source: IMHUB_ADMIN_USERS env, comma-separated `platform:userId` pairs.
// Examples:
//   IMHUB_ADMIN_USERS=wechat-ilink:wxid_abc123,telegram:456789
//   IMHUB_ADMIN_USERS=feishu:ou_xxx
//
// Platform matching is case-insensitive (telegram == Telegram). userId is
// case-sensitive (most IMs use case-sensitive ids).
//
// Default policy when the env is unset: DENY. The previous "open access"
// default was fine for a console at 127.0.0.1, but service-control commands
// can take the bot offline — small users opening their bot to friends would
// otherwise expose `/restart` to anyone. Operators get a clear error message
// telling them how to enable themselves.

import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'admin-allowlist' })

interface Entry {
  platform: string  // lower-cased
  userId: string
}

let cachedEntries: Entry[] | null = null
let cachedRaw = ''
/** Runtime-added admins (from `/setup admin <token>` or web UI). Survives
 *  this process but not restart — `promoteAdmin()` ALSO writes to the env
 *  file so a restart picks them up. */
const runtimeEntries: Entry[] = []

/** Read IMHUB_ADMIN_USERS directly from ~/.agim/env, bypassing systemd's
 *  EnvironmentFile parser. systemd's parser is strict about quoting +
 *  silently drops lines it can't make sense of, so when an operator adds
 *  an admin via /setup admin the env-file write may succeed but the
 *  next service restart loads a partial value (observed 2026-05-25:
 *  env file has wechat,telegram but process.env only sees wechat).
 *  This file-direct fallback runs once per process and merges any
 *  entries the systemd-passed value missed. Returns '' when the file
 *  is missing, unreadable, or has no ADMIN_USERS line. */
let cachedFileRaw: string | null = null
function readFileAdminUsers(): string {
  if (cachedFileRaw !== null) return cachedFileRaw
  cachedFileRaw = ''
  try {
    // Lazy import so unit tests that don't touch admin code don't pay
    // the disk lookup. ENV_FILE is the same path systemd reads.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    const { ENV_FILE } = require('../cli-ui/env-file.js') as { ENV_FILE: string }
    if (!fs.existsSync(ENV_FILE)) return cachedFileRaw
    const raw = fs.readFileSync(ENV_FILE, 'utf-8')
    // Take the LAST IMHUB_ADMIN_USERS= line (matches systemd's
    // last-wins semantics + agim's own readEnvFile object overwrite).
    const lines = raw.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith('IMHUB_ADMIN_USERS=')) {
        cachedFileRaw = line.slice('IMHUB_ADMIN_USERS='.length).trim()
        // Strip surrounding quotes if present (systemd-style).
        if ((cachedFileRaw.startsWith('"') && cachedFileRaw.endsWith('"'))
            || (cachedFileRaw.startsWith("'") && cachedFileRaw.endsWith("'"))) {
          cachedFileRaw = cachedFileRaw.slice(1, -1)
        }
        break
      }
    }
  } catch { /* best-effort */ }
  return cachedFileRaw
}

function parseEnv(raw: string): Entry[] {
  const out: Entry[] = []
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0 || idx === trimmed.length - 1) {
      log.warn({ event: 'admin.allowlist.malformed_entry', entry: trimmed },
        'IMHUB_ADMIN_USERS entry must be platform:userId — skipping')
      continue
    }
    out.push({
      platform: trimmed.slice(0, idx).toLowerCase(),
      userId: trimmed.slice(idx + 1),
    })
  }
  return out
}

function getEntries(): Entry[] {
  // Two sources of truth, both consulted: process.env (systemd's parse
  // of EnvironmentFile + any Environment= override) and the env file
  // read directly via Node fs (sidesteps systemd parser quirks). We
  // dedupe by (platform, userId) so a value present in both doesn't
  // double-count. Runtime entries from promoteAdmin() are layered on
  // top so an in-session add is visible even if the file write race'd.
  const envRaw = process.env.IMHUB_ADMIN_USERS ?? ''
  const fileRaw = readFileAdminUsers()
  // Cache invalidation: re-parse when the env value (process or file)
  // changes. File contents don't change without a restart of this
  // process so cachedFileRaw is one-shot; only process.env can shift
  // (admin-allowlist itself mutates process.env? — no, it doesn't.
  // updateEnvFile DOES touch process.env elsewhere, so be defensive).
  const composite = `${envRaw}${fileRaw}`
  if (composite !== cachedRaw) {
    cachedRaw = composite
    const dedup = new Map<string, Entry>()
    for (const e of [...parseEnv(envRaw), ...parseEnv(fileRaw)]) {
      dedup.set(`${e.platform}:${e.userId}`, e)
    }
    cachedEntries = [...dedup.values()]
  }
  return [...(cachedEntries ?? []), ...runtimeEntries]
}

/** Returns `true` iff there is at least one admin entry, whether from env
 *  or runtime-added via `/setup admin`. When false, the system has no
 *  admin and service-control commands are blanket denied. */
export function isAllowlistConfigured(): boolean {
  return getEntries().length > 0
}

/** Returns `true` iff (platform, userId) appears in the combined env +
 *  runtime allowlist. */
export function isAdmin(platform: string, userId: string | undefined): boolean {
  if (!userId) return false
  const p = platform.toLowerCase()
  return getEntries().some((e) => e.platform === p && e.userId === userId)
}

/** Return a copy of the current admin list (env + runtime). For UI display. */
export function listAdmins(): Array<{ platform: string; userId: string }> {
  return getEntries().map((e) => ({ platform: e.platform, userId: e.userId }))
}

/** Add an admin at runtime: in-memory immediately + persist to env file so
 *  the next restart still has them. Idempotent — duplicates are skipped.
 *  Returns true if added, false if already present. */
export async function promoteAdmin(platform: string, userId: string, opts?: { actor?: string; traceId?: string }): Promise<boolean> {
  if (!userId) throw new Error('userId required')
  const p = platform.toLowerCase()
  if (getEntries().some((e) => e.platform === p && e.userId === userId)) return false

  runtimeEntries.push({ platform: p, userId })

  // Persist to ~/.agim/env (combined env-string of every current entry).
  try {
    const { updateEnvFile } = await import('../cli-ui/env-file.js')
    const combined = getEntries().map((e) => `${e.platform}:${e.userId}`).join(',')
    updateEnvFile({ IMHUB_ADMIN_USERS: combined })
    log.info({
      event: 'admin.allowlist.promoted',
      platform: p,
      userId,
      total: getEntries().length,
    }, 'admin promoted at runtime + persisted to env file')
  } catch (err) {
    log.warn({
      event: 'admin.allowlist.persist_failed',
      err: err instanceof Error ? err.message : String(err),
    }, 'in-memory admin add succeeded but env-file write failed; will be lost on restart')
  }
  // R12 ⑤ — persistent audit row. Tracks who got admin'd, by whom, when.
  try {
    const { logAuditEvent } = await import('./audit-log.js')
    logAuditEvent({
      traceId: opts?.traceId,
      eventType: 'admin.elevate',
      actor: opts?.actor ?? 'system',
      target: `${p}:${userId}`,
      outcome: 'ok',
      details: { total: getEntries().length },
    })
  } catch { /* audit best-effort */ }
  return true
}

/** Localized denial message. Three cases:
 *    A. No admins at all → "首次部署"，引导查 setup token
 *    B. Admins exist, you're not one → 礼貌拒绝，建议联系部署者
 *    C. (handled in setup-command path) bootstrap token consumable → A 已覆盖
 */
export function denialMessage(platform: string, userId: string | undefined): string {
  if (!isAllowlistConfigured()) {
    // Case A — no admin yet. Most likely the operator hasn't onboarded
    // themselves. Tell them where to find the bootstrap token.
    return (
      '🛑 这个 bot 还没配置管理员。\n' +
      '\n' +
      '   如果你是部署者：\n' +
      '   1. 在服务器终端运行 `journalctl -u agim | grep "setup admin"` 查看一次性 token\n' +
      '      （或 `cat ~/.agim/admin-bootstrap-token`）\n' +
      '   2. 在 IM 里发：  /setup admin <token>\n' +
      '   即可把当前账号 (' + platform.toLowerCase() + ':' + (userId ?? '<your-id>') + ') 设为管理员。\n' +
      '\n' +
      '   如果你不是部署者，请联系部署本 bot 的人。'
    )
  }
  // Case B — bot has admins, you're not one. Don't reveal current admin
  // list / internal id format.
  return (
    '🛑 你没有权限执行此操作。\n' +
    '   如果你是这个 bot 的管理员，请用同一个 IM 账号重试；否则请联系部署者。'
  )
}

/** One-shot startup log: how many admins agim resolved from env vs file
 *  vs runtime. Call from cli boot once messengers / web are up so the
 *  line lands in journal with a recognisable event tag. Idempotent. */
let loggedOnce = false
export function logStartupResolution(): void {
  if (loggedOnce) return
  loggedOnce = true
  const envRaw = process.env.IMHUB_ADMIN_USERS ?? ''
  const fileRaw = readFileAdminUsers()
  const envCount = parseEnv(envRaw).length
  const fileCount = parseEnv(fileRaw).length
  const finalCount = getEntries().length
  log.info({
    event: 'admin.allowlist.loaded',
    fromProcessEnv: envCount,
    fromEnvFile: fileCount,
    merged: finalCount,
    fileFallbackActive: fileCount > envCount,
  }, fileCount > envCount
    ? `admin allowlist: process.env had ${envCount}, env file had ${fileCount} — file-fallback recovered ${fileCount - envCount} entries lost by systemd's EnvironmentFile parser`
    : `admin allowlist: ${finalCount} entries loaded`)
}

/** Test-only — reset all state so tests can fully isolate. */
export function _resetCache(): void {
  cachedEntries = null
  cachedRaw = ''
  cachedFileRaw = null
  loggedOnce = false
  runtimeEntries.length = 0
}
