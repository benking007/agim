// Local user accounts: username/password, login sessions, invite codes.
// First registered user is admin. Later registrations require an invite.

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { logger as rootLogger } from './logger.js'
import {
  mutateAccounts,
  readAccounts,
  type InviteRow,
  type LoginSessionRow,
  type UserRole,
  type UserRow,
} from './accounts-store.js'

const log = rootLogger.child({ component: 'accounts' })

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32

const accountAls = new AsyncLocalStorage<{ userId: string }>()

export function runWithAccountUser<T>(userId: string, fn: () => T): T {
  return accountAls.run({ userId }, fn)
}

export function currentAccountUserId(): string | undefined {
  return accountAls.getStore()?.userId
}

export interface PublicUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  createdAt: number
  disabled: boolean
}

export interface CreatedSession {
  raw: string
  expiresAt: number
  user: PublicUser
}

export interface CreatedInvite {
  id: string
  raw: string
  usesLeft: number
  expiresAt: number | null
  monthlyLimit: number | null
  createdAt: number
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex')
}

function newUserId(): string {
  return `usr_${randomBytes(6).toString('hex')}`
}

function newInviteId(): string {
  return `inv_${randomBytes(4).toString('hex')}`
}

function newSessionId(): string {
  return `lgn_${randomBytes(4).toString('hex')}`
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  }).toString('hex')
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = parts[4]
  const expected = parts[5]
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expected) return false
  let actual: string
  try {
    actual = scryptSync(password, salt, expected.length / 2, { N: n, r, p }).toString('hex')
  } catch {
    return false
  }
  try {
    const a = Buffer.from(actual, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateUsername(raw: string): string | null {
  const trimmed = raw.trim()
  if (!USERNAME_RE.test(trimmed)) return null
  return normalizeUsername(trimmed)
}

export function validatePassword(raw: string): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length < 8 || raw.length > 128) return null
  return raw
}

function toPublic(user: UserRow): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    disabled: user.disabled,
  }
}

export function hasAnyUser(): boolean {
  return readAccounts().users.length > 0
}

/** Single enabled account — typical upgraded single-operator box. */
export function getSoleEnabledUser(): PublicUser | null {
  const users = readAccounts().users.filter((u) => !u.disabled)
  const only = users.length === 1 ? users[0] : undefined
  return only ? toPublic(only) : null
}

export function countUsers(): number {
  return readAccounts().users.length
}

export function getUserById(id: string): PublicUser | null {
  const row = readAccounts().users.find((u) => u.id === id)
  return row ? toPublic(row) : null
}

export function getUserByUsername(username: string): PublicUser | null {
  const key = normalizeUsername(username)
  const row = readAccounts().users.find((u) => u.username === key)
  return row ? toPublic(row) : null
}

export function listUsers(): PublicUser[] {
  return readAccounts().users.map(toPublic)
}

export function registerUser(input: {
  username: string
  password: string
  inviteRaw?: string
}): { user: PublicUser; session: CreatedSession } {
  const username = validateUsername(input.username)
  if (!username) {
    throw Object.assign(new Error('invalid username'), { code: 'AUTH_BAD_USERNAME' })
  }
  const password = validatePassword(input.password)
  if (!password) {
    throw Object.assign(new Error('password must be 8–128 characters'), { code: 'AUTH_BAD_PASSWORD' })
  }

  return mutateAccounts((data) => {
    if (data.users.some((u) => u.username === username)) {
      throw Object.assign(new Error('username taken'), { code: 'AUTH_USERNAME_TAKEN' })
    }
    const isFirst = data.users.length === 0
    let monthlyLimit: number | null = null
    if (!isFirst) {
      const invite = consumeInviteLocked(data, input.inviteRaw)
      if (!invite) {
        throw Object.assign(new Error('invite required'), { code: 'AUTH_INVITE_REQUIRED' })
      }
      monthlyLimit = invite.monthlyLimit
    }
    const user: UserRow = {
      id: newUserId(),
      username,
      displayName: input.username.trim(),
      password: hashPassword(password),
      role: isFirst ? 'admin' : 'user',
      createdAt: Date.now(),
      disabled: false,
    }
    data.users.push(user)
    if (!data.quotas.some((q) => q.userId === user.id)) {
      data.quotas.push({
        userId: user.id,
        monthlyLimit: monthlyLimit ?? data.defaultMonthlyLimit,
        bonus: 0,
        periodStart: monthStartMs(Date.now()),
      })
    }
    const session = issueSessionLocked(data, user)
    log.info({
      event: 'accounts.registered',
      userId: user.id,
      role: user.role,
      first: isFirst,
    }, isFirst ? 'first admin registered' : 'user registered')
    return { user: toPublic(user), session }
  })
}

export function loginUser(input: {
  username: string
  password: string
}): CreatedSession {
  const username = normalizeUsername(input.username || '')
  if (!username || !input.password) {
    throw Object.assign(new Error('invalid credentials'), { code: 'AUTH_INVALID' })
  }
  return mutateAccounts((data) => {
    const user = data.users.find((u) => u.username === username)
    if (!user || user.disabled || !verifyPassword(input.password, user.password)) {
      throw Object.assign(new Error('invalid credentials'), { code: 'AUTH_INVALID' })
    }
    return issueSessionLocked(data, user)
  })
}

function issueSessionLocked(data: ReturnType<typeof readAccounts>, user: UserRow): CreatedSession {
  const raw = `ags_${randomBytes(24).toString('hex')}`
  const now = Date.now()
  const row: LoginSessionRow = {
    id: newSessionId(),
    hash: sha256Hex(raw),
    userId: user.id,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastSeenAt: now,
  }
  data.loginSessions.push(row)
  return { raw, expiresAt: row.expiresAt, user: toPublic(user) }
}

export function verifyLoginSession(raw: string): PublicUser | null {
  if (!raw || !raw.startsWith('ags_')) return null
  const hash = sha256Hex(raw)
  const data = readAccounts()
  const now = Date.now()
  const row = data.loginSessions.find((s) => s.hash === hash && s.expiresAt > now)
  if (!row) return null
  const user = data.users.find((u) => u.id === row.userId)
  if (!user || user.disabled) return null
  if (now - row.lastSeenAt > 60_000) {
    mutateAccounts((next) => {
      const live = next.loginSessions.find((s) => s.id === row.id)
      if (live) live.lastSeenAt = Date.now()
    })
  }
  return toPublic(user)
}

export function revokeLoginSession(raw: string): boolean {
  if (!raw) return false
  const hash = sha256Hex(raw)
  return mutateAccounts((data) => {
    const before = data.loginSessions.length
    data.loginSessions = data.loginSessions.filter((s) => s.hash !== hash)
    return data.loginSessions.length < before
  })
}

export function setUserDisabled(userId: string, disabled: boolean): PublicUser | null {
  return mutateAccounts((data) => {
    const user = data.users.find((u) => u.id === userId)
    if (!user) return null
    if (user.role === 'admin' && disabled) {
      const otherAdmins = data.users.filter((u) => u.id !== userId && u.role === 'admin' && !u.disabled)
      if (otherAdmins.length === 0) {
        throw Object.assign(new Error('cannot disable the last admin'), { code: 'AUTH_LAST_ADMIN' })
      }
    }
    user.disabled = disabled
    if (disabled) {
      data.loginSessions = data.loginSessions.filter((s) => s.userId !== userId)
    }
    return toPublic(user)
  })
}

export function setUserRole(userId: string, role: UserRole): PublicUser | null {
  return mutateAccounts((data) => {
    const user = data.users.find((u) => u.id === userId)
    if (!user) return null
    if (user.role === 'admin' && role !== 'admin') {
      const otherAdmins = data.users.filter((u) => u.id !== userId && u.role === 'admin' && !u.disabled)
      if (otherAdmins.length === 0) {
        throw Object.assign(new Error('cannot demote the last admin'), { code: 'AUTH_LAST_ADMIN' })
      }
    }
    user.role = role
    return toPublic(user)
  })
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomInviteChunk(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length]
  return out
}

export function generateInviteRaw(): string {
  return `AGIM-${randomInviteChunk(4)}-${randomInviteChunk(4)}`
}

export function normalizeInviteRaw(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

export function createInvite(opts: {
  createdBy: string
  uses?: number
  expiresInDays?: number
  monthlyLimit?: number
}): CreatedInvite {
  const uses = Math.max(1, Math.min(100, Math.floor(opts.uses ?? 1)))
  const raw = generateInviteRaw()
  const now = Date.now()
  const expiresAt = opts.expiresInDays && opts.expiresInDays > 0
    ? now + opts.expiresInDays * 86_400_000
    : null
  const row: InviteRow = {
    id: newInviteId(),
    hash: sha256Hex(normalizeInviteRaw(raw)),
    createdBy: opts.createdBy,
    usesLeft: uses,
    expiresAt,
    createdAt: now,
    monthlyLimit: typeof opts.monthlyLimit === 'number' && opts.monthlyLimit >= 0
      ? Math.floor(opts.monthlyLimit)
      : null,
  }
  mutateAccounts((data) => { data.invites.push(row) })
  return {
    id: row.id,
    raw,
    usesLeft: row.usesLeft,
    expiresAt: row.expiresAt,
    monthlyLimit: row.monthlyLimit,
    createdAt: row.createdAt,
  }
}

export function listInvites(): Array<Omit<InviteRow, 'hash'>> {
  const now = Date.now()
  return readAccounts().invites
    .filter((i) => i.usesLeft > 0 && (i.expiresAt == null || i.expiresAt > now))
    .map(({ hash: _h, ...rest }) => rest)
}

export function revokeInvite(id: string): boolean {
  return mutateAccounts((data) => {
    const before = data.invites.length
    data.invites = data.invites.filter((i) => i.id !== id)
    return data.invites.length < before
  })
}

function consumeInviteLocked(data: ReturnType<typeof readAccounts>, raw: string | undefined): InviteRow | null {
  if (!raw) return null
  const hash = sha256Hex(normalizeInviteRaw(raw))
  const now = Date.now()
  const row = data.invites.find((i) => i.hash === hash)
  if (!row) return null
  if (row.usesLeft <= 0) return null
  if (row.expiresAt != null && row.expiresAt <= now) return null
  row.usesLeft -= 1
  return row
}

export function peekInviteValid(raw: string): boolean {
  const hash = sha256Hex(normalizeInviteRaw(raw))
  const now = Date.now()
  const row = readAccounts().invites.find((i) => i.hash === hash)
  if (!row) return false
  if (row.usesLeft <= 0) return false
  if (row.expiresAt != null && row.expiresAt <= now) return false
  return true
}

export function monthStartMs(at: number): number {
  const d = new Date(at)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
