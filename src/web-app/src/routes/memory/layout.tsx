/**
 * /memory — layout shell shared by every sub-tab.
 *
 * Memory is partitioned per user_key. The picker lives in the
 * layout so it's the first thing the operator sees and stays put
 * across sub-tabs (facts / persona / vector / skills). The chosen
 * user is held in URL state (?user=) so sub-tabs read it via
 * useSearchParams.
 *
 * Sub-tabs in PR-16a: only Facts is wired. Persona / Vector /
 * Skills land in PR-16b/c (same `mounted` flag pattern as /tasks
 * used).
 */

import { NavLink, Outlet, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Topbar } from '@/components/shell/topbar'
import { MemoryUserPicker } from '@/components/memory/user-picker'
import { cn } from '@/lib/utils'

interface SubTab {
  to: string
  i18nKey: string
  mounted: boolean
}

const SUB_TABS: SubTab[] = [
  { to: 'facts',   i18nKey: 'tabs.facts',   mounted: true  },
  { to: 'persona', i18nKey: 'tabs.persona', mounted: true  },
  { to: 'vector',  i18nKey: 'tabs.vector',  mounted: false },
  { to: 'skills',  i18nKey: 'tabs.skills',  mounted: false },
]

export default function MemoryLayout(): JSX.Element {
  const { t } = useTranslation('memory')
  const [params, setParams] = useSearchParams()
  const userKey = params.get('user') ?? ''

  function setUserKey(next: string): void {
    const p = new URLSearchParams(params)
    if (!next) p.delete('user')
    else p.set('user', next)
    setParams(p, { replace: true })
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />

      {/* User picker — the primary navigation control for this page */}
      <div className="border-b border-border bg-surface px-3 sm:px-4 py-2">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <span className="text-sm text-text-dim shrink-0">{t('userPicker.label')}</span>
          <MemoryUserPicker value={userKey} onChange={setUserKey} />
        </div>
      </div>

      {/* Sub-tab nav */}
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
