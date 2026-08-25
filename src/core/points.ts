// Points quota for Agim Agent turns. Convert USD cost → points using
// the instance `pointsPerUsd` rate (default 10_000). Quota is always on
// the registered user; IM is only a channel. Unbound IM has no account.

import { estimateCostUsd } from './llm/model-catalog.js'
import { logger as rootLogger } from './logger.js'
import { getUserById, monthStartMs } from './accounts.js'
import { registeredUserIdOf } from './im-identity.js'
import {
  mutateAccounts,
  readAccounts,
  type LedgerRow,
  type QuotaRow,
} from './accounts-store.js'

const log = rootLogger.child({ component: 'points' })

export interface PointsBalance {
  userId: string
  monthlyLimit: number
  bonus: number
  usedThisPeriod: number
  remaining: number
  periodStart: number
  pointsPerUsd: number
  /** Admins are not gated by monthlyLimit / bonus. Never JSON-serialize Infinity. */
  unlimited: boolean
}

export interface ChargeInput {
  userId: string
  tokensIn: number
  tokensOut: number
  model?: string
  providerType?: string
  costUsd?: number
  costPer1kIn?: number
  costPer1kOut?: number
}

export class PointsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PointsError'
  }
}

function ensureQuota(data: ReturnType<typeof readAccounts>, userId: string, now: number): QuotaRow {
  let row = data.quotas.find((q) => q.userId === userId)
  if (!row) {
    row = {
      userId,
      monthlyLimit: data.defaultMonthlyLimit,
      bonus: 0,
      periodStart: monthStartMs(now),
    }
    data.quotas.push(row)
  }
  const start = monthStartMs(now)
  if (row.periodStart < start) {
    row.periodStart = start
  }
  return row
}

function isUnlimitedUser(userId: string): boolean {
  return getUserById(userId)?.role === 'admin'
}

function usedInPeriod(data: ReturnType<typeof readAccounts>, userId: string, periodStart: number): number {
  let used = 0
  for (const row of data.ledger) {
    if (row.userId !== userId) continue
    if (row.at < periodStart) continue
    if (row.delta < 0) used += -row.delta
  }
  return used
}

export function getPointsBalance(userId: string): PointsBalance | null {
  if (!getUserById(userId)) return null
  const data = readAccounts()
  const now = Date.now()
  const quota = data.quotas.find((q) => q.userId === userId) ?? {
    userId,
    monthlyLimit: data.defaultMonthlyLimit,
    bonus: 0,
    periodStart: monthStartMs(now),
  }
  const periodStart = quota.periodStart < monthStartMs(now) ? monthStartMs(now) : quota.periodStart
  const used = usedInPeriod(data, userId, periodStart)
  const remaining = Math.max(0, quota.monthlyLimit + quota.bonus - used)
  return {
    userId,
    monthlyLimit: quota.monthlyLimit,
    bonus: quota.bonus,
    usedThisPeriod: used,
    remaining,
    periodStart,
    pointsPerUsd: data.pointsPerUsd,
    unlimited: isUnlimitedUser(userId),
  }
}

export function listPointsBalances(): PointsBalance[] {
  return readAccounts().users.map((u) => getPointsBalance(u.id)).filter((b): b is PointsBalance => !!b)
}

export function setPointsQuota(userId: string, patch: {
  monthlyLimit?: number
  bonus?: number
  addBonus?: number
}): PointsBalance {
  const user = getUserById(userId)
  if (!user) {
    throw new PointsError('POINTS_NO_USER', 'user not found')
  }
  if (user.role === 'admin') {
    throw new PointsError('POINTS_ADMIN_UNLIMITED', '管理员额度不限，无需加点')
  }
  mutateAccounts((data) => {
    const row = ensureQuota(data, userId, Date.now())
    if (typeof patch.monthlyLimit === 'number' && Number.isFinite(patch.monthlyLimit) && patch.monthlyLimit >= 0) {
      row.monthlyLimit = Math.floor(patch.monthlyLimit)
    }
    if (typeof patch.bonus === 'number' && Number.isFinite(patch.bonus) && patch.bonus >= 0) {
      row.bonus = Math.floor(patch.bonus)
    }
    if (typeof patch.addBonus === 'number' && Number.isFinite(patch.addBonus) && patch.addBonus !== 0) {
      row.bonus = Math.max(0, row.bonus + Math.floor(patch.addBonus))
      if (patch.addBonus > 0) {
        data.ledger.push({
          id: `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          userId,
          delta: Math.floor(patch.addBonus),
          reason: 'admin_grant',
          at: Date.now(),
        })
      }
    }
  })
  return getPointsBalance(userId)!
}

export function setPointsConfig(patch: {
  pointsPerUsd?: number
  defaultMonthlyLimit?: number
  defaultCostPer1kIn?: number
  defaultCostPer1kOut?: number
}): {
  pointsPerUsd: number
  defaultMonthlyLimit: number
  defaultCostPer1kIn: number
  defaultCostPer1kOut: number
} {
  return mutateAccounts((data) => {
    if (typeof patch.pointsPerUsd === 'number' && patch.pointsPerUsd > 0) {
      data.pointsPerUsd = patch.pointsPerUsd
    }
    if (typeof patch.defaultMonthlyLimit === 'number' && patch.defaultMonthlyLimit >= 0) {
      data.defaultMonthlyLimit = Math.floor(patch.defaultMonthlyLimit)
    }
    if (typeof patch.defaultCostPer1kIn === 'number' && patch.defaultCostPer1kIn >= 0) {
      data.defaultCostPer1kIn = patch.defaultCostPer1kIn
    }
    if (typeof patch.defaultCostPer1kOut === 'number' && patch.defaultCostPer1kOut >= 0) {
      data.defaultCostPer1kOut = patch.defaultCostPer1kOut
    }
    return {
      pointsPerUsd: data.pointsPerUsd,
      defaultMonthlyLimit: data.defaultMonthlyLimit,
      defaultCostPer1kIn: data.defaultCostPer1kIn,
      defaultCostPer1kOut: data.defaultCostPer1kOut,
    }
  })
}

export function getPointsConfig(): {
  pointsPerUsd: number
  defaultMonthlyLimit: number
  defaultCostPer1kIn: number
  defaultCostPer1kOut: number
} {
  const data = readAccounts()
  return {
    pointsPerUsd: data.pointsPerUsd,
    defaultMonthlyLimit: data.defaultMonthlyLimit,
    defaultCostPer1kIn: data.defaultCostPer1kIn,
    defaultCostPer1kOut: data.defaultCostPer1kOut,
  }
}

export function usdToPoints(usd: number, pointsPerUsd = readAccounts().pointsPerUsd): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0
  return Math.max(1, Math.ceil(usd * pointsPerUsd))
}

export function estimateChargeUsd(input: ChargeInput): { usd: number; source: 'usage' | 'catalog' | 'backend' | 'default' } | null {
  if (typeof input.costUsd === 'number' && Number.isFinite(input.costUsd) && input.costUsd > 0) {
    return { usd: input.costUsd, source: 'usage' }
  }
  const catalog = input.model
    ? estimateCostUsd(input.providerType, input.model, {
        input: input.tokensIn,
        output: input.tokensOut,
      })
    : null
  if (catalog != null && catalog > 0) return { usd: catalog, source: 'catalog' }

  const inRate = input.costPer1kIn
  const outRate = input.costPer1kOut
  if ((inRate && inRate > 0) || (outRate && outRate > 0)) {
    const usd = (input.tokensIn / 1000) * (inRate ?? 0) + (input.tokensOut / 1000) * (outRate ?? 0)
    if (usd > 0) return { usd, source: 'backend' }
  }

  const cfg = getPointsConfig()
  if (cfg.defaultCostPer1kIn > 0 || cfg.defaultCostPer1kOut > 0) {
    const usd = (input.tokensIn / 1000) * cfg.defaultCostPer1kIn
      + (input.tokensOut / 1000) * cfg.defaultCostPer1kOut
    if (usd > 0) return { usd, source: 'default' }
  }
  return null
}

export function assertCanSpend(userId: string): PointsBalance {
  const bal = getPointsBalance(userId)
  if (!bal) throw new PointsError('POINTS_NO_USER', 'user not found')
  if (!bal.unlimited && bal.remaining <= 0) {
    throw new PointsError('POINTS_EXHAUSTED', '点数已用完，请联系管理员加点')
  }
  return bal
}

export function chargePoints(input: ChargeInput): LedgerRow {
  const priced = estimateChargeUsd(input)
  if (!priced) {
    throw new PointsError('POINTS_NO_PRICE', '无法计价：请管理员为该模型配置价格')
  }
  const points = usdToPoints(priced.usd)
  return mutateAccounts((data) => {
    const now = Date.now()
    const quota = ensureQuota(data, input.userId, now)
    const used = usedInPeriod(data, input.userId, quota.periodStart)
    const remaining = quota.monthlyLimit + quota.bonus - used
    const unlimited = isUnlimitedUser(input.userId)
    if (!unlimited && remaining <= 0) {
      throw new PointsError('POINTS_EXHAUSTED', '点数已用完，请联系管理员加点')
    }
    const debit = unlimited ? points : Math.min(points, remaining)
    const row: LedgerRow = {
      id: `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      userId: input.userId,
      delta: -debit,
      reason: 'agim_turn',
      usd: priced.usd,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      model: input.model,
      at: now,
    }
    data.ledger.push(row)
    log.info({
      event: 'points.charged',
      userId: input.userId,
      points: debit,
      usd: priced.usd,
      source: priced.source,
      model: input.model,
    }, 'agim turn charged')
    return row
  })
}

export function listLedger(opts: { userId?: string; limit?: number } = {}): LedgerRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50))
  const rows = readAccounts().ledger
    .filter((r) => !opts.userId || r.userId === opts.userId)
    .slice()
    .reverse()
  return rows.slice(0, limit)
}

export const POINTS_DAILY_DAYS = 14
const DAY_MS = 86_400_000

export function utcDayKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10)
}

export interface DailyPointsSpend {
  day: string
  spent: number
}

/** UTC calendar buckets of spent points (negative ledger deltas). */
export function dailyPointsSeries(
  userId: string,
  days = POINTS_DAILY_DAYS,
  now = Date.now(),
): DailyPointsSpend[] {
  const daysN = Math.min(90, Math.max(1, Math.floor(days)))
  const endDay = utcDayKey(now)
  const endStart = Date.parse(`${endDay}T00:00:00.000Z`)
  const startMs = endStart - (daysN - 1) * DAY_MS
  const spent = new Map<string, number>()
  for (let i = 0; i < daysN; i++) {
    spent.set(utcDayKey(startMs + i * DAY_MS), 0)
  }
  for (const row of readAccounts().ledger) {
    if (row.userId !== userId) continue
    if (row.at < startMs || row.delta >= 0) continue
    const key = utcDayKey(row.at)
    if (!spent.has(key)) continue
    spent.set(key, (spent.get(key) ?? 0) + (-row.delta))
  }
  return [...spent.entries()].map(([day, value]) => ({ day, spent: value }))
}

/**
 * Quota belongs to the registered user. IM is only a channel:
 * `telegram:12345:usr_ab12` bills `usr_ab12`. Unbound IM has no
 * registered user, so this returns null (Agim still runs).
 */
export function resolveBillableUserId(platform: string | undefined, userId: string | undefined): string | null {
  return registeredUserIdOf(platform, userId)
}
