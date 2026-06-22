import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  TUI_SESSIONS_DIR,
  generateSessionId,
  listSessions,
  loadSession,
  saveSession,
  type StoredSession,
} from '../../src/cli-ui/tui/sessions'

const createdIds = new Set<string>()

function makeId(): string {
  const id = `tui-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  createdIds.add(id)
  return id
}

function buildSession(id: string, updatedAt: string): StoredSession {
  return {
    id,
    agent: 'codex',
    agentSessions: { codex: 'thread-abc' },
    cwd: '/tmp',
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world', elapsedMs: 1200, agentName: 'codex' },
    ],
  }
}

afterEach(() => {
  for (const id of createdIds) {
    const file = join(TUI_SESSIONS_DIR, `${id}.json`)
    if (existsSync(file)) rmSync(file, { force: true })
  }
  createdIds.clear()
})

describe('tui sessions persistence', () => {
  it('round-trips agentSessions alongside messages', () => {
    const id = makeId()
    saveSession(buildSession(id, '2099-01-01T00:00:00.000Z'))

    const loaded = loadSession(id)
    expect(loaded).not.toBeNull()
    expect(loaded?.agent).toBe('codex')
    expect(loaded?.agentSessions?.codex).toBe('thread-abc')
    expect(loaded?.messages.length).toBe(2)
  })

  it('does not persist system-only sessions', () => {
    const id = makeId()
    saveSession({
      id,
      agent: 'codex',
      cwd: '/tmp',
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
      messages: [{ role: 'system', content: 'hello' }],
    })
    expect(loadSession(id)).toBeNull()
  })

  it('listSessions sorts latest first', () => {
    const older = makeId()
    const newer = makeId()
    saveSession(buildSession(older, '2098-01-01T00:00:00.000Z'))
    saveSession(buildSession(newer, '2099-01-01T00:00:00.000Z'))

    const listed = listSessions(50, true)
      .filter((s) => s.id === older || s.id === newer)
      .map((s) => s.id)

    expect(listed[0]).toBe(newer)
    expect(listed[1]).toBe(older)
  })
})

describe('generateSessionId', () => {
  it('returns prefixed ids with timestamp-ish body', () => {
    const id = generateSessionId()
    expect(id.startsWith('tui-')).toBe(true)
    expect(id.length).toBeGreaterThan('tui-20260101-000000-000000'.length - 1)
  })
})
