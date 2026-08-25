// Account / invite / points / IM-bind / my-sessions REST.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError, sendJson, readBody } from './http-utils.js'
import {
  buildSessionCookie,
  getRequestUserId,
  isRequestAdmin,
  requireAdmin,
  resolveWebIdentity,
} from './auth.js'
import {
  createToken,
  listTokensForUser,
  revokeToken,
} from '../core/access-token.js'
import {
  adoptLegacyInstall,
  inheritLegacySession,
  listLegacyUpgrade,
  markLegacyUpgradeDone,
  skipLegacyUpgrade,
} from '../core/accounts-upgrade.js'
import {
  createInvite,
  getUserById,
  hasAnyUser,
  listInvites,
  listUsers,
  registerUser,
  revokeInvite,
  setUserDisabled,
  setUserRole,
} from '../core/accounts.js'
import { consumeCaptcha, issueCaptcha } from '../core/captcha.js'
import { seedAccountWorkspaces } from '../core/account-workspace-seed.js'
import {
  claimImIdentity,
  listBindings,
  unbindImIdentity,
} from '../core/im-bind.js'
import {
  dailyPointsSeries,
  getPointsBalance,
  getPointsConfig,
  listLedger,
  listPointsBalances,
  setPointsConfig,
  setPointsQuota,
} from '../core/points.js'
import {
  applyModelPriceOverrides,
  listModelPriceRows,
} from '../core/model-prices.js'
import { getLiveConfig } from '../core/live-config.js'
import { sessionManager } from '../core/session.js'
import { listKnownImUsers } from '../core/admin-allowlist.js'

function codeOf(err: unknown): string {
  return (err as { code?: string }).code || 'INTERNAL'
}

export async function handleAccountApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = (req.method || 'GET').toUpperCase()

  if (p === '/api/auth/bootstrap-state' && m === 'GET') {
    sendJson(res, 200, { hasUsers: hasAnyUser() })
    return true
  }
  if (p === '/api/auth/legacy-upgrade' && m === 'GET') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    if (!isRequestAdmin(req)) { sendError(res, 403, 'AUTH_ADMIN_REQUIRED', { message: 'admin role required' }); return true }
    sendJson(res, 200, listLegacyUpgrade())
    return true
  }
  if (p === '/api/auth/legacy-upgrade' && m === 'POST') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    if (!isRequestAdmin(req)) { sendError(res, 403, 'AUTH_ADMIN_REQUIRED', { message: 'admin role required' }); return true }
    try {
      const parsed = JSON.parse(await readBody(req, res) || '{}') as { threadId?: string; skip?: boolean }
      if (parsed.skip) {
        sendJson(res, 200, { ok: true, ...skipLegacyUpgrade(userId) })
        return true
      }
      const threadId = (parsed.threadId || '').trim()
      if (!threadId) {
        sendError(res, 400, 'LEGACY_SESSION_REQUIRED', { message: 'threadId required, or skip' })
        return true
      }
      sendJson(res, 200, { ok: true, ...inheritLegacySession(userId, threadId) })
    } catch (err) {
      sendError(res, 400, codeOf(err), { message: err instanceof Error ? err.message : String(err) })
    }
    return true
  }
  if (p === '/api/auth/captcha' && m === 'GET') {
    const cap = issueCaptcha()
    sendJson(res, 200, cap)
    return true
  }
  if (p === '/api/auth/register' && m === 'POST') {
    await handleRegister(req, res)
    return true
  }
  if (p === '/api/auth/me' && m === 'GET') {
    const ident = resolveWebIdentity(req, url)
    if (!ident || (ident.kind !== 'session' && ident.kind !== 'token' && ident.kind !== 'auth-off' && ident.kind !== 'loopback')) {
      sendError(res, 401, 'AUTH_INVALID', { message: 'unauthorized' })
      return true
    }
    const user = ident.userId ? getUserById(ident.userId) : null
    const points = ident.userId ? getPointsBalance(ident.userId) : null
    sendJson(res, 200, {
      ok: true,
      user: user ?? (ident.kind === 'loopback' || ident.kind === 'auth-off'
        ? { id: ident.kind, username: ident.kind, role: ident.role, displayName: ident.kind, createdAt: 0, disabled: false }
        : null),
      role: ident.role,
      kind: ident.kind,
      points,
    })
    return true
  }

  if (p === '/api/me/sessions' && m === 'GET') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    const sessions = await sessionManager.listUserWebSessions(userId)
    sendJson(res, 200, { sessions })
    return true
  }
  if (p === '/api/me/sessions' && m === 'POST') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    await handlePatchMySession(req, res, userId)
    return true
  }
  if (p === '/api/me/sessions' && m === 'PATCH') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    await handlePatchMySession(req, res, userId)
    return true
  }

  if (p === '/api/me/tokens' && m === 'GET') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    sendJson(res, 200, { tokens: listTokensForUser(userId) })
    return true
  }
  if (p === '/api/me/tokens' && m === 'POST') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    const user = getUserById(userId)
    const parsed = JSON.parse(await readBody(req, res) || '{}') as { label?: string }
    const created = createToken(parsed.label || 'api', {
      role: user?.role === 'admin' ? 'admin' : 'user',
      userId,
      actor: `web:${userId}`,
    })
    sendJson(res, 201, { ok: true, id: created.id, raw: created.raw, role: created.role })
    return true
  }
  const tokenMatch = p.match(/^\/api\/me\/tokens\/([^/]+)$/)
  if (tokenMatch && m === 'DELETE') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    const id = decodeURIComponent(tokenMatch[1]!)
    const mine = listTokensForUser(userId).some((t) => t.id === id)
    if (!mine && !isRequestAdmin(req)) {
      sendError(res, 404, 'NOT_FOUND', { message: 'token not found' })
      return true
    }
    sendJson(res, 200, { ok: revokeToken(id, { actor: `web:${userId}` }) })
    return true
  }

  if (p === '/api/me/points' && m === 'GET') {
    const userId = getRequestUserId(req)
    if (!userId) { sendError(res, 401, 'AUTH_INVALID', { message: 'login required' }); return true }
    sendJson(res, 200, {
      balance: getPointsBalance(userId),
      ledger: listLedger({ userId, limit: 50 }),
      daily: dailyPointsSeries(userId),
    })
    return true
  }

  if (p === '/api/admin/users' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    sendJson(res, 200, { users: listUsers() })
    return true
  }
  const userMatch = p.match(/^\/api\/admin\/users\/([^/]+)$/)
  if (userMatch && m === 'PATCH') {
    if (!requireAdmin(req, res)) return true
    const id = decodeURIComponent(userMatch[1]!)
    try {
      const parsed = JSON.parse(await readBody(req, res) || '{}') as { disabled?: boolean; role?: 'admin' | 'user' }
      let user = getUserById(id)
      if (!user) { sendError(res, 404, 'NOT_FOUND', { message: 'user not found' }); return true }
      if (typeof parsed.disabled === 'boolean') user = setUserDisabled(id, parsed.disabled) ?? user
      if (parsed.role === 'admin' || parsed.role === 'user') user = setUserRole(id, parsed.role) ?? user
      sendJson(res, 200, { ok: true, user })
    } catch (err) {
      sendError(res, 400, codeOf(err), { message: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (p === '/api/admin/invites' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    sendJson(res, 200, { invites: listInvites() })
    return true
  }
  if (p === '/api/admin/invites' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    const actor = getRequestUserId(req) || 'admin'
    const parsed = JSON.parse(await readBody(req, res) || '{}') as {
      uses?: number; expiresInDays?: number; monthlyLimit?: number
    }
    const invite = createInvite({
      createdBy: actor,
      uses: parsed.uses,
      expiresInDays: parsed.expiresInDays,
      monthlyLimit: parsed.monthlyLimit,
    })
    sendJson(res, 201, { ok: true, invite })
    return true
  }
  const invMatch = p.match(/^\/api\/admin\/invites\/([^/]+)$/)
  if (invMatch && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    sendJson(res, 200, { ok: revokeInvite(decodeURIComponent(invMatch[1]!)) })
    return true
  }

  if (p === '/api/admin/points' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    sendJson(res, 200, {
      config: getPointsConfig(),
      balances: listPointsBalances(),
      ledger: listLedger({ limit: 100 }),
    })
    return true
  }
  if (p === '/api/admin/points' && m === 'PATCH') {
    if (!requireAdmin(req, res)) return true
    const parsed = JSON.parse(await readBody(req, res) || '{}') as {
      pointsPerUsd?: number
      defaultMonthlyLimit?: number
      defaultCostPer1kIn?: number
      defaultCostPer1kOut?: number
    }
    sendJson(res, 200, { ok: true, config: setPointsConfig(parsed) })
    return true
  }

  if (p === '/api/admin/model-prices' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    const extra = (getLiveConfig() as { llmBackends?: Array<{ model?: string }> } | null)
      ?.llmBackends?.map((b) => b.model).filter((id): id is string => !!id?.trim()) ?? []
    sendJson(res, 200, { ok: true, rows: listModelPriceRows(extra) })
    return true
  }
  if (p === '/api/admin/model-prices' && m === 'PUT') {
    if (!requireAdmin(req, res)) return true
    try {
      const parsed = JSON.parse(await readBody(req, res) || '{}') as {
        overrides?: unknown
      }
      const overrides = parsed.overrides
      if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
        sendError(res, 400, 'BAD_REQUEST', { message: 'overrides must be an object' })
        return true
      }
      applyModelPriceOverrides(
        (overrides ?? {}) as Record<string, { costPer1kIn: number; costPer1kOut: number } | null>,
      )
      const extra = (getLiveConfig() as { llmBackends?: Array<{ model?: string }> } | null)
        ?.llmBackends?.map((b) => b.model).filter((id): id is string => !!id?.trim()) ?? []
      sendJson(res, 200, { ok: true, rows: listModelPriceRows(extra) })
    } catch (err) {
      sendError(res, 400, codeOf(err), { message: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  const quotaMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/points$/)
  if (quotaMatch && m === 'PATCH') {
    if (!requireAdmin(req, res)) return true
    try {
      const parsed = JSON.parse(await readBody(req, res) || '{}') as {
        monthlyLimit?: number; bonus?: number; addBonus?: number
      }
      const balance = setPointsQuota(decodeURIComponent(quotaMatch[1]!), parsed)
      sendJson(res, 200, { ok: true, balance })
    } catch (err) {
      sendError(res, 400, codeOf(err), { message: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (p === '/api/admin/im-bindings' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    sendJson(res, 200, { bindings: listBindings(), known: listKnownImUsers() })
    return true
  }
  if (p === '/api/admin/im-bindings' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    try {
      const parsed = JSON.parse(await readBody(req, res) || '{}') as {
        platform?: string; imUserId?: string; userId?: string
      }
      const result = claimImIdentity({
        platform: parsed.platform || '',
        imUserId: parsed.imUserId || '',
        userId: parsed.userId || getRequestUserId(req) || '',
      })
      sendJson(res, 200, { ok: true, ...result })
    } catch (err) {
      sendError(res, 400, codeOf(err), { message: err instanceof Error ? err.message : String(err) })
    }
    return true
  }
  if (p === '/api/admin/im-bindings' && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    const parsed = JSON.parse(await readBody(req, res) || '{}') as { platform?: string; imUserId?: string }
    sendJson(res, 200, { ok: unbindImIdentity(parsed.platform || '', parsed.imUserId || '') })
    return true
  }

  return false
}

async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const parsed = JSON.parse(await readBody(req, res) || '{}') as {
      username?: string
      password?: string
      invite?: string
      captchaId?: string
      captcha?: string
    }
    if (!consumeCaptcha(parsed.captchaId || '', parsed.captcha || '')) {
      sendError(res, 400, 'AUTH_CAPTCHA', { message: 'invalid captcha' })
      return
    }
    const first = !hasAnyUser()
    const result = registerUser({
      username: parsed.username || '',
      password: parsed.password || '',
      inviteRaw: parsed.invite,
    })
    try { await seedAccountWorkspaces(result.user.id) } catch { /* seed logs failures */ }
    if (first) {
      try { adoptLegacyInstall(result.user.id) } catch { /* ignore */ }
    }
    const maxAge = 30 * 24 * 60 * 60
    const legacyUpgrade = first ? listLegacyUpgrade().pending : false
    if (first && !legacyUpgrade) markLegacyUpgradeDone()
    res.writeHead(201, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': buildSessionCookie(req, result.session.raw, maxAge),
    })
    res.end(JSON.stringify({ ok: true, user: result.user, firstAdmin: first, legacyUpgrade }))
  } catch (err) {
    sendError(res, 400, codeOf(err), { message: err instanceof Error ? err.message : String(err) })
  }
}

async function handlePatchMySession(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const parsed = JSON.parse(await readBody(req, res) || '{}') as {
    threadId?: string
    title?: string
    archivedAt?: number | null
    agent?: string
  }
  if (!parsed.threadId) {
    sendError(res, 400, 'BAD_REQUEST', { message: 'threadId required' })
    return
  }
  const ok = await sessionManager.updateUserWebSession(userId, parsed.threadId, {
    title: parsed.title,
    archivedAt: parsed.archivedAt === null ? undefined : parsed.archivedAt,
    clearArchived: parsed.archivedAt === null,
    agent: parsed.agent,
  })
  if (!ok) {
    sendError(res, 404, 'NOT_FOUND', { message: 'session not found' })
    return
  }
  sendJson(res, 200, { ok: true })
}
