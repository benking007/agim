// Shared JSON store for accounts, invites, login sessions, IM bindings,
// and points. Single-process atomic rename — same pattern as tokens.json.
// JSON (not SQLite) so bun tests and hosts without better-sqlite3 still work.

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, renameSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'accounts-store' })

export type UserRole = 'admin' | 'user'

export interface UserRow {
  id: string
  username: string
  displayName: string
  password: string
  role: UserRole
  createdAt: number
  disabled: boolean
}

export interface LoginSessionRow {
  id: string
  hash: string
  userId: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
}

export interface InviteRow {
  id: string
  hash: string
  createdBy: string
  usesLeft: number
  expiresAt: number | null
  createdAt: number
  monthlyLimit: number | null
}

export interface ImBindingRow {
  platform: string
  imUserId: string
  userId: string
  createdAt: number
  createdBy: string
}

export interface QuotaRow {
  userId: string
  monthlyLimit: number
  bonus: number
  periodStart: number
}

export interface LedgerRow {
  id: string
  userId: string
  delta: number
  reason: string
  usd?: number
  tokensIn?: number
  tokensOut?: number
  model?: string
  at: number
}

export interface AccountsFile {
  version: 1
  users: UserRow[]
  loginSessions: LoginSessionRow[]
  invites: InviteRow[]
  imBindings: ImBindingRow[]
  pointsPerUsd: number
  defaultMonthlyLimit: number
  defaultCostPer1kIn: number
  defaultCostPer1kOut: number
  quotas: QuotaRow[]
  ledger: LedgerRow[]
  /** Set after the first admin inherits or skips pre-account sessions. */
  legacyUpgradeDone?: boolean
}

export const DEFAULT_POINTS_PER_USD = 10_000
export const DEFAULT_MONTHLY_LIMIT = 100_000
const MAX_LEDGER_ROWS = 5_000

function currentHome(): string {
  return process.env.AGIM_HOME || AGIM_HOME
}

export function accountsFilePath(): string {
  return join(currentHome(), 'accounts.json')
}

function emptyFile(): AccountsFile {
  return {
    version: 1,
    users: [],
    loginSessions: [],
    invites: [],
    imBindings: [],
    pointsPerUsd: DEFAULT_POINTS_PER_USD,
    defaultMonthlyLimit: DEFAULT_MONTHLY_LIMIT,
    defaultCostPer1kIn: 0,
    defaultCostPer1kOut: 0,
    quotas: [],
    ledger: [],
    legacyUpgradeDone: false,
  }
}

let cached: AccountsFile | null = null
let cachedPath = ''

function prune(data: AccountsFile): void {
  const now = Date.now()
  data.loginSessions = data.loginSessions.filter((s) => s.expiresAt > now)
  if (data.ledger.length > MAX_LEDGER_ROWS) {
    data.ledger = data.ledger.slice(data.ledger.length - MAX_LEDGER_ROWS)
  }
}

export function readAccounts(): AccountsFile {
  const path = accountsFilePath()
  if (cached && cachedPath === path) return cached
  if (!existsSync(path)) {
    cached = emptyFile()
    cachedPath = path
    return cached
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AccountsFile> & { bindCodes?: unknown }
    delete parsed.bindCodes
    cached = {
      ...emptyFile(),
      ...parsed,
      version: 1,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      loginSessions: Array.isArray(parsed.loginSessions) ? parsed.loginSessions : [],
      invites: Array.isArray(parsed.invites) ? parsed.invites : [],
      imBindings: Array.isArray(parsed.imBindings) ? parsed.imBindings : [],
      quotas: Array.isArray(parsed.quotas) ? parsed.quotas : [],
      ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
      pointsPerUsd: Number.isFinite(parsed.pointsPerUsd) ? Number(parsed.pointsPerUsd) : DEFAULT_POINTS_PER_USD,
      defaultMonthlyLimit: Number.isFinite(parsed.defaultMonthlyLimit)
        ? Number(parsed.defaultMonthlyLimit) : DEFAULT_MONTHLY_LIMIT,
      defaultCostPer1kIn: Number.isFinite(parsed.defaultCostPer1kIn) ? Number(parsed.defaultCostPer1kIn) : 0,
      defaultCostPer1kOut: Number.isFinite(parsed.defaultCostPer1kOut) ? Number(parsed.defaultCostPer1kOut) : 0,
      legacyUpgradeDone: Boolean(parsed.legacyUpgradeDone),
    }
    prune(cached)
    cachedPath = path
    return cached
  } catch (err) {
    log.warn({ event: 'accounts.read_failed', err: String(err) }, 'accounts.json corrupt; starting empty')
    cached = emptyFile()
    cachedPath = path
    return cached
  }
}

export function writeAccounts(data: AccountsFile): void {
  prune(data)
  const path = accountsFilePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const payload = `${JSON.stringify(data, null, 2)}\n`
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmpPath, path)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
  try { chmodSync(path, 0o600) } catch { /* ignore */ }
  cached = data
  cachedPath = path
}

export function mutateAccounts<T>(fn: (data: AccountsFile) => T): T {
  const data = readAccounts()
  const result = fn(data)
  writeAccounts(data)
  return result
}

/** Test helper — drop the process cache so the next read hits disk. */
export function _resetAccountsCache(): void {
  cached = null
  cachedPath = ''
}
