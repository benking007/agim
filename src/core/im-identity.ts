// IM is a channel, not a billing identity.
// Bound channel key: `<platform>:<imUserId>:<registeredUserId>`
// Example: telegram:12345:usr_ab12cd
// Quota always belongs to the registered user. Binding only stamps
// that id onto the IM channel.

import { getUserById } from './accounts.js'
import { findBinding } from './im-bind.js'

const REGISTERED_RE = /^usr_[a-z0-9]+$/i

export function isRegisteredUserId(id: string | undefined): boolean {
  return !!id && REGISTERED_RE.test(id.trim())
}

export interface ImActor {
  /** Raw id on the messenger (telegram user id, discord snowflake, …). */
  imUserId: string
  /** Registered Agim account, when this channel is bound. */
  registeredUserId: string | null
}

function normPlatform(platform: string | undefined): string {
  return (platform || '').trim().toLowerCase()
}

/**
 * Parse an actor string. Accepts raw IM ids, `imId:usr_…`,
 * `platform:imId`, `platform:imId:usr_…`, and bare `usr_…`.
 */
export function parseImActor(platform: string | undefined, userId: string | undefined): ImActor {
  const raw = (userId || '').trim()
  if (!raw) return { imUserId: '', registeredUserId: null }
  if (isRegisteredUserId(raw)) return { imUserId: raw, registeredUserId: raw }

  const parts = raw.split(':').filter((p) => p.length > 0)
  const last = parts[parts.length - 1] || ''
  const p = normPlatform(platform)

  if (isRegisteredUserId(last) && parts.length >= 2) {
    const rest = parts.slice(0, -1)
    if (p && rest[0]?.toLowerCase() === p) rest.shift()
    const imUserId = rest.join(':') || last
    return { imUserId, registeredUserId: last }
  }

  if (p && parts[0]?.toLowerCase() === p) {
    return { imUserId: parts.slice(1).join(':') || raw, registeredUserId: null }
  }
  return { imUserId: raw, registeredUserId: null }
}

/** Actor id stored on RouteContext / MessageContext after bind. */
export function composeImActor(imUserId: string, registeredUserId: string): string {
  return `${imUserId}:${registeredUserId}`
}

/** Full channel key: `telegram:12345:usr_ab12`. */
export function imChannelKey(platform: string, imUserId: string, registeredUserId: string): string {
  return `${normPlatform(platform)}:${imUserId}:${registeredUserId}`
}

function isWebPlatform(platform: string | undefined): boolean {
  return normPlatform(platform) === 'web'
}

/**
 * Stamp the registered user onto an IM identity when a binding exists.
 * Unbound IM stays the raw messenger id — Agim still works, no account to bill.
 * A client-supplied `:usr_…` suffix is ignored unless a binding confirms it.
 */
export function attachRegisteredIdentity(
  platform: string | undefined,
  userId: string | undefined,
): string | undefined {
  if (userId == null) return userId
  const raw = userId.trim()
  if (!raw) return raw
  if (isWebPlatform(platform)) return raw

  const parsed = parseImActor(platform, raw)
  if (!parsed.imUserId) return raw
  if (isRegisteredUserId(parsed.imUserId) && !platform) return parsed.imUserId

  const bound = findBinding(normPlatform(platform), parsed.imUserId)
  if (bound) return composeImActor(parsed.imUserId, bound.userId)
  return parsed.imUserId
}

/** Registered account to bill / scope. Null when this IM channel has no user. */
export function registeredUserIdOf(
  platform: string | undefined,
  userId: string | undefined,
): string | null {
  if (isWebPlatform(platform)) {
    const parsed = parseImActor(platform, userId)
    const id = parsed.registeredUserId || (isRegisteredUserId(parsed.imUserId) ? parsed.imUserId : null)
    if (id && getUserById(id)) return id
    if (id && id.startsWith('web:')) {
      const inner = id.slice(4)
      if (isRegisteredUserId(inner) && getUserById(inner)) return inner
    }
    return null
  }

  const attached = attachRegisteredIdentity(platform, userId)
  const parsed = parseImActor(platform, attached)
  if (parsed.registeredUserId && getUserById(parsed.registeredUserId)) {
    return parsed.registeredUserId
  }
  return null
}
