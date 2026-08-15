import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isLoopSchedulePrompt,
  loopMissionText,
  isHeadlessLoop,
  wakeLoopForThread,
  LOOP_PROMPT_PREFIX,
} from './loop-scheduler.js'
import { registry } from './registry.js'
import { sessionManager } from './session.js'
import { getActiveLoop, getLoopRun } from './loop-run.js'
import { _truncateForTests } from './goals.js'
import type { AgentAdapter } from './types.js'
import type { Logger } from 'pino'

const TMP = mkdtempSync(join(tmpdir(), 'agim-loop-sched-'))
process.env.AGIM_HOME = TMP
process.env.AGIM_LOOPS_DIR = join(TMP, 'loops')

const noopLogger = (() => {
  const noop = (..._args: unknown[]) => {}
  const stub: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    level: 'info', bindings: () => ({}),
  }
  stub.child = () => stub
  return stub as unknown as Logger
})()

function makeAgent(): AgentAdapter {
  return {
    name: 'agim',
    aliases: ['native', 'na'],
    isAvailable: async () => true,
    sendPrompt: async function* () { yield 'ok' },
  } as unknown as AgentAdapter
}

// bun cannot load better-sqlite3, and startLoop's Path-B focus seeding writes
// goals.db. Mirrors the loop-run.test.ts convention: bun skips the DB-backed
// assertions; `npm run test:sqlite` (AGIM_TEST_REQUIRE_SQLITE=1) requires them.
function sqliteAvailable(): boolean {
  return process.env.AGIM_TEST_REQUIRE_SQLITE === '1'
}

describe('loop-scheduler — prompt prefix parsing (pure, runs on bun)', () => {
  it('recognises loop: / loop： prefixes (case-insensitive)', () => {
    expect(isLoopSchedulePrompt('loop: 修好登录；退出：验收通过')).toBe(true)
    expect(isLoopSchedulePrompt('LOOP：修好登录')).toBe(true)
    expect(isLoopSchedulePrompt('loop:修复问题')).toBe(true)
    expect(isLoopSchedulePrompt('生成日报')).toBe(false)
    expect(isLoopSchedulePrompt('')).toBe(false)
    // `loop:` with nothing after is still a loop-prefix prompt; the caller
    // (schedule.ts) checks the extracted mission text for emptiness.
    expect(isLoopSchedulePrompt('loop:')).toBe(true)
  })

  it('strips the prefix and returns the mission text', () => {
    expect(loopMissionText('loop: 修好登录；退出：验收通过')).toBe('修好登录；退出：验收通过')
    expect(loopMissionText('LOOP：修复问题')).toBe('修复问题')
    expect(loopMissionText('loop:')).toBe('')
    expect(loopMissionText('普通任务')).toBe('')
  })

  it('exposes the prefix constant for schedule.ts', () => {
    expect(LOOP_PROMPT_PREFIX).toBe('loop:')
  })
})

describe('loop-scheduler — headless detection (pure, runs on bun)', () => {
  const saved = process.env.AGIM_LOOP_HEADLESS

  afterEach(() => {
    if (saved === undefined) delete process.env.AGIM_LOOP_HEADLESS
    else process.env.AGIM_LOOP_HEADLESS = saved
  })

  it('defaults to interactive (not headless)', () => {
    expect(isHeadlessLoop('修好登录；退出：验收通过')).toBe(false)
  })

  it('env AGIM_LOOP_HEADLESS=1 opts in', () => {
    process.env.AGIM_LOOP_HEADLESS = '1'
    expect(isHeadlessLoop('修好登录；退出：验收通过')).toBe(true)
  })

  it('mission text 无人值守 / headless opts in', () => {
    expect(isHeadlessLoop('修好登录；退出：验收通过或无人值守')).toBe(true)
    expect(isHeadlessLoop('Fix login; exit: headless run')).toBe(true)
  })
})

describe('wakeLoopForThread', () => {
  beforeEach(() => {
    try { _truncateForTests() } catch { /* ignore */ }
    try { sessionManager.stop() } catch { /* ignore */ }
  })

  afterEach(() => {
    try { sessionManager.stop() } catch { /* ignore */ }
    rmSync(join(TMP, 'sessions'), { recursive: true, force: true })
  })

  it('rejects empty mission text (runs on bun)', async () => {
    const r = await wakeLoopForThread({
      platform: 'web', channelId: 'c', threadId: 't', userId: 'u1', missionText: '   ',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('empty mission text')
  })

  it('surfaces failures as { ok:false } and never throws', async () => {
    const r = await wakeLoopForThread({
      platform: 'web', channelId: 'c', threadId: 't-fail', userId: 'u1',
      missionText: '修好登录；退出：验收通过',
    })
    // The contract: wake returns a structured error, never throws.
    // The exact failure differs by environment:
    //   - bun (no better-sqlite3): startLoop Path-B focus seeding fails
    //     → focus_set_failed / focus_required;
    //   - sqlite (node pool, no registered agent): 'Agim Agent not registered'.
    if (!r.ok) {
      expect([
        'focus_set_failed',
        'focus_required',
        'Agim Agent not registered',
      ]).toContain(r.error)
      return
    }
    throw new Error(`expected wake to fail in this environment, got ok: ${JSON.stringify(r.run?.status)}`)
  })

  it('creates a confirmed planning Loop and returns the run', async () => {
    registry.registerAgent(makeAgent())
    const r = await wakeLoopForThread({
      platform: 'web', channelId: 'cron-1', threadId: 't3', userId: 'u1',
      missionText: '修好登录；退出条件为验收通过或最多5轮',
    })
    if (!r.ok) {
      if (sqliteAvailable()) throw new Error(`wake failed on sqlite: ${r.error}`)
      return // bun: DB-backed path skipped (see suite header)
    }
    expect(r.started).toBe(true)
    expect(r.skipped).toBe(false)
    expect(r.run.status).toBe('planning')
    expect(r.run.round).toBe(1)
    expect(r.run.mission?.objective).toContain('修好登录')
    expect(r.run.maxRounds).toBe(5)

    // The Loop is visible via the standard reader.
    const active = getActiveLoop('web', 'cron-1', 't3')
    expect(active?.id).toBe(r.run.id)
  })

  it('skips cleanly when a Loop is already active on the thread', async () => {
    registry.registerAgent(makeAgent())
    const first = await wakeLoopForThread({
      platform: 'web', channelId: 'cron-2', threadId: 't4', userId: 'u1',
      missionText: '修好登录；退出条件为验收通过或最多5轮',
    })
    if (!first.ok) {
      if (sqliteAvailable()) throw new Error(`first wake failed on sqlite: ${first.error}`)
      return
    }

    const second = await wakeLoopForThread({
      platform: 'web', channelId: 'cron-2', threadId: 't4', userId: 'u1',
      missionText: '另一个目标；退出条件为验收通过',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.started).toBe(false)
    expect(second.skipped).toBe(true)
    expect(second.run.id).toBe(first.run.id)
  })

  it('leaves a persistent Loop run on disk for later turns', async () => {
    registry.registerAgent(makeAgent())
    const r = await wakeLoopForThread({
      platform: 'web', channelId: 'cron-3', threadId: 't5', userId: 'u1',
      missionText: '研究定价；退出条件为输出报告或最多3轮',
    })
    if (!r.ok) {
      if (sqliteAvailable()) throw new Error(`wake failed on sqlite: ${r.error}`)
      return
    }
    const onDisk = getLoopRun('web', 'cron-3', 't5')
    expect(onDisk?.status).toBe('planning')
    expect(onDisk?.mission?.objective).toContain('研究定价')
  })
})
