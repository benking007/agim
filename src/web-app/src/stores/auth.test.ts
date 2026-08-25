/**
 * stores/auth.test.ts — token persistence + cross-tab sync via the
 * storage event handler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth, bindAuthToStorage } from './auth'

function jsonOk(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

afterEach(() => {
  useAuth.setState({
    token: null,
    user: null,
    role: null,
    signedIn: false,
    ready: false,
    hasUsers: null,
  })
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('useAuth', () => {
  beforeEach(() => {
    useAuth.setState({
      token: null,
      user: null,
      role: null,
      signedIn: false,
      ready: false,
      hasUsers: null,
    })
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('bootstrap-state')) return jsonOk({ hasUsers: true })
      if (url.includes('/api/auth/me')) return jsonOk({ user: null })
      return { ok: false, json: async () => ({}) } as Response
    }))
  })

  it('setToken persists to agim_token + flips signedIn', () => {
    useAuth.getState().setToken('agim_abc')
    expect(useAuth.getState().token).toBe('agim_abc')
    expect(useAuth.getState().signedIn).toBe(true)
    expect(localStorage.getItem('agim_token')).toBe('agim_abc')
  })

  it('clear() removes the token + flips signedIn off', () => {
    useAuth.getState().setToken('xyz')
    useAuth.getState().clear()
    expect(useAuth.getState().token).toBeNull()
    expect(useAuth.getState().signedIn).toBe(false)
    expect(localStorage.getItem('agim_token')).toBeNull()
  })

  it('bindAuthToStorage syncs state when another tab updates the key', () => {
    const off = bindAuthToStorage()
    try {
      // Simulate another tab writing agim_token.
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'agim_token',
          newValue: 'fresh_token',
        }),
      )
      expect(useAuth.getState().token).toBe('fresh_token')
      expect(useAuth.getState().signedIn).toBe(true)

      // Another tab signs out.
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'agim_token',
          newValue: null,
        }),
      )
      expect(useAuth.getState().token).toBeNull()
      expect(useAuth.getState().signedIn).toBe(false)
    } finally {
      off()
    }
  })

  it('bindAuthToStorage ignores unrelated keys', () => {
    useAuth.getState().setToken('keep_me')
    const off = bindAuthToStorage()
    try {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'random_key', newValue: 'x' }),
      )
      expect(useAuth.getState().token).toBe('keep_me')
    } finally {
      off()
    }
  })

  it('hydrate signs in auth-off even when no users exist yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('bootstrap-state')) return jsonOk({ hasUsers: false })
      if (url.includes('/api/auth/me')) {
        return jsonOk({
          user: { id: 'auth-off', username: 'auth-off', role: 'admin', displayName: 'auth-off' },
          role: 'admin',
          kind: 'auth-off',
        })
      }
      return { ok: false, json: async () => ({}) } as Response
    }))
    await useAuth.getState().hydrate()
    const state = useAuth.getState()
    expect(state.hasUsers).toBe(false)
    expect(state.signedIn).toBe(true)
    expect(state.ready).toBe(true)
    expect(state.role).toBe('admin')
    expect(state.user?.id).toBe('auth-off')
  })
})
