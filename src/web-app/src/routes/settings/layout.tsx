/**
 * /settings — grouped navigation shell.
 *
 * Settings has grown into the densest part of the console. Keep the
 * URLs stable, but group the entry points so new operators see the
 * core setup path before advanced capability and operations pages.
 */

import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Topbar } from '@/components/shell/topbar'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface SubTab {
  to: string
  i18nKey: string
  mounted: boolean
  recommended?: boolean
}

interface SubTabGroup {
  id: 'start' | 'core' | 'capabilities' | 'operations'
  i18nKey: string
  tabs: SubTab[]
}

const SUB_TAB_GROUPS: SubTabGroup[] = [
  {
    id: 'start',
    i18nKey: 'navigation.groups.start',
    tabs: [
      { to: 'start', i18nKey: 'tabs.start', mounted: true, recommended: true },
    ],
  },
  {
    id: 'core',
    i18nKey: 'navigation.groups.core',
    tabs: [
      { to: 'messengers', i18nKey: 'tabs.messengers', mounted: true },
      { to: 'agents',     i18nKey: 'tabs.agents',     mounted: true },
      // Stage 6 — Agim Agent stack (model APIs + runtime knobs).
      { to: 'llm',        i18nKey: 'tabs.llm',        mounted: true },
      // v1.2.129 — mobile QR generator (open /m/chat from a phone).
      { to: 'mobile',     i18nKey: 'tabs.mobile',     mounted: true },
    ],
  },
  {
    id: 'capabilities',
    i18nKey: 'navigation.groups.capabilities',
    tabs: [
      // P1 follow-up — agim SKILL.md editor.
      { to: 'agim-skills', i18nKey: 'tabs.agimSkills', mounted: true },
      // v1.2.126 — web_search provider chain + per-provider keys.
      { to: 'search',      i18nKey: 'tabs.search',     mounted: true },
      { to: 'mcp',         i18nKey: 'tabs.mcp',        mounted: true },
      { to: 'email',       i18nKey: 'tabs.email',      mounted: true },
      { to: 'viewer',      i18nKey: 'tabs.viewer',     mounted: true },
    ],
  },
  {
    id: 'operations',
    i18nKey: 'navigation.groups.operations',
    tabs: [
      { to: 'policy',     i18nKey: 'tabs.policy',     mounted: true },
      { to: 'security',   i18nKey: 'tabs.security',   mounted: true },
      { to: 'workspaces', i18nKey: 'tabs.workspaces', mounted: true },
      { to: 'admins',     i18nKey: 'tabs.admins',     mounted: true },
      // R13 follow-up — /settings/env catch-all editor removed; raw
      // env-var editing belongs in `~/.agim/env` on the host.
      { to: 'service',    i18nKey: 'tabs.service',    mounted: true },
    ],
  },
]

export default function SettingsLayout(): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />

      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="border-b border-border bg-surface md:w-64 md:shrink-0 md:border-b-0 md:border-r">
          <nav
            className={cn(
              'flex gap-4 overflow-x-auto px-3 py-3',
              'md:sticky md:top-0 md:flex-col md:gap-3 md:overflow-visible md:px-4',
            )}
            aria-label={t('pageTitle')}
          >
            {SUB_TAB_GROUPS.map((group) => (
              <section key={group.id} className="min-w-max md:min-w-0">
                <h2 className="px-2 text-[11px] font-semibold uppercase leading-5 text-text-muted">
                  {t(group.i18nKey)}
                </h2>
                <div className="mt-1 flex gap-1 md:flex-col">
                  {group.tabs.filter((tab) => tab.mounted).map((tab) => (
                    <SettingsNavLink key={tab.to} tab={tab} />
                  ))}
                </div>
              </section>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 px-3 py-4 pb-safe sm:px-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function SettingsNavLink({ tab }: { tab: SubTab }): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <NavLink
      to={tab.to}
      className={({ isActive }) =>
        cn(
          'flex min-h-9 items-center gap-2 rounded-md px-3 py-1.5 text-sm no-underline',
          'transition-colors tap-target',
          'md:w-full md:justify-between',
          isActive
            ? 'bg-accent-bg text-accent font-medium'
            : 'text-text-dim hover:bg-surface-hover hover:text-text',
        )
      }
    >
      <span className="min-w-0 truncate">{t(tab.i18nKey)}</span>
      {tab.recommended && (
        <Badge variant="accent" className="hidden md:inline-flex">
          {t('navigation.recommended')}
        </Badge>
      )}
    </NavLink>
  )
}
