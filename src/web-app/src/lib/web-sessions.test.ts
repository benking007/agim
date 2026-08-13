/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SESSIONS_KEY,
  THREAD_ID_KEY,
  MAX_SESSIONS,
  adoptThreadId,
  findSession,
  isWebThreadId,
  listSessions,
  loadIndex,
  mintThreadId,
  sessionTitleFromText,
  setActiveId,
  upsertSession,
} from './web-sessions'

describe('web-sessions', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('mints web-* ids', () => {
    const id = mintThreadId()
    expect(isWebThreadId(id)).toBe(true)
  })

  it('migrates a legacy agim-web-thread-id into the index', () => {
    localStorage.setItem(THREAD_ID_KEY, 'web-legacythread1')
    const index = loadIndex()
    expect(index.activeId).toBe('web-legacythread1')
    expect(index.sessions.map((s) => s.id)).toEqual(['web-legacythread1'])
    expect(JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? '{}').activeId).toBe('web-legacythread1')
  })

  it('creates a fresh index when storage is empty', () => {
    const index = loadIndex()
    expect(isWebThreadId(index.activeId)).toBe(true)
    expect(index.sessions).toHaveLength(1)
    expect(localStorage.getItem(THREAD_ID_KEY)).toBe(index.activeId)
  })

  it('upserts titles without wiping an existing title with empty patch', () => {
    const { activeId } = loadIndex()
    upsertSession({ id: activeId, title: 'Hello world', agent: 'agim' })
    upsertSession({ id: activeId, updatedAt: 99 })
    const entry = findSession(activeId)
    expect(entry?.title).toBe('Hello world')
    expect(entry?.agent).toBe('agim')
    expect(entry?.updatedAt).toBe(99)
  })

  it('lists newest first and keeps previous ids when minting another', () => {
    const first = loadIndex().activeId
    upsertSession({ id: first, title: 'one', updatedAt: 1 })
    const second = mintThreadId()
    upsertSession({ id: second, title: 'two', updatedAt: 2 })
    setActiveId(second)
    const listed = listSessions()
    expect(listed.map((s) => s.id)).toEqual([second, first])
    expect(loadIndex().activeId).toBe(second)
    expect(localStorage.getItem(THREAD_ID_KEY)).toBe(second)
  })

  it('adoptThreadId replaces the foreign previous id', () => {
    const oldId = 'web-oldthreadxxxx'
    localStorage.setItem(THREAD_ID_KEY, oldId)
    loadIndex()
    const next = 'web-newthreadxxxx'
    adoptThreadId(next, oldId)
    const listed = listSessions()
    expect(listed.map((s) => s.id)).toEqual([next])
    expect(loadIndex().activeId).toBe(next)
    expect(localStorage.getItem(THREAD_ID_KEY)).toBe(next)
  })

  it('caps the index at MAX_SESSIONS while keeping the active id', () => {
    const first = loadIndex().activeId
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      upsertSession({ id: `web-cap${String(i).padStart(8, '0')}`, updatedAt: i + 10 })
    }
    const listed = listSessions()
    expect(listed.length).toBeLessThanOrEqual(MAX_SESSIONS)
    expect(listed.some((s) => s.id === first) || loadIndex().activeId !== first).toBe(true)
    // active is still valid
    expect(listed.some((s) => s.id === loadIndex().activeId)).toBe(true)
  })

  it('sessionTitleFromText collapses whitespace and truncates', () => {
    expect(sessionTitleFromText('  hello\nworld  ')).toBe('hello world')
    expect(sessionTitleFromText('a'.repeat(50)).endsWith('…')).toBe(true)
    expect(sessionTitleFromText('   ')).toBe('')
  })
})
