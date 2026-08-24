// Explicit IM identity ↔ registered user bindings. Separate from im-admins.json.
// Unbound IM users stay fully able to use Agim; bindings only attach
// points / account identity when present.
// Users claim a channel from the Web console by pasting the IM app/user id.
// If that identity is already bound to someone else, it is rebound.

import { getUserById } from './accounts.js'
import { mutateAccounts, readAccounts, type ImBindingRow } from './accounts-store.js'

export interface PublicBinding {
  platform: string
  imUserId: string
  userId: string
  createdAt: number
  createdBy: string
}

function normPlatform(platform: string): string {
  const p = platform.trim().toLowerCase()
  if (p === 'wechat-ilink' || p === 'weixin') return 'wechat'
  return p
}

function normImUser(userId: string): string {
  return userId.trim().replace(/:usr_[a-z0-9]+$/i, '')
}

function toPublic(row: ImBindingRow): PublicBinding {
  return {
    platform: row.platform,
    imUserId: row.imUserId,
    userId: row.userId,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

export function findBinding(platform: string, imUserId: string): PublicBinding | null {
  const p = normPlatform(platform)
  const u = normImUser(imUserId)
  if (!p || !u) return null
  const row = readAccounts().imBindings.find((b) => b.platform === p && b.imUserId === u)
  return row ? toPublic(row) : null
}

export function listBindings(opts: { userId?: string } = {}): PublicBinding[] {
  return readAccounts().imBindings
    .filter((b) => !opts.userId || b.userId === opts.userId)
    .map(toPublic)
}

export function bindImIdentity(input: {
  platform: string
  imUserId: string
  userId: string
  createdBy: string
}): PublicBinding {
  const p = normPlatform(input.platform)
  const u = normImUser(input.imUserId)
  if (!p || !u) {
    throw Object.assign(new Error('invalid IM identity'), { code: 'IM_BIND_BAD_IDENTITY' })
  }
  if (!getUserById(input.userId)) {
    throw Object.assign(new Error('user not found'), { code: 'IM_BIND_NO_USER' })
  }
  return mutateAccounts((data) => {
    const existing = data.imBindings.find((b) => b.platform === p && b.imUserId === u)
    if (existing && existing.userId !== input.userId) {
      throw Object.assign(new Error('IM identity already bound'), { code: 'IM_BIND_TAKEN' })
    }
    if (existing) return toPublic(existing)
    const row: ImBindingRow = {
      platform: p,
      imUserId: u,
      userId: input.userId,
      createdAt: Date.now(),
      createdBy: input.createdBy,
    }
    data.imBindings.push(row)
    return toPublic(row)
  })
}

/** Claim this IM identity for `userId`. Rebinds if another account already owns it. */
export function claimImIdentity(input: {
  platform: string
  imUserId: string
  userId: string
}): { binding: PublicBinding; replacedUserId: string | null } {
  const p = normPlatform(input.platform)
  const u = normImUser(input.imUserId)
  if (!p || !u) {
    throw Object.assign(new Error('invalid IM identity'), { code: 'IM_BIND_BAD_IDENTITY' })
  }
  if (!getUserById(input.userId)) {
    throw Object.assign(new Error('user not found'), { code: 'IM_BIND_NO_USER' })
  }
  return mutateAccounts((data) => {
    const existing = data.imBindings.find((b) => b.platform === p && b.imUserId === u)
    if (existing && existing.userId === input.userId) {
      return { binding: toPublic(existing), replacedUserId: null }
    }
    const replacedUserId = existing ? existing.userId : null
    data.imBindings = data.imBindings.filter((b) => !(b.platform === p && b.imUserId === u))
    const row: ImBindingRow = {
      platform: p,
      imUserId: u,
      userId: input.userId,
      createdAt: Date.now(),
      createdBy: input.userId,
    }
    data.imBindings.push(row)
    return { binding: toPublic(row), replacedUserId }
  })
}

export function unbindImIdentity(platform: string, imUserId: string, actorUserId?: string): boolean {
  const p = normPlatform(platform)
  const u = normImUser(imUserId)
  return mutateAccounts((data) => {
    const before = data.imBindings.length
    data.imBindings = data.imBindings.filter((b) => {
      if (b.platform !== p || b.imUserId !== u) return true
      if (actorUserId && b.userId !== actorUserId) return true
      return false
    })
    return data.imBindings.length < before
  })
}
