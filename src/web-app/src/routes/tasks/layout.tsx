/**
 * /tasks — layout shell shared by every sub-tab.
 *
 * Renders the application Topbar plus a sub-tab strip below it. The
 * actual sub-tab body comes from <Outlet /> — one file per tab under
 * routes/tasks/.
 *
 * Sub-tab order matches plan: jobs / subtasks / bgjobs / schedules /
 * outbox / a2a. Each sub-tab is gated on its route being mounted; in
 * PR-10a only `/tasks/jobs` is wired up so the others stay out of the
 * nav until their PRs land.
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
  { to: 'jobs',      i18nKey: 'subnav.jobs',      mounted: true },
  { to: 'subtasks',  i18nKey: 'subnav.subtasks',  mounted: true },
  { to: 'bgjobs',    i18nKey: 'subnav.bgjobs',    mounted: true },
  { to: 'schedules', i18nKey: 'subnav.schedules', mounted: true },
  { to: 'outbox',    i18nKey: 'subnav.outbox',    mounted: true },
  { to: 'a2a',       i18nKey: 'subnav.a2a',       mounted: true },
  // P1 follow-up — per-thread background primitives.
  { to: 'heartbeat', i18nKey: 'subnav.heartbeat', mounted: true },
  { to: 'goals',     i18nKey: 'subnav.goals',     mounted: true },
  { to: 'asks',      i18nKey: 'subnav.asks',      mounted: true },
]

export default function TasksLayout(): JSX.Element {
  const { t } = useTranslation('tasks')
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />

      <nav
        className={cn(
          'sticky top-[var(--topbar-h,0)] z-10',
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
