import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetAccountsCache } from '../../src/core/accounts-store.js'
import {
  createInvite,
  hasAnyUser,
  loginUser,
  registerUser,
  verifyLoginSession,
} from '../../src/core/accounts.js'
import { consumeCaptcha, issueCaptcha, _issueCaptchaForTests } from '../../src/core/captcha.js'
import { bindImIdentity, claimImIdentity, findBinding, unbindImIdentity } from '../../src/core/im-bind.js'
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
  usdToPoints,
} from '../../src/core/points.js'

const saved: Record<string, string | undefined> = {}
let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agim-accounts-'))
  saved.AGIM_HOME = process.env.AGIM_HOME
  process.env.AGIM_HOME = tmp
  _resetAccountsCache()
})

afterEach(() => {
  _resetAccountsCache()
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
