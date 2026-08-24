// Explicit IM identity ↔ Web user bindings. Separate from im-admins.json.
// Unbound IM users stay fully able to use Agim; bindings only attach
// points / account identity when present.

import { createHash, randomBytes } from 'node:crypto'
import { getUserById } from './accounts.js'
import { mutateAccounts, readAccounts, type ImBindingRow } from './accounts-store.js'

const BIND_TTL_MS = 15 * 60 * 1000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface PublicBinding {
  platform: string
  imUserId: string
  userId: string
  createdAt: number
  createdBy: string
}

export interface BindCode {
  raw: string
  expiresAt: number
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex')
}

function normPlatform(platform: string): string {
  return platform.trim().toLowerCase()
}

function normImUser(userId: string): string {
  return userId.trim()
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

function randomCode(): string {
  const bytes = randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  return out
}

export function issueBindCode(userId: string): BindCode {
  if (!getUserById(userId)) {
    throw Object.assign(new Error('user not found'), { code: 'IM_BIND_NO_USER' })
  }
  const raw = randomCode()
  const expiresAt = Date.now() + BIND_TTL_MS
  mutateAccounts((data) => {
    data.bindCodes = data.bindCodes.filter((c) => c.userId !== userId)
    data.bindCodes.push({ hash: sha256Hex(raw), userId, expiresAt })
  })
  return { raw, expiresAt }
}

export function consumeBindCode(platform: string, imUserId: string, raw: string): PublicBinding {
  const code = (raw || '').trim().toUpperCase()
  if (!code) {
    throw Object.assign(new Error('bind code required'), { code: 'IM_BIND_BAD_CODE' })
  }
  const hash = sha256Hex(code)
  const now = Date.now()
  let userId = ''
  mutateAccounts((data) => {
    const idx = data.bindCodes.findIndex((c) => c.hash === hash)
    if (idx < 0) {
      throw Object.assign(new Error('invalid or expired bind code'), { code: 'IM_BIND_BAD_CODE' })
    }
    const row = data.bindCodes[idx]!
    if (row.expiresAt <= now) {
      data.bindCodes.splice(idx, 1)
      throw Object.assign(new Error('invalid or expired bind code'), { code: 'IM_BIND_BAD_CODE' })
    }
    userId = row.userId
    data.bindCodes.splice(idx, 1)
  })
  return bindImIdentity({
    platform,
    imUserId,
    userId,
    createdBy: userId,
  })
}
