import { describe, expect, it } from 'bun:test'
import {
  buildFocusSnippet,
  focusClear,
  focusOff,
  focusOn,
  getFocusOn,
  getFocusRetained,
  setFocus,
  type FocusRecord,
} from './focus.js'
import { _truncateForTests } from './goals.js'

const T = { platform: 'wechat', channelId: 'rest', threadId: 'focus-thread', userId: 'u1' }

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

describe('focus', () => {
  it('set → snippet; off stops inject; on restores; clear wipes', () => {
    reset()
    const set = setFocus({ ...T, title: 'Ship focus', body: 'details' })
    if (!hasSqliteRow(set)) return
    expect(set.enabled).toBe(true)
    const snip = buildFocusSnippet(T.platform, T.channelId, T.threadId)
    expect(snip).toContain('focus ON')
    expect(snip).toContain('Ship focus')
    expect(snip).not.toContain('complete_goal')

    const off = focusOff(T.platform, T.channelId, T.threadId)
    expect(off.ok).toBe(true)
    expect(getFocusOn(T.platform, T.channelId, T.threadId)).toBeNull()
    expect(buildFocusSnippet(T.platform, T.channelId, T.threadId)).toBe('')
    const retained = getFocusRetained(T.platform, T.channelId, T.threadId)
    expect(retained?.title).toBe('Ship focus')
    expect(retained?.enabled).toBe(false)

    const on = focusOn(T.platform, T.channelId, T.threadId)
    expect(on.ok).toBe(true)
    expect((on as { ok: true; focus: FocusRecord }).focus.title).toBe('Ship focus')

    expect(focusClear(T.platform, T.channelId, T.threadId).ok).toBe(true)
    expect(getFocusRetained(T.platform, T.channelId, T.threadId)).toBeNull()
  })
})
