/**
 * /settings — grouped navigation shell.
 *
 * Settings has grown into the densest part of the console. Keep the
 * URLs stable, but group the entry points so new operators see the
 * core setup path before advanced capability and operations pages.
 */

import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { WorkbenchFrame } from '@/components/shell/workbench-frame'
import { NoPermissionPanel } from '@/components/shell/no-permission'
import { Badge } from '@/components/ui/badge'
import { useConfig } from '@/hooks/use-settings'
import { isAdminRequiredError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'
import { useIsAdmin } from '@/stores/auth'

interface SubTab {
  to: string
  i18nKey: string
  mounted: boolean
  recommended?: boolean
  adminOnly?: boolean
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
      { to: 'start', i18nKey: 'tabs.start', mounted: true, recommended: true, adminOnly: true },
      { to: 'account', i18nKey: 'tabs.account', mounted: true },
    ],
  },
  {
    id: 'core',
    i18nKey: 'navigation.groups.core',
    tabs: [
      { to: 'messengers', i18nKey: 'tabs.messengers', mounted: true, adminOnly: true },
      { to: 'agents',     i18nKey: 'tabs.agents',     mounted: true, adminOnly: true },
      { to: 'llm',        i18nKey: 'tabs.llm',        mounted: true, adminOnly: true },
      { to: 'mobile',     i18nKey: 'tabs.mobile',     mounted: true, adminOnly: true },
    ],
  },
  {
    id: 'capabilities',
    i18nKey: 'navigation.groups.capabilities',
    tabs: [
      // P1 follow-up — agim SKILL.md editor.
      { to: 'agim-skills', i18nKey: 'tabs.agimSkills', mounted: true },
      { to: 'tools',       i18nKey: 'tabs.tools',      mounted: true, adminOnly: true },
      { to: 'mcp',         i18nKey: 'tabs.mcp',        mounted: true, adminOnly: true },
      { to: 'advanced',    i18nKey: 'tabs.advanced',   mounted: true, adminOnly: true },
    ],
  },
  {
    id: 'operations',
    i18nKey: 'navigation.groups.operations',
    tabs: [
      { to: 'policy',     i18nKey: 'tabs.policy',     mounted: true, adminOnly: true },
      { to: 'pricing',    i18nKey: 'tabs.pricing',    mounted: true, adminOnly: true },
      { to: 'security',   i18nKey: 'tabs.security',   mounted: true, adminOnly: true },
      { to: 'workspaces', i18nKey: 'tabs.workspaces', mounted: true, adminOnly: true },
      { to: 'admins',     i18nKey: 'tabs.admins',     mounted: true, adminOnly: true },
      // R13 follow-up — /settings/env catch-all editor removed; raw
      // env-var editing belongs in `~/.agim/env` on the host.
      { to: 'observability', i18nKey: 'tabs.observability', mounted: true, adminOnly: true },
      { to: 'service',    i18nKey: 'tabs.service',    mounted: true, adminOnly: true },
    ],
  },
]

function isAdminSettingsPath(pathname: string): boolean {
  const rest = pathname.replace(/^\/settings\/?/, '')
  const [head, ...tail] = rest.split('/').filter(Boolean)
  if (!head) return false
  if (head === 'agim-skills' && tail[0] === 'injection') return true
  const tab = SUB_TAB_GROUPS.flatMap((g) => g.tabs).find((t) => t.to === head)
  return Boolean(tab?.adminOnly)
}

export default function SettingsLayout(): JSX.Element {
  const { t } = useTranslation('settings')
  const location = useLocation()
  const isAdmin = useIsAdmin()
  const cfgQuery = useConfig({ enabled: isAdmin })
  const needsAdmin = isAdmin && isAdminRequiredError(cfgQuery.error)
  const blocked = !isAdmin && isAdminSettingsPath(location.pathname)

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
            {SUB_TAB_GROUPS.map((group) => {
              const tabs = group.tabs.filter((tab) => tab.mounted && (isAdmin || !tab.adminOnly))
              if (!tabs.length) return null
              return (
              <section key={group.id} className="min-w-max xl:min-w-0">
                <h2 className="px-2 text-[11px] font-semibold uppercase leading-5 text-text-muted">
                  {t(group.i18nKey)}
                </h2>
                <div className="mt-1 flex gap-1 xl:flex-col">
                  {tabs.map((tab) => (
                    <SettingsNavLink key={tab.to} tab={tab} />
                  ))}
                </div>
              </section>
              )
            })}
          </nav>
        </aside>

        <section className="min-w-0 space-y-4 pb-safe">
          {needsAdmin ? (
            <p role="alert" className="text-sm text-text-dim">
              {t('adminGate.hint', {
                defaultValue: 'This control-plane page needs an administrator account.',
              })}
            </p>
          ) : null}
          {blocked ? <NoPermissionPanel /> : <Outlet />}
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
