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
  getActiveLoop,
  parseLoopStartText,
  setLoopExit,
  setLoopObjective,
  startLoop,
  stopLoop,
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

  it('strips labels', () => {
    const p = parseLoopStartText('目标：发版；退出：CI 绿')
    expect(p.objective).toBe('发版')
    expect(p.exitDescription).toBe('CI 绿')
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
    expect(buildLoopSnippet(base.platform, base.channelId, threadId)).not.toContain('ALIGNING')
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

process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})
