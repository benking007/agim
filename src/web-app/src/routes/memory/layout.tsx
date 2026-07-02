/**
 * /memory — grouped shell for long-term memory.
 *
 * Memory is partitioned per user_key. The picker lives in the layout
 * so it stays put across overview and detail tabs. The chosen user is
 * held in URL state (?user=) so sub-tabs read it via useSearchParams.
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
  end?: boolean
}

interface SubTabGroup {
  id: 'overview' | 'user' | 'processing' | 'recall'
  i18nKey: string
  tabs: SubTab[]
}

const SUB_TAB_GROUPS: SubTabGroup[] = [
  {
    id: 'overview',
    i18nKey: 'navigation.groups.overview',
    tabs: [
      { to: '.', i18nKey: 'tabs.overview', mounted: true, end: true },
    ],
  },
  {
    id: 'user',
    i18nKey: 'navigation.groups.user',
    tabs: [
      { to: 'facts',   i18nKey: 'tabs.facts',   mounted: true },
      { to: 'persona', i18nKey: 'tabs.persona', mounted: true },
    ],
  },
  {
    id: 'processing',
    i18nKey: 'navigation.groups.processing',
    tabs: [
      { to: 'distill', i18nKey: 'tabs.distill', mounted: true },
    ],
  },
  {
    id: 'recall',
    i18nKey: 'navigation.groups.recall',
    tabs: [
      { to: 'vector', i18nKey: 'tabs.vector', mounted: true },
      // 'skills' was here; promoted to Settings → agim Skills in 2026-05.
    ],
  },
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
          'flex items-center gap-4',
          'border-b border-border bg-surface',
          'px-3 sm:px-4 py-2',
          'overflow-x-auto',
        )}
        aria-label={t('pageTitle')}
      >
        {SUB_TAB_GROUPS.map((group) => (
          <section key={group.id} className="flex shrink-0 items-center gap-1">
            {group.tabs.filter((tab) => tab.mounted).map((tab) => (
              <NavLink
                key={`${group.id}:${tab.to}`}
                to={{
                  pathname: tab.to,
                  search: params.toString() ? `?${params.toString()}` : '',
                }}
                end={tab.end}
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
          </section>
        ))}
      </nav>

      <main className="flex-1 px-3 sm:px-4 py-4 pb-safe">
        <Outlet />
      </main>
    </div>
  )
}
