import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetAccountsCache } from '../../src/core/accounts-store.js'
import type { IncomingMessage } from 'node:http'
import {
  createInvite,
  getSoleEnabledUser,
  hasAnyUser,
  loginUser,
  registerUser,
  verifyLoginSession,
} from '../../src/core/accounts.js'
import * as accounts from '../../src/core/accounts.js'
import {
  adoptLegacyInstall,
  inheritLegacySession,
  listLegacyUpgrade,
  skipLegacyUpgrade,
} from '../../src/core/accounts-upgrade.js'
import { createToken, getTokenUserId } from '../../src/core/access-token.js'
import { setLiveConfig } from '../../src/core/live-config.js'
import { bindAccountsModule, resolveWebIdentity } from '../../src/web/auth.js'
import { webThreadOwners } from '../../src/core/web-thread-owners.js'
import type { Config } from '../../src/core/types.js'
import { consumeCaptcha, issueCaptcha, _issueCaptchaForTests } from '../../src/core/captcha.js'
import { bindImIdentity, claimImIdentity, claimMessengerPlatform, findBinding, PLATFORM_CHANNEL, unbindImIdentity } from '../../src/core/im-bind.js'
import {
  attachRegisteredIdentity,
  imChannelKey,
  parseImActor,
  registeredUserIdOf,
} from '../../src/core/im-identity.js'
import { userKey } from '../../src/core/memory.js'
import {
  assertCanSpend,
  chargePoints,
  getPointsBalance,
  resolveBillableUserId,
  setPointsQuota,
  usdToPoints,
  dailyPointsSeries,
} from '../../src/core/points.js'
import { mutateAccounts } from '../../src/core/accounts-store.js'

const saved: Record<string, string | undefined> = {}
let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agim-accounts-'))
  saved.AGIM_HOME = process.env.AGIM_HOME
  process.env.AGIM_HOME = tmp
  _resetAccountsCache()
  webThreadOwners._resetForTests()
})

afterEach(() => {
  _resetAccountsCache()
  webThreadOwners._resetForTests()
  if (saved.AGIM_HOME === undefined) delete process.env.AGIM_HOME
  else process.env.AGIM_HOME = saved.AGIM_HOME
  rmSync(tmp, { recursive: true, force: true })
})

describe('accounts', () => {
  it('first register is admin and does not need an invite', () => {
    expect(hasAnyUser()).toBe(false)
    const { user, session } = registerUser({ username: 'Alice', password: 'password1' })
    expect(user.role).toBe('admin')
    expect(user.username).toBe('alice')
    expect(verifyLoginSession(session.raw)?.id).toBe(user.id)
  })

  it('later register requires a valid invite', () => {
    registerUser({ username: 'admin', password: 'password1' })
    expect(() => registerUser({ username: 'bob', password: 'password1' })).toThrow()
    const invite = createInvite({ createdBy: 'admin' })
    const { user } = registerUser({ username: 'bob', password: 'password1', inviteRaw: invite.raw })
    expect(user.role).toBe('user')
  })

  it('rejects short passwords and bad usernames', () => {
    expect(() => registerUser({ username: 'ab', password: 'password1' })).toThrow()
    expect(() => registerUser({ username: 'okname', password: 'short' })).toThrow()
  })

  it('login issues a verifiable session', () => {
    registerUser({ username: 'carol', password: 'password1' })
    const session = loginUser({ username: 'Carol', password: 'password1' })
    expect(verifyLoginSession(session.raw)?.username).toBe('carol')
  })
})

describe('captcha', () => {
  it('accepts the issued answer once', () => {
    const cap = issueCaptcha()
    expect(cap.svg.includes('<svg')).toBe(true)
    // Answer is not returned; consume with a wrong guess fails.
    expect(consumeCaptcha(cap.id, 'NOPE')).toBe(false)
    const again = issueCaptcha()
    expect(consumeCaptcha(again.id, '')).toBe(false)
    const known = _issueCaptchaForTests('AB12')
    expect(consumeCaptcha(known.id, 'ab12')).toBe(true)
    expect(consumeCaptcha(known.id, 'ab12')).toBe(false)
  })
})

describe('points', () => {
  it('converts usd to points and charges a registered user', () => {
    expect(usdToPoints(0.001, 10_000)).toBe(10)
    const { user } = registerUser({ username: 'dana', password: 'password1' })
    const before = getPointsBalance(user.id)!
    expect(before.remaining).toBeGreaterThan(0)
    assertCanSpend(user.id)
    chargePoints({
      userId: user.id,
      tokensIn: 1000,
      tokensOut: 1000,
      costUsd: 0.01,
    })
    const after = getPointsBalance(user.id)!
    expect(after.remaining).toBe(before.remaining - 100)
    expect(after.unlimited).toBe(true)
  })

  it('admins keep spending after the monthly quota is exhausted', () => {
    const { user } = registerUser({ username: 'admin', password: 'password1' })
    expect(getPointsBalance(user.id)!.unlimited).toBe(true)
    chargePoints({
      userId: user.id,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 20,
    })
    const after = getPointsBalance(user.id)!
    expect(after.usedThisPeriod).toBe(200_000)
    expect(after.remaining).toBe(0)
    expect(after.unlimited).toBe(true)
    assertCanSpend(user.id)
    chargePoints({
      userId: user.id,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0.01,
    })
    expect(getPointsBalance(user.id)!.usedThisPeriod).toBe(200_100)
  })

  it('rejects granting quota to an admin and lets admins grant to users', () => {
    const { user: admin } = registerUser({ username: 'admin', password: 'password1' })
    expect(() => setPointsQuota(admin.id, { addBonus: 1000 })).toThrow(/管理员额度不限/)
    const invite = createInvite({ createdBy: admin.id })
    const { user } = registerUser({ username: 'bob', password: 'password1', inviteRaw: invite.raw })
    expect(getPointsBalance(user.id)!.unlimited).toBe(false)
    setPointsQuota(user.id, { monthlyLimit: 0, bonus: 0 })
    expect(() => assertCanSpend(user.id)).toThrow(/点数已用完/)
    const granted = setPointsQuota(user.id, { addBonus: 500 })
    expect(granted.bonus).toBe(500)
    expect(granted.remaining).toBe(500)
    assertCanSpend(user.id)
  })

  it('buckets spent points by UTC day and fills empty days', () => {
    const { user: admin } = registerUser({ username: 'admin', password: 'password1' })
    const invite = createInvite({ createdBy: admin.id })
    const { user } = registerUser({ username: 'cleo', password: 'password1', inviteRaw: invite.raw })
    const now = Date.parse('2026-08-25T15:30:00.000Z')
    mutateAccounts((data) => {
      data.ledger.push(
        {
          id: 'pt_d1',
          userId: user.id,
          delta: -40,
          reason: 'agim_turn',
          at: Date.parse('2026-08-24T08:00:00.000Z'),
        },
        {
          id: 'pt_d2',
          userId: user.id,
          delta: -15,
          reason: 'agim_turn',
          at: Date.parse('2026-08-25T01:00:00.000Z'),
        },
        {
          id: 'pt_grant',
          userId: user.id,
          delta: 500,
          reason: 'admin_grant',
          at: Date.parse('2026-08-25T02:00:00.000Z'),
        },
        {
          id: 'pt_old',
          userId: user.id,
          delta: -99,
          reason: 'agim_turn',
          at: Date.parse('2026-08-01T00:00:00.000Z'),
        },
      )
    })
    const series = dailyPointsSeries(user.id, 3, now)
    expect(series).toEqual([
      { day: '2026-08-23', spent: 0 },
      { day: '2026-08-24', spent: 40 },
      { day: '2026-08-25', spent: 15 },
    ])
  })
})

describe('im bind', () => {
  it('binds an IM identity to a registered user', () => {
    const { user } = registerUser({ username: 'erin', password: 'password1' })
    const row = bindImIdentity({
      platform: 'telegram',
      imUserId: '12345',
      userId: user.id,
      createdBy: user.id,
    })
    expect(row.userId).toBe(user.id)
    expect(findBinding('telegram', '12345')?.userId).toBe(user.id)
  })

  it('rebinds an occupied IM identity to the claiming user', () => {
    const { user: first } = registerUser({ username: 'gina', password: 'password1' })
    const invite = createInvite({ createdBy: first.id })
    const { user: second } = registerUser({ username: 'hank', password: 'password1', inviteRaw: invite.raw })
    bindImIdentity({
      platform: 'telegram',
      imUserId: '777',
      userId: first.id,
      createdBy: first.id,
    })
    const claimed = claimImIdentity({
      platform: 'telegram',
      imUserId: '777',
      userId: second.id,
    })
    expect(claimed.replacedUserId).toBe(first.id)
    expect(claimed.binding.userId).toBe(second.id)
    expect(findBinding('telegram', '777')?.userId).toBe(second.id)
    expect(resolveBillableUserId('telegram', '777')).toBe(second.id)
  })

  it('connecting a messenger stamps inbound keys with the signed-in user', () => {
    const { user } = registerUser({ username: 'ivy', password: 'password1' })
    claimMessengerPlatform('telegram', user.id)
    expect(findBinding('telegram', PLATFORM_CHANNEL)?.userId).toBe(user.id)
    expect(attachRegisteredIdentity('telegram', '12345')).toBe(`12345:${user.id}`)
    expect(userKey('telegram', '12345')).toBe(`telegram:12345:${user.id}`)
    expect(resolveBillableUserId('telegram', '12345')).toBe(user.id)
  })

  it('quota follows the registered user; IM is only a channel', () => {
    const { user } = registerUser({ username: 'frank', password: 'password1' })
    expect(resolveBillableUserId('telegram', '99999')).toBeNull()
    expect(resolveBillableUserId('discord', 'abc')).toBeNull()
    expect(resolveBillableUserId('web', 'thread-local')).toBeNull()
    expect(userKey('telegram', '99999')).toBe('telegram:99999')

    bindImIdentity({
      platform: 'telegram',
      imUserId: '99999',
      userId: user.id,
      createdBy: user.id,
    })

    expect(attachRegisteredIdentity('telegram', '99999')).toBe(`99999:${user.id}`)
    expect(imChannelKey('telegram', '99999', user.id)).toBe(`telegram:99999:${user.id}`)
    expect(parseImActor('telegram', `99999:${user.id}`)).toEqual({
      imUserId: '99999',
      registeredUserId: user.id,
    })
    expect(registeredUserIdOf('telegram', '99999')).toBe(user.id)
    expect(resolveBillableUserId('telegram', '99999')).toBe(user.id)
    expect(resolveBillableUserId('telegram', `telegram:99999:${user.id}`)).toBe(user.id)
    expect(resolveBillableUserId('telegram', `99999:${user.id}`)).toBe(user.id)
    expect(userKey('telegram', '99999')).toBe(`telegram:99999:${user.id}`)
    expect(resolveBillableUserId('web', user.id)).toBe(user.id)

    // A spoofed :usr_ suffix without a binding does not bill that user
    expect(resolveBillableUserId('discord', `abc:${user.id}`)).toBeNull()

    unbindImIdentity('telegram', '99999')
    expect(findBinding('telegram', '99999')).toBeNull()
    expect(attachRegisteredIdentity('telegram', `99999:${user.id}`)).toBe('99999')
    expect(resolveBillableUserId('telegram', '99999')).toBeNull()
  })
})

describe('legacy upgrade', () => {
  beforeEach(() => {
    bindAccountsModule(accounts)
    delete process.env.AGIM_WEB_AUTH
    delete process.env.AGIM_TRUST_LOOPBACK
  })

  function loopbackReq(): IncomingMessage {
    return {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
      url: '/api/auth/me',
    } as unknown as IncomingMessage
  }

  function sanitizeKey(raw: string): string {
    return raw.replace(/[^A-Za-z0-9_-]/g, (c) => {
      return createHash('sha256').update(c).digest('hex').slice(0, 8)
    })
  }

  function sessionJsonPath(threadId: string): string {
    return join(tmp, 'sessions', `${sanitizeKey(`web:web:${threadId}`)}.json`)
  }

  function writeSession(threadId: string, title: string): void {
    mkdirSync(join(tmp, 'sessions'), { recursive: true })
    writeFileSync(sessionJsonPath(threadId), `${JSON.stringify({
      title,
      lastActivity: Date.now(),
      agent: 'agim',
      platform: 'web',
      channelId: 'web',
      threadId,
      usage: { turns: 2 },
    }, null, 2)}\n`)
  }

  it('first admin claims messengers only; tokens wait for inherit', () => {
    const orphan = createToken('pre-account', { role: 'admin' })
    expect(getTokenUserId(orphan.id)).toBeUndefined()
    setLiveConfig({ messengers: ['feishu', 'wechat-ilink'] } as Config)
    const { user } = registerUser({ username: 'operator', password: 'password1' })
    const adopted = adoptLegacyInstall(user.id)
    expect(adopted.tokens).toBe(0)
    expect(getTokenUserId(orphan.id)).toBeUndefined()
    expect(findBinding('feishu', PLATFORM_CHANNEL)?.userId).toBe(user.id)
    expect(findBinding('wechat', PLATFORM_CHANNEL)?.userId).toBe(user.id)
  })

  it('lists unowned tokens and their sessions, then inherits one', () => {
    const keepToken = createToken('keep-token', { role: 'admin' })
    const dropToken = createToken('drop-token', { role: 'admin' })
    writeSession('web-keep-aaaa', 'Keep me')
    writeSession('web-drop-bbbb', 'Drop me')
    writeSession('web-local-cccc', 'Loopback chat')
    webThreadOwners.set('web-keep-aaaa', keepToken.id)
    webThreadOwners.set('web-drop-bbbb', dropToken.id)
    webThreadOwners.set('web-local-cccc', 'loopback')

    const { user } = registerUser({ username: 'operator', password: 'password1' })
    const preview = listLegacyUpgrade()
    expect(preview.pending).toBe(true)
    expect(preview.tokens.map((t) => t.id).sort()).toEqual([dropToken.id, keepToken.id].sort())
    expect(preview.tokens.find((t) => t.id === keepToken.id)?.sessions.map((s) => s.id)).toEqual(['web-keep-aaaa'])
    expect(preview.tokens.find((t) => t.id === dropToken.id)?.sessions.map((s) => s.id)).toEqual(['web-drop-bbbb'])
    expect(preview.local.sessions.map((s) => s.id)).toEqual(['web-local-cccc'])

    const result = inheritLegacySession(user.id, 'web-keep-aaaa')
    expect(result.inherited).toBe('web-keep-aaaa')
    expect(result.discardedSessions).toBe(2)
    expect(result.discardedTokens).toBe(2)
    expect(existsSync(sessionJsonPath('web-keep-aaaa'))).toBe(true)
    expect(existsSync(sessionJsonPath('web-drop-bbbb'))).toBe(false)
    expect(existsSync(sessionJsonPath('web-local-cccc'))).toBe(false)
    const kept = JSON.parse(readFileSync(sessionJsonPath('web-keep-aaaa'), 'utf-8')) as {
      ownerUserId?: string
      platform?: string
      channelId?: string
      threadId?: string
    }
    expect(kept.ownerUserId).toBe(user.id)
    expect(kept.platform).toBe('web')
    expect(kept.channelId).toBe('web')
    expect(kept.threadId).toBe('web-keep-aaaa')
    expect(webThreadOwners.get('web-keep-aaaa')).toBe(user.id)
    expect(getTokenUserId(keepToken.id)).toBeUndefined()
    expect(getTokenUserId(dropToken.id)).toBeUndefined()
    expect(listLegacyUpgrade().pending).toBe(false)
  })

  it('skip discards every unowned token and its sessions', () => {
    const orphan = createToken('pre-account', { role: 'admin' })
    writeSession('web-old-aaaa', 'Old chat')
    writeSession('web-local-bbbb', 'Loopback chat')
    webThreadOwners.set('web-old-aaaa', orphan.id)
    webThreadOwners.set('web-local-bbbb', 'anon')

    const { user } = registerUser({ username: 'operator', password: 'password1' })
    const result = skipLegacyUpgrade(user.id)
    expect(result.discardedSessions).toBe(2)
    expect(result.discardedTokens).toBe(1)
    expect(existsSync(sessionJsonPath('web-old-aaaa'))).toBe(false)
    expect(existsSync(sessionJsonPath('web-local-bbbb'))).toBe(false)
    expect(getTokenUserId(orphan.id)).toBeUndefined()
    expect(listLegacyUpgrade().pending).toBe(false)
  })

  it('loopback keeps acting as the sole admin after upgrade', () => {
    expect(resolveWebIdentity(loopbackReq())?.kind).toBe('loopback')
    expect(resolveWebIdentity(loopbackReq())?.userId).toBeUndefined()
    const { user } = registerUser({ username: 'operator', password: 'password1' })
    expect(getSoleEnabledUser()?.id).toBe(user.id)
    const ident = resolveWebIdentity(loopbackReq())
    expect(ident).toEqual({
      kind: 'loopback',
      role: 'admin',
      userId: user.id,
      username: 'operator',
    })
    const invite = createInvite({ createdBy: user.id })
    registerUser({ username: 'bob', password: 'password1', inviteRaw: invite.raw })
    expect(getSoleEnabledUser()).toBeNull()
    expect(resolveWebIdentity(loopbackReq())).toBeNull()
  })
})
