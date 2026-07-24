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
  getActiveLoop,
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

describe('loop-run paths A/B', () => {
  it('path A: existing focus, end keeps focus on', () => {
    reset()
    const threadId = 'loop-a'
    const focus = setFocus({ ...base, threadId, title: 'Keep me' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId, text: 'note' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.path).toBe('A')
    expect(started.run.openedFocus).toBe(false)
    expect(buildLoopSnippet(base.platform, base.channelId, threadId)).toContain('loop ACTIVE')

    stopLoop(base.platform, base.channelId, threadId, 'user_stop')
    expect(getActiveLoop(base.platform, base.channelId, threadId)).toBeNull()
    expect(getFocusOn(base.platform, base.channelId, threadId)?.title).toBe('Keep me')
  })

  it('path B: auto focus, end turns focus off', () => {
    reset()
    const threadId = 'loop-b'
    const started = startLoop({ ...base, threadId, text: 'Build loop' })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      // Without sqlite, focus_set_failed / need path fails soft
      return
    }
    expect(started.path).toBe('B')
    expect(started.run.openedFocus).toBe(true)
    expect(getFocusOn(base.platform, base.channelId, threadId)?.title).toBe('Build loop')

    stopLoop(base.platform, base.channelId, threadId, 'user_stop')
    expect(getFocusOn(base.platform, base.channelId, threadId)).toBeNull()
  })

  it('path B without text refuses', () => {
    reset()
    const r = startLoop({ ...base, threadId: 'loop-need-text', text: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('need_text')
  })

  it('focus off cancels active loop', () => {
    reset()
    const threadId = 'loop-focus-off'
    const focus = setFocus({ ...base, threadId, title: 'X' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId })
    expect(started.ok).toBe(true)
    cancelLoopForFocusOff(base.platform, base.channelId, threadId)
    expect(getActiveLoop(base.platform, base.channelId, threadId)).toBeNull()
  })

  it('loop_verdict stop ends loop (path B focus off)', () => {
    reset()
    const threadId = 'loop-verdict'
    const started = startLoop({ ...base, threadId, text: 'Mission' })
    if (!started.ok) return
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
