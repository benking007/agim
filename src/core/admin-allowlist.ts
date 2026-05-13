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
  const raw = process.env.IMHUB_ADMIN_USERS ?? ''
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedEntries = parseEnv(raw)
  }
  return cachedEntries ?? []
}

/** Returns `true` iff the env is set (regardless of contents). When unset
 *  the system has no admin and service-control commands are blanket denied. */
export function isAllowlistConfigured(): boolean {
  return (process.env.IMHUB_ADMIN_USERS ?? '').trim().length > 0
}

/** Returns `true` iff (platform, userId) appears in IMHUB_ADMIN_USERS. */
export function isAdmin(platform: string, userId: string | undefined): boolean {
  if (!userId) return false
  if (!isAllowlistConfigured()) return false
  const p = platform.toLowerCase()
  return getEntries().some((e) => e.platform === p && e.userId === userId)
}

/** Localized denial message — chosen by the IM platform's typical user
 *  language. Defaults to Chinese since most operators are zh. */
export function denialMessage(platform: string, userId: string | undefined): string {
  if (!isAllowlistConfigured()) {
    return (
      '🛑 服务管理命令未启用。\n' +
      '   要启用，请在环境变量里设置 IMHUB_ADMIN_USERS，例如：\n' +
      `   IMHUB_ADMIN_USERS=${platform.toLowerCase()}:${userId ?? '<your-user-id>'}\n` +
      '   然后重启服务。'
    )
  }
  return '🛑 你没有权限执行服务管理命令。请联系部署者把你加入 IMHUB_ADMIN_USERS 白名单。'
}

/** Test-only — reset the parse cache so env mutations between tests pick up. */
export function _resetCache(): void {
  cachedEntries = null
  cachedRaw = ''
}
