import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFocus, getFocusOn } from './focus.js'
import { _truncateForTests } from './goals.js'
import {
  applyLoopVerdict,
  buildLoopSnippet,
  cancelLoopForFocusOff,
  confirmLoopMission,
  formatLoopStatus,
  getActiveLoop,
  getLoopRun,
  getMissionView,
  isLoopWallExceeded,
  noteLoopDispatch,
  parseExitConstraints,
  parseLoopStartText,
  setLoopAcceptance,
  setLoopExit,
  setLoopObjective,
  startLoop,
  stopLoop,
  _touchLoopCreatedAtForTests,
} from './loop-run.js'

const TMP = mkdtempSync(join(tmpdir(), 'agim-loop-'))
process.env.AGIM_LOOPS_DIR = join(TMP, 'loops')

const base = { platform: 'wechat', channelId: 'rest', userId: 'u1' }

function reset(): void {
  try { _truncateForTests() } catch { /* ignore */ }
}

function hasSqliteRow<T>(row: T | null): row is T {
  if (row !== null) return true
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error('SQLite is required by the Node persistence suite')
  }
  return false
}

describe('parseLoopStartText', () => {
  it('splits objective and exit', () => {
    const p = parseLoopStartText('修好登录超时；退出：验收通过或最多5轮')
    expect(p.objective).toBe('修好登录超时')
    expect(p.exitDescription).toContain('验收通过')
    expect(p.maxRounds).toBe(5)
  })

  it('accepts 退出条件为 / 退出条件是 (natural language)', () => {
    const a = parseLoopStartText('修好登录超时；退出条件为验收通过或最多5轮')
    expect(a.objective).toBe('修好登录超时')
    expect(a.exitDescription).toBe('验收通过或最多5轮')
    expect(a.maxRounds).toBe(5)

    const b = parseLoopStartText('发版前压掉 flaky，退出条件是主分支绿')
    expect(b.objective).toBe('发版前压掉 flaky')
    expect(b.exitDescription).toBe('主分支绿')

    const c = parseLoopStartText('修好登录 退出条件为验收通过')
    expect(c.objective).toBe('修好登录')
    expect(c.exitDescription).toBe('验收通过')
  })

  it('strips labels', () => {
    const p = parseLoopStartText('目标：发版；退出：CI 绿')
    expect(p.objective).toBe('发版')
    expect(p.exitDescription).toBe('CI 绿')
  })

  it('parses acceptance + wall clock from NL', () => {
    const p = parseLoopStartText('修好登录；验收：补回归；退出条件为验收通过或最多3轮或超过2小时')
    expect(p.objective).toBe('修好登录')
    expect(p.acceptance).toBe('补回归')
    expect(p.exitDescription).toContain('验收通过')
    expect(p.maxRounds).toBe(3)
    expect(p.maxWallMs).toBe(2 * 3_600_000)
  })

  it('parseExitConstraints minutes', () => {
    const c = parseExitConstraints('卡住就停，超过 45 分钟')
    expect(c.maxWallMs).toBe(45 * 60_000)
  })
})

describe('loop-run R2 Mission persist', () => {
  it('partial mission while aligning survives disk reload; status shows both hard fields', () => {
    reset()
    const threadId = 'loop-r2-partial'
    const focus = setFocus({ ...base, threadId, title: 'Ship v2' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.run.status).toBe('aligning')
    expect(started.run.sessionKey).toContain('loop-r2-partial')
    expect(started.run.mission?.objective).toContain('Ship v2')

    setLoopExit(base.platform, base.channelId, threadId, 'CI 绿，最多 4 轮')
    const reloaded = getLoopRun(base.platform, base.channelId, threadId)
    expect(reloaded).toBeTruthy()
    if (!reloaded) return
    const view = getMissionView(reloaded)
    expect(view.objective).toContain('Ship v2')
    expect(view.exitDescription).toContain('CI 绿')
    expect(view.maxRounds).toBe(4)
    expect(view.confirmed).toBe(false)

    const status = formatLoopStatus(reloaded)
    expect(status).toContain('Ship v2')
    expect(status).toContain('CI 绿')
    expect(status).toContain('**目标**')
    expect(status).toContain('**退出条件**')
  })

  it('confirmed mission + acceptance round-trips; status readable after reload', () => {
    reset()
    const threadId = 'loop-r2-confirm'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好超时；验收：有单测；退出条件为验收通过或最多3轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.aligned).toBe(true)
    expect(started.run.mission?.acceptance).toBe('有单测')
    expect(started.run.mission?.exit.maxRounds).toBe(3)

    setLoopAcceptance(base.platform, base.channelId, threadId, '单测 + 手工点一次登录')
    const reloaded = getLoopRun(base.platform, base.channelId, threadId)
    expect(reloaded?.status).toBe('planning')
    const status = formatLoopStatus(reloaded!)
    expect(status).toContain('修好超时')
    expect(status).toContain('验收通过')
    expect(status).toContain('单测 + 手工点一次登录')
    expect(getMissionView(reloaded!).confirmed).toBe(true)
  })
})

describe('loop-run R1 ALIGNING', () => {
  it('path A without exit stays aligning', () => {
    reset()
    const threadId = 'loop-a-align'
    const focus = setFocus({ ...base, threadId, title: 'Keep me' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId, text: 'note' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.path).toBe('A')
    expect(started.aligned).toBe(false)
    expect(started.run.status).toBe('aligning')
    expect(started.run.draftObjective).toContain('Keep me')
    expect(started.run.startNote).toBe('note')
    expect(buildLoopSnippet(base.platform, base.channelId, threadId)).toContain('ALIGNING')
    expect(buildLoopSnippet(base.platform, base.channelId, threadId)).toContain('do NOT call')

    // verdict blocked while aligning
    const blocked = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'nope',
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toBe('aligning')

    stopLoop(base.platform, base.channelId, threadId, 'user_stop')
    expect(getFocusOn(base.platform, base.channelId, threadId)?.title).toBe('Keep me')
  })

  it('path B without exit stays aligning; end focus off', () => {
    reset()
    const threadId = 'loop-b-align'
    const started = startLoop({ ...base, threadId, text: 'Build loop' })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.path).toBe('B')
    expect(started.aligned).toBe(false)
    expect(started.run.status).toBe('aligning')
    expect(getFocusOn(base.platform, base.channelId, threadId)?.title).toBe('Build loop')

    stopLoop(base.platform, base.channelId, threadId, 'user_stop')
    expect(getFocusOn(base.platform, base.channelId, threadId)).toBeNull()
  })

  it('both hard inputs → planning (skip aligning)', () => {
    reset()
    const threadId = 'loop-aligned'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好超时；退出：验收通过或最多3轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.aligned).toBe(true)
    expect(started.run.status).toBe('planning')
    expect(started.run.mission?.objective).toContain('修好超时')
    expect(started.run.mission?.exit.description).toContain('验收通过')
    expect(started.run.maxRounds).toBe(3)
    const snip = buildLoopSnippet(base.platform, base.channelId, threadId)
    expect(snip).not.toContain('ALIGNING')
    expect(snip).toContain('MUST decompose')
    expect(snip).toContain('call_agents')
  })

  it('objective + exit + confirm leaves aligning', () => {
    reset()
    const threadId = 'loop-confirm'
    const focus = setFocus({ ...base, threadId, title: 'Ship it' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.run.status).toBe('aligning')

    const o = setLoopObjective(base.platform, base.channelId, threadId, 'Ship v2')
    expect(o.ok).toBe(true)
    const e = setLoopExit(base.platform, base.channelId, threadId, 'CI 绿，最多 4 轮')
    expect(e.ok).toBe(true)
    if (!e.ok) return
    expect(e.run.maxRounds).toBe(4)

    const incomplete = confirmLoopMission(base.platform, base.channelId, threadId)
    // both drafts set → should confirm
    expect(incomplete.ok).toBe(true)
    if (!incomplete.ok) return
    expect(incomplete.run.status).toBe('planning')
    expect(incomplete.run.mission?.objective).toBe('Ship v2')
    expect(incomplete.run.round).toBe(1)

    const r = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'done',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.run.status).toBe('ended')
    expect(r.run.endReason).toBe('stop_verdict')
  })

  it('path B without text refuses', () => {
    reset()
    const r = startLoop({ ...base, threadId: 'loop-need-text', text: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('need_text')
  })

  it('focus off cancels active loop (even aligning)', () => {
    reset()
    const threadId = 'loop-focus-off'
    const focus = setFocus({ ...base, threadId, title: 'X' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId })
    expect(started.ok).toBe(true)
    cancelLoopForFocusOff(base.platform, base.channelId, threadId)
    expect(getActiveLoop(base.platform, base.channelId, threadId)).toBeNull()
  })

  it('loop_verdict stop ends confirmed loop (path B focus off)', () => {
    reset()
    const threadId = 'loop-verdict'
    const started = startLoop({
      ...base,
      threadId,
      text: 'Mission；退出：验收通过',
    })
    if (!started.ok) return
    expect(started.run.status).toBe('planning')
    const r = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'good enough',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.run.status).toBe('ended')
    expect(r.run.endReason).toBe('stop_verdict')
    expect(getFocusOn(base.platform, base.channelId, threadId)).toBeNull()
  })
})

describe('loop-run R3 PLAN+DISPATCH', () => {
  it('continue/revise without dispatch is refused; stop still works', () => {
    reset()
    const threadId = 'loop-r3-gate'
    const started = startLoop({
      ...base,
      threadId,
      text: '拆解任务；退出条件为验收通过或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.status).toBe('planning')
    expect(started.run.dispatchesThisRound).toBe(0)

    const cont = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'skip dispatch',
    })
    expect(cont.ok).toBe(false)
    if (!cont.ok) expect(cont.error).toBe('no_dispatch')
    expect(getActiveLoop(base.platform, base.channelId, threadId)?.round).toBe(1)

    const rev = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'revise',
      summary: 'still no dispatch',
    })
    expect(rev.ok).toBe(false)

    const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'abandon',
    })
    expect(stop.ok).toBe(true)
  })

  it('dispatch then continue advances round and resets counter', () => {
    reset()
    const threadId = 'loop-r3-advance'
    const started = startLoop({
      ...base,
      threadId,
      text: '并行调研；退出条件为有结论或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }

    const noted = noteLoopDispatch(base.platform, base.channelId, threadId, {
      count: 2,
      tasks: [
        { id: '1', brief: '查日志', agentHint: 'agim/cheap' },
        { id: '2', brief: '写复现', agentHint: 'claude-code' },
      ],
    })
    expect(noted?.status).toBe('dispatching')
    expect(noted?.dispatchesThisRound).toBe(2)
    expect(noted?.lastPlan?.tasks.length).toBe(2)

    const status = formatLoopStatus(noted!)
    expect(status).toContain('本轮派工：2')
    expect(status).toContain('查日志')

    const snip = buildLoopSnippet(base.platform, base.channelId, threadId)
    expect(snip).toContain('VERIFY (R4)')
    expect(snip).not.toContain('MUST decompose')

    const cont = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'need another pass',
      met: false,
      gaps: ['flaky still red'],
      nextDirection: 'focus on flaky test',
    })
    expect(cont.ok).toBe(true)
    if (!cont.ok) return
    expect(cont.run.round).toBe(2)
    expect(cont.run.dispatchesThisRound).toBe(0)
    expect(cont.run.status).toBe('planning')
    expect(cont.run.lastVerification?.met).toBe(false)
    expect(cont.run.lastVerification?.nextDirection).toContain('flaky')
  })
})

describe('loop-run R4 VERIFY+REFLECT', () => {
  it('continue without met/nextDirection is refused', () => {
    reset()
    const threadId = 'loop-r4-need-verify'
    const started = startLoop({
      ...base,
      threadId,
      text: '验收闭环；退出条件为达标或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })

    const noMet = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'tried',
    })
    expect(noMet.ok).toBe(false)
    if (!noMet.ok) expect(noMet.error).toBe('need_verification')

    const noDir = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'still gaps',
      met: false,
    })
    expect(noDir.ok).toBe(false)
    if (!noDir.ok) expect(noDir.error).toBe('need_next_direction')

    const metContinue = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'looks done',
      met: true,
    })
    expect(metContinue.ok).toBe(false)
    if (!metContinue.ok) expect(metContinue.error).toBe('met_use_stop')
  })

  it('stop with met=true ends as objective_met', () => {
    reset()
    const threadId = 'loop-r4-met'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好登录；退出条件为验收通过或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    noteLoopDispatch(base.platform, base.channelId, threadId, {
      count: 1,
      tasks: [{ id: '1', brief: 'fix timeout', agentHint: 'agim' }],
    })

    const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'regression green; login ok',
      met: true,
    })
    expect(stop.ok).toBe(true)
    if (!stop.ok) return
    expect(stop.run.status).toBe('ended')
    expect(stop.run.endReason).toBe('objective_met')
    expect(stop.run.lastVerification?.met).toBe(true)
    expect(formatLoopStatus(stop.run)).toContain('达标结束')
    expect(formatLoopStatus(stop.run)).toContain('regression green')
  })

  it('maxRounds truncates after verify-unmet', () => {
    reset()
    const threadId = 'loop-r4-rounds'
    const started = startLoop({
      ...base,
      threadId,
      text: '短跑；退出条件为最多 1 轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.maxRounds).toBe(1)
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
    const r = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'not yet',
      met: false,
      nextDirection: 'try again',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.run.status).toBe('ended')
    expect(r.run.endReason).toBe('limit')
  })

  it('maxWallMs truncates on verdict', () => {
    reset()
    const threadId = 'loop-r4-wall'
    const started = startLoop({
      ...base,
      threadId,
      text: '墙钟；退出条件为超过 1 分钟或最多 5 轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.mission?.exit.maxWallMs).toBe(60_000)
    _touchLoopCreatedAtForTests(
      base.platform, base.channelId, threadId, Date.now() - 120_000,
    )
    expect(isLoopWallExceeded(getLoopRun(base.platform, base.channelId, threadId)!)).toBe(true)

    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
    const r = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'still going',
      met: false,
      nextDirection: 'more',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.run.endReason).toBe('wall_limit')
  })
})

process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})
