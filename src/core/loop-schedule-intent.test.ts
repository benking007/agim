import { afterEach, describe, expect, it } from 'bun:test'
import {
  commitPendingLoopSchedule,
  openScheduledLoopDraft,
  tryDetectScheduledLoopIntent,
  tryHandleScheduledLoopTurn,
} from './loop-schedule-intent.js'
import {
  _clearLoopScheduleForTest,
  getPendingLoopSchedule,
} from './pending-loop-schedule.js'
import { registry } from './registry.js'
import { deleteSchedule, listSchedules } from './schedule.js'
import type { AgentAdapter } from './types.js'

function sqliteAvailable(): boolean {
  return process.env.AGIM_TEST_REQUIRE_SQLITE === '1'
}

function makeAgim(): AgentAdapter {
  return {
    name: 'agim',
    aliases: ['native', 'na'],
    isAvailable: async () => true,
    sendPrompt: async function* () { yield 'ok' },
  } as unknown as AgentAdapter
}

const BASE = {
  platform: 'wechat',
  channelId: 'c1',
  threadId: 't1',
  userId: 'u1',
}

afterEach(() => {
  _clearLoopScheduleForTest()
})

describe('tryDetectScheduledLoopIntent', () => {
  it('ignores reminder-shaped lines (no Loop wording)', async () => {
    const r = await tryDetectScheduledLoopIntent({
      ...BASE, text: '每天8点提醒我吃药',
    })
    expect(r.handled).toBe(false)
    expect(getPendingLoopSchedule('wechat:c1:t1')).toBeNull()
  })

  it('ignores slash commands', async () => {
    const r = await tryDetectScheduledLoopIntent({
      ...BASE, text: '/cron create x agim "0 2 * * *" loop: 修登录；退出条件为验收通过',
    })
    expect(r.handled).toBe(false)
  })

  it('proposes a card when clock + objective + exit are complete (no LLM)', async () => {
    const r = await tryDetectScheduledLoopIntent({
      ...BASE,
      text: '每天凌晨2点用 Loop 修登录超时；退出条件为验收通过或最多5轮',
    })
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('定时 Loop')
    expect(r.reply).toContain('0 2 * * *')
    expect(r.reply).toContain('修登录')
    expect(r.reply).toContain('验收通过')
    const pending = getPendingLoopSchedule('wechat:c1:t1')
    expect(pending?.cron).toBe('0 2 * * *')
    expect(pending?.objective).toContain('修登录')
    expect(pending?.exitDescription).toContain('验收通过')
  })

  it('hints for a missing exit and does not stash pending', async () => {
    const r = await tryDetectScheduledLoopIntent({
      ...BASE,
      text: '每天凌晨2点用 Loop 修登录超时',
    })
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('退出条件')
    expect(getPendingLoopSchedule('wechat:c1:t1')).toBeNull()
  })

  it('dock surface stashes a draft even when exit is missing', async () => {
    const r = await tryDetectScheduledLoopIntent({
      ...BASE,
      platform: 'web',
      channelId: 'web',
      threadId: 'web-dock',
      text: '开个定时 loop',
      surface: 'dock',
    })
    expect(r.handled).toBe(true)
    expect(r.dock).toBe(true)
    expect(r.reply).toContain('底栏')
    const pending = getPendingLoopSchedule('web:web:web-dock')
    expect(pending).not.toBeNull()
    expect(pending?.objective).toBe('')
    expect(pending?.exitDescription).toBe('')
  })
})

describe('openScheduledLoopDraft /cronloop', () => {
  it('opens an empty dock draft', () => {
    const r = openScheduledLoopDraft({
      platform: 'web',
      channelId: 'web',
      threadId: 't-cronloop',
      surface: 'dock',
    })
    expect(r.handled).toBe(true)
    expect(r.dock).toBe(true)
    expect(getPendingLoopSchedule('web:web:t-cronloop')).not.toBeNull()
  })

  it('pre-fills clock + mission from the rest of the line', () => {
    const r = openScheduledLoopDraft({
      platform: 'web',
      channelId: 'web',
      threadId: 't-fill',
      text: '每天凌晨2点 修登录；退出条件为验收通过或最多5轮',
      surface: 'dock',
    })
    expect(r.handled).toBe(true)
    const pending = getPendingLoopSchedule('web:web:t-fill')
    expect(pending?.cron).toBe('0 2 * * *')
    expect(pending?.objective).toContain('修登录')
    expect(pending?.exitDescription).toContain('验收通过')
  })
})

describe('tryHandleScheduledLoopTurn y/n', () => {
  it('cancels a pending card', async () => {
    await tryDetectScheduledLoopIntent({
      ...BASE,
      text: '每天凌晨2点用 Loop 修登录；退出条件为验收通过或最多3轮',
    })
    expect(getPendingLoopSchedule('wechat:c1:t1')).not.toBeNull()
    const r = await tryHandleScheduledLoopTurn({ ...BASE, text: 'n' })
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('已忽略')
    expect(getPendingLoopSchedule('wechat:c1:t1')).toBeNull()
  })

  it('confirm without sqlite returns a structured create error (no throw)', async () => {
    await tryDetectScheduledLoopIntent({
      ...BASE,
      text: '每天凌晨2点用 Loop 修登录；退出条件为验收通过或最多3轮',
    })
    const r = await tryHandleScheduledLoopTurn({ ...BASE, text: 'y' })
    expect(r.handled).toBe(true)
    if (sqliteAvailable()) {
      // Agent may or may not be registered in this process; never throw.
      expect(r.reply).toMatch(/已创建定时 Loop|创建失败/)
    } else {
      expect(r.reply).toContain('创建失败')
    }
  })

  it('sqlite: y on the card writes a loop: cron row', async () => {
    if (!sqliteAvailable()) return
    registry.registerAgent(makeAgim())
    await tryDetectScheduledLoopIntent({
      ...BASE,
      userId: 'u-nl-loop',
      text: '每天凌晨2点用 Loop 修登录确认卡；退出条件为验收通过或最多5轮',
    })
    const r = await tryHandleScheduledLoopTurn({
      ...BASE,
      userId: 'u-nl-loop',
      text: 'y',
    })
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('已创建定时 Loop')
    const created = listSchedules().find((s) => s.prompt.includes('修登录确认卡'))
    expect(created).toBeDefined()
    expect(created?.cron).toBe('0 2 * * *')
    expect(created?.agent).toBe('agim')
    expect(created?.prompt.startsWith('loop:')).toBe(true)
    expect(created?.prompt).toContain('退出条件为验收通过')
    if (created) deleteSchedule(created.id)
  })
})

describe('dock confirm writes loop: cron', () => {
  it('sqlite: commit after /cronloop draft writes a loop: row', () => {
    if (!sqliteAvailable()) return
    registry.registerAgent(makeAgim())
    openScheduledLoopDraft({
      platform: 'web',
      channelId: 'web',
      threadId: 't-dock-commit',
      text: '每天凌晨2点 修登录底栏；退出条件为验收通过或最多5轮',
      surface: 'dock',
    })
    const pending = getPendingLoopSchedule('web:web:t-dock-commit')
    expect(pending).not.toBeNull()
    const created = commitPendingLoopSchedule({
      pending: pending!,
      userId: 'u-dock',
    })
    expect(created.ok).toBe(true)
    const row = listSchedules().find((s) => s.prompt.includes('修登录底栏'))
    expect(row).toBeDefined()
    expect(row?.cron).toBe('0 2 * * *')
    expect(row?.agent).toBe('agim')
    expect(row?.prompt.startsWith('loop:')).toBe(true)
    if (row) deleteSchedule(row.id)
  })
})
