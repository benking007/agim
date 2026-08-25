/**
 * stores/auth.ts — login session + optional API token.
 *
 * Password login uses an HttpOnly `agim_session` cookie. The SPA only
 * stores the public user profile. Legacy `agim_token` (API token paste)
 * still counts as signed-in for existing tests and scripts.
 */

import { create } from 'zustand'
import { syncWebAccountScope } from '@/lib/web-account-scope'

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

let hydrateInFlight: Promise<void> | null = null

function asAuthUser(raw: AuthUser): AuthUser {
  return {
    id: raw.id,
    username: raw.username,
    displayName: raw.displayName || raw.username || raw.id,
    role: raw.role === 'user' ? 'user' : 'admin',
  }
}

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
    if (user?.id) syncWebAccountScope(user.id)
    set({
      user,
      role: user?.role ?? null,
      signedIn: Boolean(user) || Boolean(get().token),
      ready: true,
    })
  },
  clear: () => {
    writeToken(null)
    syncWebAccountScope(null)
    set({ token: null, user: null, role: null, signedIn: false, ready: true })
  },
  hydrate: async () => {
    if (hydrateInFlight) return hydrateInFlight
    hydrateInFlight = (async () => {
      let hasUsers = get().hasUsers
      try {
        const boot = await fetch('/api/auth/bootstrap-state', { credentials: 'same-origin' })
        if (boot.ok) {
          const body = await boot.json() as { hasUsers?: boolean }
          hasUsers = Boolean(body.hasUsers)
        }
      } catch { /* offline */ }

      let user = get().user
      let role = get().role
      let signedIn = Boolean(get().token) || Boolean(user)

      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
        if (res.ok) {
          const body = await res.json() as { user?: AuthUser | null; role?: 'admin' | 'user' }
          const id = body.user?.id
          if (id === 'loopback' || id === 'auth-off') {
            user = asAuthUser({
              id,
              username: body.user?.username || id,
              displayName: body.user?.displayName || id,
              role: body.user?.role || body.role || 'admin',
            })
            role = user.role
            signedIn = true
          } else if (body.user && id && !id.startsWith('loopback')) {
            user = asAuthUser(body.user)
            role = user.role
            signedIn = true
          } else if (body.role === 'admin') {
            role = 'admin'
            signedIn = true
          }
        }
      } catch { /* ignore */ }

      signedIn = signedIn || Boolean(get().token) || Boolean(get().user)
      user = user ?? get().user
      role = role ?? get().role
      if (user?.id) syncWebAccountScope(user.id)

      // One tick: never publish hasUsers=false while signedIn is still false
      // (that sent AGIM_WEB_AUTH=off visitors to /register before /api/auth/me).
      set({ hasUsers, user, role, signedIn, ready: true })
    })()
    try {
      await hydrateInFlight
    } finally {
      hydrateInFlight = null
    }
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
