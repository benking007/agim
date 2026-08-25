/**
 * Shown when a signed-in member opens an admin-only URL.
 * Stays on the current path — does not clear the session or bounce to /login.
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { Topbar } from '@/components/shell/topbar'
import { Button } from '@/components/ui/button'

export function NoPermissionPanel(): JSX.Element {
  const { t } = useTranslation('common')
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-xl border border-border bg-surface px-5 py-6 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-text">
            {t('noPermission.title', { defaultValue: 'No permission' })}
          </h1>
          <p className="mt-1 text-sm text-text-dim">
            {t('noPermission.body', {
              defaultValue: 'This page is for administrators. Your account can still use Chat, Tasks, Agent Files, and Settings.',
            })}
          </p>
        </div>
      </div>
      <Button asChild size="sm">
        <Link to="/">{t('noPermission.backToChat', { defaultValue: 'Back to chat' })}</Link>
      </Button>
    </div>
  )
}

export function NoPermissionPage(): JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <Topbar />
      <main className="flex flex-1 items-start justify-center px-4 py-10">
        <NoPermissionPanel />
      </main>
    </div>
  )
}
