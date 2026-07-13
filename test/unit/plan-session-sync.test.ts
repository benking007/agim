import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-plan-session-sync-'))
process.env.AGIM_HOME = TEST_HOME
delete process.env.AGIM_NATIVE_PLAN_MODE

const { sessionManager } = await import('../../src/core/session.js')
const {
  closePlanModeStateDb,
  effectivePlanModeOn,
  setPlanModeForThread,
} = await import('../../src/core/plan-mode-state.js')

afterAll(() => {
  sessionManager.stop()
  closePlanModeStateDb()
  rmSync(TEST_HOME, { recursive: true, force: true })
})

const describeSqlite = process.env.AGIM_TEST_REQUIRE_SQLITE === '1' ? describe : describe.skip

describeSqlite('Plan Mode session/state synchronization', () => {
  it('/new clears both the session flag and native policy state', async () => {
    const platform = 'test'
    const channelId = 'channel'
    const threadId = 'thread'
    const key = `${platform}:${channelId}:${threadId}`
    await sessionManager.start()
    await sessionManager.getOrCreateSession(platform, channelId, threadId, 'native')
    await sessionManager.patchSession(platform, channelId, threadId, { planMode: true })
    setPlanModeForThread(key, true)

    expect((await sessionManager.getExistingSession(platform, channelId, threadId))?.planMode).toBe(true)
    expect(effectivePlanModeOn(key)).toBe(true)

    const reset = await sessionManager.resetConversation(platform, channelId, threadId)
    expect(reset?.planMode).toBeUndefined()
    expect(effectivePlanModeOn(key)).toBe(false)
  })
})
