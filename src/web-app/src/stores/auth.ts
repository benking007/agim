/**
 * stores/auth.ts — token + signed-in state.
 *
 * The token lives in localStorage (same key the agim backend already
 * uses, `agim_token`) and is mirrored into a zustand store so React
 * components can subscribe to "am I logged in" without polling
 * localStorage on every render.
 *
 * Why not roll this into prefs.ts:
 *   * Different lifecycle: prefs are operator-tunable UI state;
 *     auth is a single high-signal boolean ("can I make API calls")
 *     plus the token string itself.
 *   * Different security posture: token writes are expected to be
 *     rare (login, logout, 401 wipe); prefs writes happen every
 *     theme toggle.
 *   * Cleaner store shape — pages can `useAuth(s => s.signedIn)`
 *     without dragging theme/lang along.
 */

import { create } from 'zustand'

const TOKEN_KEY = 'agim_token'

interface AuthState {
  token: string | null
  signedIn: boolean
  setToken: (token: string | null) => void
  clear: () => void
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
    /* private mode — login won't persist but the in-memory state still works */
  }
}

const initialToken = readToken()

export const useAuth = create<AuthState>((set) => ({
  token: initialToken,
  signedIn: Boolean(initialToken),
  setToken: (token) => {
    writeToken(token)
    set({ token, signedIn: Boolean(token) })
  },
  clear: () => {
    writeToken(null)
    set({ token: null, signedIn: false })
  },
}))

/**
 * Subscribe the auth store to cross-tab localStorage changes — when
 * the user signs out in tab A, tab B's UI flips to signed-out within
 * one storage event. Called from providers.tsx on mount.
 */
export function bindAuthToStorage(): () => void {
  function onStorage(e: StorageEvent): void {
    if (e.key !== TOKEN_KEY) return
    const next = e.newValue
    useAuth.setState({ token: next, signedIn: Boolean(next) })
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
