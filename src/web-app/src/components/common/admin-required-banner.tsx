/**
 * Shown when a settings page needs GET /api/config (admin) but the
 * current token is role=user (e.g. Mobile QR) or otherwise lacks admin.
 * Without this, messengers/agents look "empty" — checkboxes off, no IM cards.
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface AdminRequiredBannerProps {
  className?: string
  /** Path to return to after re-login (default: current location). */
  nextPath?: string
}

export function AdminRequiredBanner({
  className,
  nextPath,
}: AdminRequiredBannerProps): JSX.Element {
  const { t } = useTranslation(['common', 'settings'])
  const next = nextPath ?? `${location.pathname}${location.search}`
  const loginHref = `/login?reason=admin&next=${encodeURIComponent(next)}`

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-bg/40 px-4 py-3 sm:flex-row sm:items-center',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">
            {t('login.adminRequired', {
              ns: 'common',
              defaultValue: 'Current token has no admin permission. Please sign in with an admin token.',
            })}
          </p>
          <p className="mt-1 text-xs text-text-dim">
            {t('adminGate.hint', {
              ns: 'settings',
              defaultValue:
                'Mobile QR tokens are role=user and cannot load IM / Agents settings. Use `agim token bootstrap` or `agim token create` for an admin token.',
            })}
          </p>
        </div>
      </div>
      <Button asChild size="sm" variant="secondary" className="shrink-0">
        <Link to={loginHref}>{t('adminGate.relogin', { ns: 'settings', defaultValue: 'Sign in as admin' })}</Link>
      </Button>
    </div>
  )
}
