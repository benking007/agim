import { createContext, useContext, useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  Bot,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Code2,
  Gauge,
  MessageSquare,
  PanelLeft,
  Plug,
  Settings,
  Sparkles,
  Workflow,
} from 'lucide-react'

import { Topbar } from '@/components/shell/topbar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfig } from '@/hooks/use-settings'
import { useAgentsStatus } from '@/hooks/use-workspace'
import { agentDisplayName } from '@/lib/agent-label'
import { cn } from '@/lib/utils'
import { useIsAdmin } from '@/stores/auth'

interface WorkbenchFrameProps {
  children: React.ReactNode
  contentClassName?: string
  footer?: boolean
}

const WorkbenchChromeContext = createContext(false)

/**
 * Use on pages that sometimes mount alone and sometimes nest under
 * Tasks / Memory / Settings. Skips a second Topbar + sidebar when a
 * parent already rendered {@link WorkbenchFrame}.
 */
export function PageFrame({
  children,
  contentClassName,
  footer = true,
}: WorkbenchFrameProps): JSX.Element {
  const nested = useContext(WorkbenchChromeContext)
  if (nested) {
    return <div className={cn('min-w-0', contentClassName)}>{children}</div>
  }
  return (
    <WorkbenchFrame contentClassName={contentClassName} footer={footer}>
      {children}
    </WorkbenchFrame>
  )
}

interface WorkbenchNavItem {
  to: string
  labelKey: string
  icon: JSX.Element
  end?: boolean
  pulse?: boolean
}

interface WorkbenchNavGroup {
  id: string
  labelKey: string
  icon: JSX.Element
  items: WorkbenchNavItem[]
}

const WORKBENCH_NAV: WorkbenchNavGroup[] = [
  {
    id: 'control',
    labelKey: 'dashboard.side.control',
    icon: <Gauge />,
    items: [
      { to: '/dashboard', labelKey: 'dashboard.side.overview', icon: <Sparkles /> },
      { to: '/', labelKey: 'dashboard.quick.chat', icon: <MessageSquare />, end: true, pulse: true },
      { to: '/settings/agents', labelKey: 'dashboard.cards.agent.action', icon: <Bot /> },
    ],
  },
  {
    id: 'api',
    labelKey: 'dashboard.side.setup',
    icon: <Plug />,
    items: [
      { to: '/settings/llm', labelKey: 'dashboard.cards.llm.action', icon: <Code2 /> },
      { to: '/settings/messengers', labelKey: 'dashboard.cards.im.action', icon: <Plug /> },
    ],
  },
  {
    id: 'shortcuts',
    labelKey: 'dashboard.side.operate',
    icon: <PanelLeft />,
    items: [
      { to: '/tasks', labelKey: 'dashboard.advanced.tasks', icon: <Workflow /> },
      { to: '/memory', labelKey: 'dashboard.advanced.memory', icon: <BrainCircuit /> },
      { to: '/workspace', labelKey: 'dashboard.quick.workspace', icon: <PanelLeft /> },
      { to: '/settings/observability', labelKey: 'dashboard.advanced.observability', icon: <Activity /> },
      { to: '/settings', labelKey: 'nav.settings', icon: <Settings /> },
    ],
  },
]

function workbenchNav(isAdmin: boolean): WorkbenchNavGroup[] {
  if (isAdmin) return WORKBENCH_NAV
  return [
    {
      id: 'shortcuts',
      labelKey: 'dashboard.side.operate',
      icon: <PanelLeft />,
      items: [
        { to: '/', labelKey: 'dashboard.quick.chat', icon: <MessageSquare />, end: true, pulse: true },
        { to: '/tasks', labelKey: 'dashboard.advanced.tasks', icon: <Workflow /> },
        { to: '/workspace', labelKey: 'dashboard.quick.workspace', icon: <PanelLeft /> },
        { to: '/settings', labelKey: 'nav.settings', icon: <Settings /> },
      ],
    },
  ]
}

const SIDEBAR_COLLAPSED_KEY = 'agim-workbench-sidebar-collapsed'

export function WorkbenchFrame({
  children,
  contentClassName,
  footer = true,
}: WorkbenchFrameProps): JSX.Element {
  const { t } = useTranslation()
  const isAdmin = useIsAdmin()
  const groups = workbenchNav(isAdmin)
  const cfgQuery = useConfig({ enabled: isAdmin })
  const agentsQuery = useAgentsStatus()
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(WORKBENCH_NAV.map((group) => [group.id, true])),
  )

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // Local storage may be unavailable in hardened browsers/tests.
    }
  }, [collapsed])

  const toggleLabel = collapsed ? t('dashboard.side.expand') : t('dashboard.side.collapse')
  const defaultAgent = isAdmin
    ? (cfgQuery.data?.defaultAgent || cfgQuery.data?.agents?.[0] || '')
    : Object.keys(agentsQuery.data ?? {})[0] || ''
  const defaultAgentLabel = defaultAgent ? agentDisplayName(defaultAgent) : t('dashboard.unknown')
  const collapsedItems = groups.flatMap((group) =>
    group.items.map((item) => ({
      ...item,
      key: `${group.id}:${item.to}`,
    })),
  )

  function toggleGroup(id: string): void {
    setExpandedGroups((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <WorkbenchChromeContext.Provider value={true}>
    <TooltipProvider delayDuration={180}>
      <div className="flex h-dvh flex-col bg-bg text-text antialiased">
      <Topbar />

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            'hidden min-h-0 shrink-0 flex-col border-r border-border bg-surface transition-all duration-300 lg:flex',
            collapsed ? 'w-[4.5rem]' : 'w-64',
          )}
        >
          <div
            className={cn(
              'flex h-16 items-center border-b border-border px-3',
              collapsed ? 'justify-center' : 'justify-between',
            )}
          >
            {!collapsed && (
              <span className="text-xs font-bold uppercase tracking-wider text-text-muted">
                {t('dashboard.side.title')}
                <span className="ml-1 text-text-muted/60">MENU</span>
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-xl text-text-dim transition-colors hover:bg-surface-hover hover:text-text',
                    collapsed && 'h-11 w-11',
                  )}
                  aria-label={toggleLabel}
                  onClick={() => setCollapsed((v) => !v)}
                >
                  {collapsed
                    ? <ChevronsRight className="h-5 w-5" aria-hidden="true" />
                    : <ChevronsLeft className="h-5 w-5" aria-hidden="true" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{toggleLabel}</TooltipContent>
            </Tooltip>
          </div>

          <nav
            className={cn(
              'flex-1 overflow-y-auto py-4',
              collapsed ? 'px-2' : 'px-3',
            )}
            aria-label={t('dashboard.side.title')}
          >
            {collapsed ? (
              <div className="flex flex-col items-center gap-2">
                {collapsedItems.map((item) => (
                  <WorkbenchNavLink key={item.key} item={item} collapsed />
                ))}
              </div>
            ) : (
              <div className="space-y-5">
                {groups.map((group) => (
                  <section key={group.id}>
                    <button
                      type="button"
                      className="mb-2 flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1 text-xs font-semibold text-text-muted transition-colors hover:bg-surface-hover hover:text-text-dim"
                      aria-expanded={expandedGroups[group.id] ?? true}
                      onClick={() => toggleGroup(group.id)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5" aria-hidden="true">
                          {group.icon}
                        </span>
                        <span className="truncate">{t(group.labelKey)}</span>
                      </span>
                      {(expandedGroups[group.id] ?? true) ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      )}
                    </button>

                    {(expandedGroups[group.id] ?? true) && (
                      <div className="ml-2 space-y-1 border-l border-border pl-3">
                        {group.items.map((item) => (
                          <WorkbenchNavLink key={item.to} item={item} collapsed={false} />
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            )}
          </nav>

          {!collapsed && (
            <div className="border-t border-border bg-surface-2/50 p-4">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                <span className="text-[10px] font-medium text-text-muted">
                  {t('dashboard.side.heartbeat')}
                </span>
              </div>
            </div>
          )}
        </aside>

        <main
          data-agim-scroll-root
          className={cn('min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 xl:px-8 xl:py-6', contentClassName)}
        >
          {children}
        </main>
      </div>

      {footer && (
        <div className="hidden items-center justify-between border-t border-border bg-surface-2/60 px-6 py-2 text-xs text-text-muted lg:flex">
          <div className="flex items-center gap-4">
            <span>
              {t('dashboard.footer.core')}：
              <strong className="text-text">{t('dashboard.footer.online')}</strong>
            </span>
            <span>
              {t('dashboard.footer.agent')}：
              <strong className="text-text">{defaultAgentLabel}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
            <span>{t('dashboard.footer.safe')}</span>
          </div>
        </div>
      )}
      </div>
    </TooltipProvider>
    </WorkbenchChromeContext.Provider>
  )
}

function WorkbenchNavLink({
  item,
  collapsed,
}: {
  item: WorkbenchNavItem
  collapsed: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const label = t(item.labelKey)
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'relative flex items-center rounded-xl text-left font-semibold no-underline transition-all',
          collapsed ? 'h-11 w-11 justify-center px-0 py-0' : 'w-full justify-between px-3 py-2.5 text-sm',
          isActive
            ? 'bg-indigo-50/90 text-brand-600 shadow-sm shadow-indigo-100/70 dark:bg-accent-bg dark:text-accent'
            : 'text-text-dim hover:bg-surface-hover hover:text-text',
        )
      }
    >
      <span className={cn('flex min-w-0 items-center', collapsed ? 'justify-center' : 'gap-2.5')}>
        <span
          className={cn(
            'shrink-0 text-current transition-colors',
            collapsed ? '[&_svg]:h-5 [&_svg]:w-5' : '[&_svg]:h-[18px] [&_svg]:w-[18px]',
          )}
          aria-hidden="true"
        >
          {item.icon}
        </span>
        {!collapsed && <span className="truncate">{label}</span>}
      </span>
      {item.pulse && (
        <span
          className={cn(
            'h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-300',
            collapsed && 'absolute right-1.5 top-1.5',
          )}
          aria-hidden="true"
        />
      )}
    </NavLink>
  )
  if (!collapsed) return link
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block">{link}</span>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function readSidebarCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
    if (saved == null) return true
    return saved === '1'
  } catch {
    return true
  }
}
