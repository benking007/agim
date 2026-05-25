/**
 * /settings — layout shell with sub-tab nav (environment / service).
 *
 * Workspaces / WeChat QR / Admin allowlist will land as additional
 * sub-tabs in PR-19b/c. The `mounted` flag gates their nav links.
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
  { to: 'messengers',   i18nKey: 'tabs.messengers',   mounted: true },
  { to: 'email',        i18nKey: 'tabs.email',        mounted: true },
  { to: 'viewer',       i18nKey: 'tabs.viewer',       mounted: true },
  { to: 'agents',       i18nKey: 'tabs.agents',       mounted: true },
  // Stage 6 — native LLM stack. Three tabs in a logical group:
  // LLM backends (config + secrets) -> MCP external servers ->
  // native agent / evaluator / heartbeat behavior knobs.
  { to: 'llm',          i18nKey: 'tabs.llm',          mounted: true },
  { to: 'mcp',          i18nKey: 'tabs.mcp',          mounted: true },
  { to: 'native-agent', i18nKey: 'tabs.nativeAgent',  mounted: true },
  // P1 follow-up — agim SKILL.md editor.
  { to: 'agim-skills',  i18nKey: 'tabs.agimSkills',   mounted: true },
  { to: 'policy',       i18nKey: 'tabs.policy',       mounted: true },
  { to: 'security',     i18nKey: 'tabs.security',     mounted: true },
  { to: 'workspaces',   i18nKey: 'tabs.workspaces',   mounted: true },
  { to: 'admins',       i18nKey: 'tabs.admins',       mounted: true },
  // R13 follow-up — /settings/env catch-all editor removed; raw env-var
  // editing belongs in `~/.agim/env` on the host, not in a web form.
  { to: 'service',      i18nKey: 'tabs.service',      mounted: true },
]

export default function SettingsLayout(): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />

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
