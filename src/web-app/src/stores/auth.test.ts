/**
 * stores/auth.test.ts — token persistence + cross-tab sync via the
 * storage event handler.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAuth, bindAuthToStorage } from './auth'

afterEach(() => {
  useAuth.setState({ token: null, signedIn: false })
  localStorage.clear()
})

describe('useAuth', () => {
  beforeEach(() => {
    useAuth.setState({ token: null, signedIn: false })
    localStorage.clear()
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
})
