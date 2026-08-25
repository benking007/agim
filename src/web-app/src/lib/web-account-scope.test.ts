/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_ID_KEY,
  persistedAccountId,
  syncWebAccountScope,
  wipeWebAccountCaches,
} from './web-account-scope'
import { HIST_INDEX_KEY, HIST_KEY_PREFIX, writeCachedHistory } from './web-history-cache'
import { THREAD_ID_KEY, TAB_THREAD_KEY, loadIndex, listSessions } from './web-sessions'
import { WORKSPACES_KEY, addLocalWorkspace, listWorkspaces, loadActiveWorkspaceId } from './web-workspaces'

describe('web-account-scope', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('stamps the first account without treating it as a switch on the next call', () => {
    expect(syncWebAccountScope('usr_aaaaaa')).toBe(true)
    expect(persistedAccountId()).toBe('usr_aaaaaa')
    expect(syncWebAccountScope('usr_aaaaaa')).toBe(false)
  })

  it('wipes sessions, history, workspaces, and the tab thread on account change', () => {
    const threadId = loadIndex().activeId
    writeCachedHistory(threadId, {
      messages: [{ id: 'u1', role: 'user', content: 'secret from A', timestamp: 1 }],
      agent: 'agim',
    })
    addLocalWorkspace({ name: 'old-proj', path: '/tmp/old-proj' })
    sessionStorage.setItem(TAB_THREAD_KEY, threadId)
    localStorage.setItem(ACCOUNT_ID_KEY, 'usr_aaaaaa')

    expect(syncWebAccountScope('usr_bbbbbb')).toBe(true)

    expect(persistedAccountId()).toBe('usr_bbbbbb')
    expect(localStorage.getItem(`${HIST_KEY_PREFIX}${threadId}`)).toBeNull()
    expect(localStorage.getItem(HIST_INDEX_KEY)).toBe('[]')
    expect(listSessions().some((s) => s.id === threadId)).toBe(false)
    expect(listSessions().some((s) => s.title)).toBe(false)
    expect(sessionStorage.getItem(TAB_THREAD_KEY)).not.toBe(threadId)
    expect(listWorkspaces()).toHaveLength(1)
    expect(loadActiveWorkspaceId()).toBe('cloud')
    expect(localStorage.getItem(WORKSPACES_KEY)).toContain('"cloud"')
  })

  it('sign-out (null) drops the previous account and mints a blank rail', () => {
    const threadId = loadIndex().activeId
    localStorage.setItem(ACCOUNT_ID_KEY, 'usr_aaaaaa')
    writeCachedHistory(threadId, {
      messages: [{ id: 'u1', role: 'user', content: 'stay with A', timestamp: 1 }],
    })
    expect(syncWebAccountScope(null)).toBe(true)
    expect(persistedAccountId()).toBeNull()
    expect(localStorage.getItem(`${HIST_KEY_PREFIX}${threadId}`)).toBeNull()
    expect(listSessions()).toHaveLength(1)
    expect(listSessions()[0]?.id).not.toBe(threadId)
  })

  it('wipeWebAccountCaches mints a fresh thread id', () => {
    const before = loadIndex().activeId
    wipeWebAccountCaches()
    expect(loadIndex().activeId).not.toBe(before)
    expect(localStorage.getItem(THREAD_ID_KEY)).toBe(loadIndex().activeId)
  })
})
