// Unit tests for the goals store + buildGoalSnippet.
//
// As with heartbeat-store, better-sqlite3's native binding isn't built
// in the CI image, so the store gracefully no-ops. We assert on the
// behaviour callers see in both the "DB available" and "DB missing"
// paths so neither regresses.

import { describe, it, expect } from 'bun:test'
import {
  setActiveGoal, appendProgress, updateStatus, resumeGoal,
  getActiveGoal, getGoalById, listGoalsForThread, listAllActiveGoals,
  buildGoalSnippet, formatGoalShow,
  MAX_TITLE_CHARS, MAX_BODY_CHARS,
  _truncateForTests,
} from './goals.js'

const T = { platform: 'wechat', channelId: 'rest', threadId: 'thread-1', userId: 'u1' }
const T2 = { platform: 'wechat', channelId: 'rest', threadId: 'thread-2', userId: 'u2' }

function reset(): void {
  // Safe no-op when DB is unavailable.
  try { _truncateForTests() } catch { /* ignore */ }
}

function hasSqliteRow<T>(row: T | null): row is T {
  if (row !== null) return true
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error('SQLite is required by the Node persistence suite')
  }
  return false
}

describe('goals store', () => {
  it('setActiveGoal then getActiveGoal round-trips title + body', () => {
    reset()
    const row = setActiveGoal({ ...T, title: 'ship v1.3.0', body: '* CHANGELOG\n* release notes' })
    if (!hasSqliteRow(row)) return
    expect(row.title).toBe('ship v1.3.0')
    expect(row.status).toBe('active')
    expect(row.version).toBe(1)
    expect(row.mutationEpoch).toBe(0)
    expect(row.evidenceRequired).toBe(true)
    expect(row.body).toContain('CHANGELOG')
    const active = getActiveGoal(T.platform, T.channelId, T.threadId)
    expect(active?.id).toBe(row.id)
  })

  it('setting a new active goal auto-pauses the previous one', () => {
    reset()
    const a = setActiveGoal({ ...T, title: 'first' })
    if (!hasSqliteRow(a)) return
    const b = setActiveGoal({ ...T, title: 'second' })
    expect(b).not.toBeNull()
    const after = getActiveGoal(T.platform, T.channelId, T.threadId)
    expect(after?.id).toBe(b?.id)
    const old = getGoalById(a.id)
    expect(old?.status).toBe('paused')
  })

  it('appendProgress accumulates notes (most recent last)', () => {
    reset()
    const g = setActiveGoal({ ...T, title: 'gather notes' })
    if (!hasSqliteRow(g)) return
    expect(appendProgress(g.id, 'user', 'note 1')).toBe(true)
    expect(appendProgress(g.id, 'agent', 'note 2')).toBe(true)
    const after = getGoalById(g.id)
    expect(after?.progressLog.length).toBe(2)
    expect(after?.progressLog[0].text).toBe('note 1')
    expect(after?.progressLog[1].text).toBe('note 2')
    expect(after?.progressLog[1].by).toBe('agent')
    expect(after?.version).toBe(g.version + 2)
  })

  it('updateStatus to completed sets closedAt and stops injection', () => {
    reset()
    const g = setActiveGoal({ ...T, title: 'finish me' })
    if (!hasSqliteRow(g)) return
    updateStatus(g.id, 'completed')
    const after = getGoalById(g.id)
    expect(after?.status).toBe('completed')
    expect(after?.closedAt).not.toBeNull()
    expect(getActiveGoal(T.platform, T.channelId, T.threadId)).toBeNull()
  })

  it('resumeGoal makes a paused row active and pauses the predecessor', () => {
    reset()
    const a = setActiveGoal({ ...T, title: 'a' })
    if (!hasSqliteRow(a)) return
    const b = setActiveGoal({ ...T, title: 'b' })
    if (!hasSqliteRow(b)) return
    expect(getActiveGoal(T.platform, T.channelId, T.threadId)?.id).toBe(b.id)

    expect(resumeGoal(a.id)).toBe(true)
    expect(getActiveGoal(T.platform, T.channelId, T.threadId)?.id).toBe(a.id)
    expect(getActiveGoal(T.platform, T.channelId, T.threadId)?.version).toBeGreaterThan(a.version)
    const bAfter = getGoalById(b.id)
    expect(bAfter?.status).toBe('paused')
  })

  it('resumeGoal refuses to resume completed / cancelled rows', () => {
    reset()
    const g = setActiveGoal({ ...T, title: 'closed' })
    if (!hasSqliteRow(g)) return
    updateStatus(g.id, 'completed')
    expect(resumeGoal(g.id)).toBe(false)
  })

  it('listGoalsForThread returns rows from this thread only', () => {
    reset()
    const a = setActiveGoal({ ...T, title: 'thread1' })
    const b = setActiveGoal({ ...T2, title: 'thread2' })
    if (!hasSqliteRow(a) || !hasSqliteRow(b)) return
    const list = listGoalsForThread(T.platform, T.channelId, T.threadId)
    expect(list.find((r) => r.id === a.id)).toBeDefined()
    expect(list.find((r) => r.id === b.id)).toBeUndefined()
  })

  it('listAllActiveGoals returns active rows across threads', () => {
    reset()
    const a = setActiveGoal({ ...T, title: 't1' })
    const b = setActiveGoal({ ...T2, title: 't2' })
    if (!hasSqliteRow(a) || !hasSqliteRow(b)) return
    const list = listAllActiveGoals()
    expect(list.length).toBe(2)
    expect(list.every((r) => r.status === 'active')).toBe(true)
  })

  it('title length is clamped at MAX_TITLE_CHARS', () => {
    reset()
    const long = 'x'.repeat(MAX_TITLE_CHARS + 50)
    const row = setActiveGoal({ ...T, title: long })
    if (!hasSqliteRow(row)) return
    expect(row.title.length).toBe(MAX_TITLE_CHARS)
  })

  it('body length is clamped at MAX_BODY_CHARS', () => {
    reset()
    const long = 'y'.repeat(MAX_BODY_CHARS + 200)
    const row = setActiveGoal({ ...T, title: 't', body: long })
    if (!hasSqliteRow(row)) return
    expect(row.body.length).toBe(MAX_BODY_CHARS)
  })

  it('empty title is rejected', () => {
    reset()
    const row = setActiveGoal({ ...T, title: '   ' })
    expect(row).toBeNull()
  })
})

describe('buildGoalSnippet', () => {
  it('returns empty string when no active goal', () => {
    reset()
    expect(buildGoalSnippet(T.platform, T.channelId, T.threadId)).toBe('')
  })

  it('includes title and body when active goal exists', () => {
    reset()
    const r = setActiveGoal({
      ...T, title: 'Ship v1.3.0', body: 'CHANGELOG + npm publish',
    })
    if (!hasSqliteRow(r)) return
    const snippet = buildGoalSnippet(T.platform, T.channelId, T.threadId)
    expect(snippet).toContain(`#${r.id}`)
    expect(snippet).toContain('Ship v1.3.0')
    expect(snippet).toContain('CHANGELOG')
    expect(snippet).toContain('agim context')
    expect(snippet).not.toContain('complete_goal')
  })

  it('only includes the most recent N progress notes (bounded)', () => {
    reset()
    const r = setActiveGoal({ ...T, title: 'many notes' })
    if (!hasSqliteRow(r)) return
    for (let i = 0; i < 12; i++) appendProgress(r.id, 'user', `note ${i}`)
    const snippet = buildGoalSnippet(T.platform, T.channelId, T.threadId)
    // Default MAX_PROGRESS_NOTES_INJECTED = 5; the snippet should
    // contain the LAST 5 (note 7 through note 11).
    expect(snippet).toContain('note 11')
    expect(snippet).toContain('note 7')
    expect(snippet).not.toContain('note 0')
    expect(snippet).not.toContain('note 5')
  })
})

describe('formatGoalShow', () => {
  it('renders status flag + body + recent progress', () => {
    reset()
    const r = setActiveGoal({ ...T, title: 'demo', body: 'one liner' })
    if (!hasSqliteRow(r)) return
    appendProgress(r.id, 'user', 'note A')
    const fresh = getGoalById(r.id)
    if (!hasSqliteRow(fresh)) return
    const out = formatGoalShow(fresh)
    expect(out).toContain('🎯')
    expect(out).toContain('active')
    expect(out).toContain('demo')
    expect(out).toContain('one liner')
    expect(out).toContain('note A')
  })
})
