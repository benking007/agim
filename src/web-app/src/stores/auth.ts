/**
 * stores/auth.ts — login session + optional API token.
 *
 * Password login uses an HttpOnly `agim_session` cookie. The SPA only
 * stores the public user profile. Legacy `agim_token` (API token paste)
 * still counts as signed-in for existing tests and scripts.
 */

import { create } from 'zustand'

const TOKEN_KEY = 'agim_token'

export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'user'
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  role: 'admin' | 'user' | null
  signedIn: boolean
  ready: boolean
  hasUsers: boolean | null
  setToken: (token: string | null) => void
  setUser: (user: AuthUser | null) => void
  clear: () => void
  hydrate: () => Promise<void>
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* private mode */
  }
}

const initialToken = readToken()

export const useAuth = create<AuthState>((set, get) => ({
  token: initialToken,
  user: null,
  role: null,
  signedIn: Boolean(initialToken),
  ready: Boolean(initialToken),
  hasUsers: null,
  setToken: (token) => {
    writeToken(token)
    set({ token, signedIn: Boolean(token) || Boolean(get().user) })
  },
  setUser: (user) => {
    set({
      user,
      role: user?.role ?? null,
      signedIn: Boolean(user) || Boolean(get().token),
      ready: true,
    })
  },
  clear: () => {
    writeToken(null)
    set({ token: null, user: null, role: null, signedIn: false, ready: true })
  },
  hydrate: async () => {
    try {
      const boot = await fetch('/api/auth/bootstrap-state', { credentials: 'same-origin' })
      if (boot.ok) {
        const body = await boot.json() as { hasUsers?: boolean }
        set({ hasUsers: Boolean(body.hasUsers) })
      }
    } catch { /* offline */ }
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
      if (res.ok) {
        const body = await res.json() as { user?: AuthUser | null; role?: 'admin' | 'user' }
        if (body.user && body.user.id && !body.user.id.startsWith('loopback') && body.user.id !== 'auth-off') {
          set({
            user: body.user,
            role: body.user.role,
            signedIn: true,
            ready: true,
          })
          return
        }
        if (body.role === 'admin' && (body.user?.id === 'loopback' || body.user?.id === 'auth-off')) {
          set({ role: 'admin', signedIn: true, ready: true })
          return
        }
      }
    } catch { /* ignore */ }
    set({
      signedIn: Boolean(get().token),
      ready: true,
    })
  },
}))

export function bindAuthToStorage(): () => void {
  function onStorage(e: StorageEvent): void {
    if (e.key !== TOKEN_KEY) return
    const next = e.newValue
    useAuth.setState({ token: next, signedIn: Boolean(next) || Boolean(useAuth.getState().user) })
  }
  window.addEventListener('storage', onStorage)
  void useAuth.getState().hydrate()
  return () => window.removeEventListener('storage', onStorage)
}

/** True only when the hydrated session is role=admin. Null/user/loopback-pending stay false. */
export function useIsAdmin(): boolean {
  return useAuth((s) => s.role === 'admin')
}
