/**
 * Signed-in username in the admin topbar. Identification first;
 * compact logout so operators do not have to open Account.
 */

import { useTranslation } from 'react-i18next'
import { LogOut } from 'lucide-react'

import { signedInName, signOut } from '@/lib/sign-out'
import { useAuth } from '@/stores/auth'

export function SignedInUser(): JSX.Element | null {
  const { t } = useTranslation()
  const user = useAuth((s) => s.user)
  const name = signedInName(user)
  if (!name) return null

  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid="signed-in-user">
      <span
        className="max-w-[8rem] truncate text-sm font-medium text-text sm:max-w-[12rem]"
        title={name}
      >
        {name}
      </span>
      <button
        type="button"
        onClick={() => { void signOut() }}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-text-dim hover:bg-surface-hover hover:text-text"
        aria-label={t('chat.logout')}
        title={t('chat.logout')}
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">{t('chat.logout')}</span>
      </button>
    </div>
  )
}
