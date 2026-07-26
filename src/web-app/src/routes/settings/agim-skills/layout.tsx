/**
 * /settings/agim-skills — combined skill management.
 *
 * 2026-05 consolidation: the v2 SPA briefly had two skill entry points
 * (top-level /skills + this settings route) which duplicated 95% of
 * the data after multi-root scanning landed. We merged both flows here:
 *
 *   installed — agim's own loader view; CRUD against the writable
 *               workspace dir, read-only for builtins and skills
 *               inherited from ~/.claude/skills + opencode + codex.
 *
 * Old URLs under /skills still resolve via redirects in router.tsx
 * so bookmarks keep working.
 */

import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface SubTab {
  to: string
  i18nKey: string
  end?: boolean
}

const SUB_TABS: SubTab[] = [
  { to: '.', i18nKey: 'agimSkills.tab.overview', end: true },
  { to: 'installed', i18nKey: 'agimSkills.tab.installed' },
  // v1.2.151 — system-prompt skill block editor (operator override).
  { to: 'injection', i18nKey: 'agimSkills.tab.injection' },
]

export default function SettingsAgimSkillsLayout(): JSX.Element {
  const { t } = useTranslation(['settings'])
  return (
    <div className="flex flex-col gap-4">
      <nav
        className={cn(
          'flex items-center gap-1',
          'border-b border-border',
          '-mx-3 sm:-mx-4 px-3 sm:px-4 pb-2',
          'overflow-x-auto',
        )}
        aria-label={t('agimSkills.title')}
      >
        {SUB_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
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
      </nav>
      <Outlet />
    </div>
  )
}
