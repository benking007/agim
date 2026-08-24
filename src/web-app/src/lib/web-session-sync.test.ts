/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock('@/lib/api/client', () => ({
  client: {
    get: (...args: unknown[]) => mocks.get(...args),
    post: (...args: unknown[]) => mocks.post(...args),
  },
}))

import { pullAccountSessions, pushAccountSession } from './web-session-sync'
import { listSessions, loadIndex, SESSIONS_KEY, THREAD_ID_KEY } from './web-sessions'

describe('web-session-sync', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mocks.get.mockReset()
    mocks.post.mockReset()
  })

  it('pullAccountSessions writes the server list through the authenticated client', async () => {
    const localId = loadIndex().activeId
    mocks.get.mockResolvedValue({
      sessions: [
        { id: 'web-frommacxxxxxx', title: 'Mac chat', updatedAt: 1_700_000_000_000, agent: 'agim' },
      ],
    })
    await pullAccountSessions(localId)
    expect(mocks.get).toHaveBeenCalledWith('/api/me/sessions')
    const listed = listSessions()
    expect(listed.some((s) => s.id === 'web-frommacxxxxxx' && s.title === 'Mac chat')).toBe(true)
    expect(listed.some((s) => s.id === localId)).toBe(true)
    expect(localStorage.getItem(THREAD_ID_KEY)).toBe(localId)
    expect(JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? '{}').sessions.length).toBeGreaterThan(0)
  })

  it('pushAccountSession posts title + archive to /api/me/sessions', async () => {
    mocks.post.mockResolvedValue({ ok: true })
    const ok = await pushAccountSession({
      threadId: 'web-pushthreadxxx',
      title: 'Hello',
      archivedAt: 99,
      agent: 'agim',
    })
    expect(ok).toBe(true)
    expect(mocks.post).toHaveBeenCalledWith('/api/me/sessions', {
      body: {
        threadId: 'web-pushthreadxxx',
        title: 'Hello',
        archivedAt: 99,
        agent: 'agim',
      },
    })
  })

  it('pullAccountSessions stays silent when the request fails', async () => {
    const before = loadIndex().activeId
    mocks.get.mockRejectedValue(new Error('offline'))
    const ok = await pullAccountSessions(before)
    expect(ok).toBe(false)
    expect(loadIndex().activeId).toBe(before)
  })
})
