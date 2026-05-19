/**
 * /observability — layout shell with sub-tab nav (health / topn /
 * audit) + a global time-window selector that every sub-tab reads
 * via useSearchParams (?days=).
 */

import { NavLink, Outlet, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Topbar } from '@/components/shell/topbar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const SUB_TABS = [
  { to: 'health', i18nKey: 'tabs.health' },
  { to: 'topn',   i18nKey: 'tabs.topn'   },
  { to: 'audit',  i18nKey: 'tabs.audit'  },
]

const DAY_WINDOWS = [1, 7, 30, 90]

export default function ObservabilityLayout(): JSX.Element {
  const { t } = useTranslation('observability')
  const [params, setParams] = useSearchParams()
  const days = Math.max(1, Number(params.get('days')) || 7)

  function setDays(next: number): void {
    const p = new URLSearchParams(params)
    if (next === 7) p.delete('days')
    else p.set('days', String(next))
    setParams(p, { replace: true })
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />

      <div className="border-b border-border bg-surface px-3 sm:px-4 py-2">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <span className="text-sm text-text-dim shrink-0">{t('window.label')}</span>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAY_WINDOWS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t('window.days', { count: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

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
        {SUB_TABS.map((tab) => (
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
