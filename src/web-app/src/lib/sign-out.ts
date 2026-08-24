import { useAuth, type AuthUser } from '@/stores/auth'

export function signedInName(user: AuthUser | null | undefined): string {
  if (!user) return ''
  return (user.displayName || user.username || '').trim()
}

export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
  } catch { /* still drop the local session */ }
  useAuth.getState().clear()
  window.location.href = '/login'
}
