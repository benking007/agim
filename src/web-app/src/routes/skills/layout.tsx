/**
 * /skills — top-level skills tab.
 *
 * Promoted out of /memory in 2026-05: skills aren't memory facts and
 * the "memory" tab was getting crowded. Two sub-tabs:
 *
 *   installed — local SKILL.md inventory the agents pick up
 *               (moved verbatim from /memory/skills)
 *   hot       — read-only browse of the skillhub.cn hot list
 *               (restored from v1; backend already had the proxy)
 */

import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Topbar } from '@/components/shell/topbar'
import { cn } from '@/lib/utils'

interface SubTab {
  to: string
  i18nKey: string
}

const SUB_TABS: SubTab[] = [
  { to: 'installed', i18nKey: 'subnav.installed' },
  { to: 'hot',       i18nKey: 'subnav.hot' },
]

export default function SkillsLayout(): JSX.Element {
  const { t } = useTranslation('skills')
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
