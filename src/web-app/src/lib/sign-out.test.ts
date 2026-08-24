import { afterEach, describe, expect, it, vi } from 'vitest'

import { signedInName, signOut } from './sign-out'
import { useAuth } from '@/stores/auth'

afterEach(() => {
  useAuth.getState().clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('signedInName', () => {
  it('prefers displayName then username', () => {
    expect(signedInName(null)).toBe('')
    expect(signedInName({
      id: 'usr_1', username: 'alice', displayName: 'Alice', role: 'user',
    })).toBe('Alice')
    expect(signedInName({
      id: 'usr_1', username: 'alice', displayName: '', role: 'user',
    })).toBe('alice')
  })
})

describe('signOut', () => {
  it('clears the session and sends the browser to /login', async () => {
    useAuth.getState().setUser({
      id: 'usr_1', username: 'tester', displayName: 'tester', role: 'admin',
    })
    const setHref = vi.fn()
    vi.stubGlobal('location', {
      get href() { return 'http://localhost/settings' },
      set href(v: string) { setHref(v) },
    } as unknown as Location)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}')))

    await signOut()

    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
    expect(useAuth.getState().user).toBeNull()
    expect(setHref).toHaveBeenCalledWith('/login')
  })
})
