import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const originalAgimHome = process.env.AGIM_HOME
const originalLegacyEnv = process.env.AGIM_ADMIN_USERS

const testHome = mkdtempSync(join(tmpdir(), 'agim-admin-allowlist-'))
process.env.AGIM_HOME = testHome
process.env.AGIM_ENV_FILE_PATH = ''

type AllowlistModule = typeof import('../../src/core/admin-allowlist.js')
let cachedModule: AllowlistModule | null = null

async function loadAllowlist(): Promise<AllowlistModule> {
  if (!cachedModule) {
    cachedModule = await import('../../src/core/admin-allowlist.js')
  }
  return cachedModule
}

function storeFile(): string {
  return join(testHome, 'im-admins.json')
}

describe('admin-allowlist', () => {
  beforeEach(async () => {
    delete process.env.AGIM_ADMIN_USERS
    rmSync(storeFile(), { force: true })
    const mod = await loadAllowlist()
    mod._resetCache()
  })

  afterAll(() => {
    if (originalAgimHome === undefined) delete process.env.AGIM_HOME
    else process.env.AGIM_HOME = originalAgimHome
    if (originalLegacyEnv === undefined) delete process.env.AGIM_ADMIN_USERS
    else process.env.AGIM_ADMIN_USERS = originalLegacyEnv
    rmSync(testHome, { recursive: true, force: true })
  })

  it('is unconfigured by default', async () => {
    const mod = await loadAllowlist()
    expect(mod.isAllowlistConfigured()).toBe(false)
    expect(mod.listAdmins()).toEqual([])
    expect(mod.listKnownImUsers()).toEqual([])
  })

  it('promoteAdmin / revokeAdmin updates the persisted registry', async () => {
    const mod = await loadAllowlist()
    expect(await mod.promoteAdmin('Telegram', '123')).toBe(true)
    expect(mod.isAdmin('telegram', '123')).toBe(true)
    expect(mod.isAllowlistConfigured()).toBe(true)
    expect(mod.listAdmins()).toEqual([{ platform: 'telegram', userId: '123' }])
    expect(existsSync(storeFile())).toBe(true)

    expect(await mod.revokeAdmin('telegram', '123')).toBe(true)
    expect(mod.isAdmin('telegram', '123')).toBe(false)
    expect(mod.isAllowlistConfigured()).toBe(false)
  })

  it('records and refreshes known IM users from inbound messages', async () => {
    const mod = await loadAllowlist()
    expect(mod.recordSeenImUser('wechat-ilink', 'wxid_abc', { channelId: 'room-1', threadId: 't-1' })).toBe(true)
    const first = mod.listKnownImUsers()
    expect(first).toHaveLength(1)
    expect(first[0]?.platform).toBe('wechat-ilink')
    expect(first[0]?.userId).toBe('wxid_abc')
    expect(first[0]?.lastChannelId).toBe('room-1')

    expect(mod.recordSeenImUser('wechat-ilink', 'wxid_abc', { channelId: 'room-2', threadId: 't-2' })).toBe(true)
    const second = mod.listKnownImUsers()
    expect(second).toHaveLength(1)
    expect(second[0]?.lastChannelId).toBe('room-2')
    expect(second[0]?.lastThreadId).toBe('t-2')
  })

  it('imports legacy AGIM_ADMIN_USERS into im-admins.json once', async () => {
    process.env.AGIM_ADMIN_USERS = 'telegram:123,broken,wechat-ilink:wxid_1'
    const mod = await loadAllowlist()
    mod._resetCache()
    expect(mod.listAdmins()).toEqual([
      { platform: 'telegram', userId: '123' },
      { platform: 'wechat-ilink', userId: 'wxid_1' },
    ])
    const raw = JSON.parse(readFileSync(storeFile(), 'utf-8')) as { admins?: Array<{ platform: string; userId: string }> }
    expect(raw.admins?.length).toBe(2)
  })

  it('denialMessage points users to Web settings (no setup token flow)', async () => {
    const mod = await loadAllowlist()
    const msg = mod.denialMessage('telegram', '12345')
    expect(msg).toContain('设置 → 管理员')
    expect(msg).toContain('telegram:12345')
    expect(msg).not.toContain('/setup admin')
  })
})
