/**
 * /settings — grouped navigation shell.
 *
 * Settings has grown into the densest part of the console. Keep the
 * URLs stable, but group the entry points so new operators see the
 * core setup path before advanced capability and operations pages.
 */

import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { WorkbenchFrame } from '@/components/shell/workbench-frame'
import { AdminRequiredBanner } from '@/components/common/admin-required-banner'
import { Badge } from '@/components/ui/badge'
import { useConfig } from '@/hooks/use-settings'
import { isAdminRequiredError } from '@/lib/api/errors'
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
      { to: 'tools',       i18nKey: 'tabs.tools',      mounted: true },
      { to: 'mcp',         i18nKey: 'tabs.mcp',        mounted: true },
      { to: 'advanced',    i18nKey: 'tabs.advanced',   mounted: true },
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
      { to: 'observability', i18nKey: 'tabs.observability', mounted: true },
      { to: 'service',    i18nKey: 'tabs.service',    mounted: true },
    ],
  },
]

export default function SettingsLayout(): JSX.Element {
  const { t } = useTranslation('settings')
  // Shared with child routes via react-query. When the session is a
  // Mobile QR / role=user token, GET /api/config returns 403 and IM /
  // Agents pages used to look blank — surface the gate once at the shell.
  const cfgQuery = useConfig()
  const needsAdmin = isAdminRequiredError(cfgQuery.error)

  return (
    <WorkbenchFrame contentClassName="space-y-4">
      <div className="grid items-start gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-border bg-surface shadow-sm xl:sticky xl:top-0 xl:max-h-[calc(100dvh_-_3rem)] xl:overflow-y-auto">
          <nav
            className={cn(
              'flex gap-4 overflow-x-auto px-3 py-3',
              'xl:flex-col xl:gap-3 xl:overflow-visible xl:px-4',
            )}
            aria-label={t('pageTitle')}
          >
            {SUB_TAB_GROUPS.map((group) => (
              <section key={group.id} className="min-w-max xl:min-w-0">
                <h2 className="px-2 text-[11px] font-semibold uppercase leading-5 text-text-muted">
                  {t(group.i18nKey)}
                </h2>
                <div className="mt-1 flex gap-1 xl:flex-col">
                  {group.tabs.filter((tab) => tab.mounted).map((tab) => (
                    <SettingsNavLink key={tab.to} tab={tab} />
                  ))}
                </div>
              </section>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 space-y-4 pb-safe">
          {needsAdmin ? <AdminRequiredBanner /> : null}
          <Outlet />
        </section>
      </div>
    </WorkbenchFrame>
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
          'xl:w-full xl:justify-between',
          isActive
            ? 'bg-indigo-50/80 text-brand-600 font-medium shadow-sm dark:bg-accent-bg dark:text-accent'
            : 'text-text-dim hover:bg-surface-hover hover:text-text',
        )
      }
    >
      <span className="min-w-0 truncate">{t(tab.i18nKey)}</span>
      {tab.recommended && (
        <Badge variant="accent" className="hidden xl:inline-flex">
          {t('navigation.recommended')}
        </Badge>
      )}
    </NavLink>
  )
}
