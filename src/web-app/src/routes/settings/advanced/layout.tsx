/**
 * /settings/advanced — Search / STT / Email / Viewer.
 *
 * These stay as real pages (and old /settings/{search,stt,email,viewer}
 * URLs redirect here) so IM error copy that points at /settings/stt
 * still works. The main Settings rail only shows one "Advanced" entry.
 */

import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

const TABS = [
  { to: 'search', i18nKey: 'tabs.search' },
  { to: 'stt',    i18nKey: 'tabs.stt' },
  { to: 'email',  i18nKey: 'tabs.email' },
  { to: 'viewer', i18nKey: 'tabs.viewer' },
] as const

export default function SettingsAdvancedLayout(): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t('advanced.title')}</h1>
        <p className="text-sm text-text-dim">{t('advanced.subtitle')}</p>
      </header>
      <nav
        className={cn(
          'flex items-center gap-1 overflow-x-auto',
          'rounded-xl border border-border bg-surface px-3 py-2 shadow-sm',
        )}
        aria-label={t('tabs.advanced')}
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                'shrink-0 rounded-md px-3 py-1.5 text-sm no-underline',
                'transition-colors tap-target',
                isActive
                  ? 'bg-brand-50 text-brand-600 font-medium shadow-sm dark:bg-accent-bg dark:text-accent'
                  : 'text-text-dim hover:bg-surface-hover hover:text-text',
              )
            }
          >
            {t(tab.i18nKey)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
