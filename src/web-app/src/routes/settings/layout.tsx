/**
 * /settings — layout shell with sub-tab nav (environment / service).
 *
 * Workspaces / WeChat QR / Admin allowlist will land as additional
 * sub-tabs in PR-19b/c. The `mounted` flag gates their nav links.
 */

import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Topbar } from '@/components/shell/topbar'
import { cn } from '@/lib/utils'

interface SubTab {
  to: string
  i18nKey: string
  mounted: boolean
}

const SUB_TABS: SubTab[] = [
  { to: 'env',        i18nKey: 'tabs.env',        mounted: true },
  { to: 'service',    i18nKey: 'tabs.service',    mounted: true },
  { to: 'admins',     i18nKey: 'tabs.admins',     mounted: true },
  { to: 'workspaces', i18nKey: 'tabs.workspaces', mounted: true },
]

export default function SettingsLayout(): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />

      <nav
        className={cn(
          'sticky top-0 z-10',
          'flex items-center gap-1',
          'border-b border-border bg-surface',
          'px-3 sm:px-4 py-1',
          'overflow-x-auto',
        )}
        aria-label={t('pageTitle')}
      >
        {SUB_TABS.filter((tab) => tab.mounted).map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                'shrink-0 rounded-md px-3 py-1.5 text-sm no-underline',
                'transition-colors tap-target',
                isActive
                  ? 'bg-accent-bg text-accent font-medium'
                  : 'text-text-dim hover:bg-surface-hover hover:text-text',
              )
            }
          >
            {t(tab.i18nKey)}
          </NavLink>
        ))}
      </nav>

      <main className="flex-1 px-3 sm:px-4 py-4 pb-safe">
        <Outlet />
      </main>
    </div>
  )
}
