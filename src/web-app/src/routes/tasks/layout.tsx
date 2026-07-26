/**
 * /tasks — grouped shell for task activity.
 *
 * The task area has a lot of power-user views. Keep the raw pages
 * available, but group them so the first scan answers "what do I need
 * to look at?" instead of showing a flat wall of nouns.
 */

import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { WorkbenchFrame } from '@/components/shell/workbench-frame'
import { cn } from '@/lib/utils'

interface SubTab {
  to: string
  i18nKey: string
  mounted: boolean
  end?: boolean
}

interface SubTabGroup {
  id: 'overview' | 'work' | 'automation' | 'review'
  i18nKey: string
  tabs: SubTab[]
}

const SUB_TAB_GROUPS: SubTabGroup[] = [
  {
    id: 'overview',
    i18nKey: 'navigation.groups.overview',
    tabs: [
      { to: '.', i18nKey: 'subnav.overview', mounted: true, end: true },
    ],
  },
  {
    id: 'work',
    i18nKey: 'navigation.groups.work',
    tabs: [
      { to: 'jobs',     i18nKey: 'subnav.jobs',     mounted: true },
      { to: 'subtasks', i18nKey: 'subnav.subtasks', mounted: true },
      { to: 'bgjobs',   i18nKey: 'subnav.bgjobs',   mounted: true },
      { to: 'outbox',   i18nKey: 'subnav.outbox',   mounted: true },
    ],
  },
  {
    id: 'automation',
    i18nKey: 'navigation.groups.automation',
    tabs: [
      { to: 'schedules', i18nKey: 'subnav.schedules', mounted: true },
      // P1 follow-up — per-thread background primitives.
      { to: 'heartbeat', i18nKey: 'subnav.heartbeat', mounted: true },
      { to: 'asks',      i18nKey: 'subnav.asks',      mounted: true },
    ],
  },
  {
    id: 'review',
    i18nKey: 'navigation.groups.review',
    tabs: [
      { to: 'a2a',   i18nKey: 'subnav.a2a',   mounted: true },
      // v1.2.133 — native_exit_plan_mode audit log.
      { to: 'plans', i18nKey: 'subnav.plans', mounted: true },
    ],
  },
]

export default function TasksLayout(): JSX.Element {
  const { t } = useTranslation('tasks')
  return (
    <WorkbenchFrame contentClassName="space-y-4">
      <nav
        className={cn(
          'flex items-center gap-4 rounded-xl border border-border bg-surface px-3 py-2 shadow-sm',
          'overflow-x-auto',
        )}
        aria-label={t('pageTitle')}
      >
        {SUB_TAB_GROUPS.map((group) => (
          <section key={group.id} className="flex shrink-0 items-center gap-1">
            {group.tabs.filter((tab) => tab.mounted).map((tab) => (
              <NavLink
                key={`${group.id}:${tab.to}`}
                to={tab.to}
                end={tab.end}
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
          </section>
        ))}
      </nav>

      <section className="pb-safe">
        <Outlet />
      </section>
    </WorkbenchFrame>
  )
}
