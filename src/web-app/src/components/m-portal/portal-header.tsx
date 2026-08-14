import { useTranslation } from 'react-i18next'
import { ChevronDown, Menu, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { displayAgentName } from './agent-visuals'

export interface AgentCatalogEntry {
  id: string
  name: string
  tagline: string
  color: string
  icon: LucideIcon
  category: string
}

interface PortalHeaderProps {
  dark: boolean
  agentId: string
  agentsCatalog: AgentCatalogEntry[]
  showModelDropdown: boolean
  onToggleModelDropdown: () => void
  onCloseModelDropdown: () => void
  onSelectAgent: (id: string) => void
  onOpenSidebar: () => void
  onToggleTheme: () => void
}

export function PortalHeader({
  dark,
  agentId,
  agentsCatalog,
  showModelDropdown,
  onToggleModelDropdown,
  onCloseModelDropdown,
  onSelectAgent,
  onOpenSidebar,
  onToggleTheme,
}: PortalHeaderProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <header className={cn(
      'z-30 flex shrink-0 items-center justify-between border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] transition-all',
      dark ? 'border-zinc-900 bg-zinc-950 text-white' : 'border-zinc-200 bg-white text-zinc-800',
    )}>
      <button
        type="button"
        onClick={onOpenSidebar}
        className={cn(
          'rounded-lg p-1.5 transition lg:invisible lg:pointer-events-none',
          dark ? 'hover:bg-zinc-900' : 'hover:bg-zinc-100',
        )}
        aria-label={t('chat.portal.brand')}
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={onToggleModelDropdown}
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition-all duration-300',
            dark ? 'border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800' : 'border-zinc-200 bg-zinc-100 text-zinc-800 hover:bg-zinc-200',
          )}
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="max-w-[120px] truncate">{displayAgentName(agentId)}</span>
          <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
        </button>

        {showModelDropdown && (
          <>
            <button type="button" className="fixed inset-0 z-[45] bg-black/40" aria-label="Close" onClick={onCloseModelDropdown} />
            <div className={cn(
              'absolute left-1/2 top-full z-50 mt-2 w-56 -translate-x-1/2 animate-in fade-in slide-in-from-top-2 rounded-2xl border p-2 shadow-2xl duration-200',
              dark ? 'border-zinc-800 bg-zinc-950 text-zinc-200' : 'border-zinc-200 bg-white text-zinc-800',
            )}>
              <p className="mb-1 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.selectAgent')}</p>
              <div className="space-y-1">
                {agentsCatalog.map((agent) => {
                  const Icon = agent.icon
                  const active = agent.id === agentId
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => onSelectAgent(agent.id)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-xl p-2 text-left text-xs transition-all',
                        active
                          ? (dark ? 'bg-zinc-800 text-teal-300' : 'bg-zinc-100 text-teal-600')
                          : (dark ? 'text-zinc-400 hover:bg-zinc-900/60' : 'text-zinc-600 hover:bg-zinc-50'),
                      )}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <div className={cn('rounded-md bg-gradient-to-tr p-1.5 text-white', agent.color)}>
                          <Icon className="h-3 w-3" />
                        </div>
                        <span className="truncate font-semibold">{agent.name}</span>
                      </div>
                      {active && <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={onToggleTheme}
        className={cn(
          'rounded-lg p-1.5 transition',
          dark ? 'text-yellow-400 hover:bg-zinc-900' : 'text-indigo-500 hover:bg-zinc-100',
        )}
        title={t('chat.portal.toggleTheme')}
      >
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </header>
  )
}
