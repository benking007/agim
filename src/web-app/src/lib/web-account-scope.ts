/**
 * Scope Portal localStorage to the signed-in account.
 *
 * Session rails, transcript snapshots, and workspace folders were stored
 * per origin. Signing out (or registering / logging into another user)
 * left the previous account's bubbles on screen until a hard reload
 * missed the cache. Wipe those keys whenever `usr_*` changes.
 */

import { clearAllCachedHistory } from '@/lib/web-history-cache'
import { resetSessionIndex } from '@/lib/web-sessions'
import { resetWorkspaces } from '@/lib/web-workspaces'

export const ACCOUNT_ID_KEY = 'agim-web-account-id'

export function persistedAccountId(): string | null {
  try {
    const value = localStorage.getItem(ACCOUNT_ID_KEY)?.trim()
    return value ? value : null
  } catch {
    return null
  }
}

export function rememberAccountId(userId: string | null): void {
  try {
    if (userId?.trim()) localStorage.setItem(ACCOUNT_ID_KEY, userId.trim())
    else localStorage.removeItem(ACCOUNT_ID_KEY)
  } catch { /* private mode */ }
}

/** Drop session / history / workspace caches and mint a blank tab. */
export function wipeWebAccountCaches(): void {
  clearAllCachedHistory()
  resetWorkspaces()
  resetSessionIndex()
}

/**
 * Remember `userId` (or clear it on sign-out). Returns true when the
 * account changed and caches were wiped.
 */
export function syncWebAccountScope(userId: string | null | undefined): boolean {
  const next = typeof userId === 'string' && userId.trim() ? userId.trim() : null
  const prev = persistedAccountId()
  if (prev === next) return false
  wipeWebAccountCaches()
  rememberAccountId(next)
  return true
}
