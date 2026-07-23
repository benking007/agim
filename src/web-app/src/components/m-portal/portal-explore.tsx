import { useTranslation } from 'react-i18next'
import { Bot, ChevronRight, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentCatalogEntry } from './portal-header'

export const EXPLORE_CATS = ['All', 'Featured', 'Programming', 'Writing', 'Design', 'Lifestyle'] as const
export type ExploreCategory = (typeof EXPLORE_CATS)[number]

interface PortalExploreProps {
  dark: boolean
  searchQuery: string
  onSearchChange: (q: string) => void
  exploreCategory: ExploreCategory
  onCategoryChange: (cat: ExploreCategory) => void
  filteredAgents: AgentCatalogEntry[]
  onSelectAgent: (id: string) => void
  onClose: () => void
}

export function PortalExplore({
  dark,
  searchQuery,
  onSearchChange,
  exploreCategory,
  onCategoryChange,
  filteredAgents,
  onSelectAgent,
  onClose,
}: PortalExploreProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className={cn(
      'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-8 transition-colors duration-300 scrollbar-none',
      dark ? 'bg-zinc-950' : 'bg-zinc-100',
    )}>
      <div className="mx-auto w-full max-w-[750px] space-y-6">
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <h2 className={cn('text-lg font-black tracking-tight', dark ? 'text-white' : 'text-zinc-800')}>{t('chat.portal.exploreTitle')}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('chat.portal.closeExplore', { defaultValue: 'Close' })}
              title={t('chat.portal.closeExplore', { defaultValue: 'Close' })}
              className={cn(
                'mt-0.5 shrink-0 rounded-full p-1.5 transition',
                dark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100' : 'text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800',
              )}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-[11px] leading-normal text-zinc-400">
            {t('chat.portal.exploreSubtitle')}
          </p>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder={t('chat.portal.searchAgents')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className={cn(
              'w-full rounded-xl border py-2 pl-9 pr-4 text-md transition-all focus:border-teal-500 focus:outline-none',
              dark
                ? 'border-zinc-800 bg-zinc-900 text-zinc-200 placeholder:text-zinc-500'
                : 'border-zinc-200 bg-white text-zinc-800 placeholder:text-zinc-400 shadow-sm',
            )}
          />
          {searchQuery && (
            <button type="button" onClick={() => onSearchChange('')} className="absolute right-3 top-1/2 -translate-y-1/2">
              <X className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-600" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {EXPLORE_CATS.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => onCategoryChange(cat)}
              className={cn(
                'whitespace-nowrap rounded-full px-3 py-1 text-[10px] font-bold transition-all',
                exploreCategory === cat
                  ? 'border border-teal-500/30 bg-teal-500/20 text-teal-400'
                  : dark
                    ? 'bg-zinc-900 text-zinc-400 hover:text-white'
                    : 'bg-zinc-200/60 text-zinc-600 hover:bg-zinc-200',
              )}
            >
              {cat === 'All' ? t('chat.portal.cats.All')
                : cat === 'Featured' ? t('chat.portal.cats.Featured')
                  : cat === 'Programming' ? t('chat.portal.cats.Programming')
                    : cat === 'Writing' ? t('chat.portal.cats.Writing')
                      : cat === 'Design' ? t('chat.portal.cats.Design')
                        : t('chat.portal.cats.Lifestyle')}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">
            {t('chat.portal.directoryResults', { count: filteredAgents.length })}
          </p>
          <div className="space-y-2.5">
            {filteredAgents.map((agent) => {
              const Icon = agent.icon
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => onSelectAgent(agent.id)}
                  className={cn(
                    'group flex w-full items-start justify-between rounded-2xl border p-3 text-left transition-all',
                    dark
                      ? 'border-zinc-900 bg-zinc-900/40 hover:border-zinc-800 hover:bg-zinc-900'
                      : 'border-zinc-200 bg-white shadow-sm hover:bg-zinc-100/50',
                  )}
                >
                  <div className="flex items-start gap-3 truncate">
                    <div className={cn('shrink-0 rounded-xl bg-gradient-to-tr p-2 text-white shadow-sm', agent.color)}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="truncate text-left">
                      <div className="flex items-center gap-2">
                        <h3 className={cn(
                          'text-xs font-bold transition-colors group-hover:text-teal-500',
                          dark ? 'text-zinc-200' : 'text-zinc-800',
                        )}>
                          {agent.name}
                        </h3>
                        <span className={cn(
                          'rounded-full px-1.5 py-0.5 text-[8px] font-bold',
                          dark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500',
                        )}>
                          {agent.category}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-zinc-400">{agent.tagline}</p>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 self-center text-zinc-400" />
                </button>
              )
            })}
            {filteredAgents.length === 0 && (
              <p className="py-8 text-center text-xs text-zinc-400">{t('chat.portal.noAgents')}</p>
            )}
          </div>
        </div>

        <div className={cn(
          'space-y-3 rounded-3xl border p-4 text-center',
          dark
            ? 'border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950'
            : 'border-zinc-200/80 bg-zinc-100 shadow-sm',
        )}>
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-teal-500/10 text-teal-500">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h3 className={cn('text-xs font-bold', dark ? 'text-zinc-200' : 'text-zinc-800')}>{t('chat.portal.ideaTitle')}</h3>
            <p className="mt-0.5 text-[10px] text-zinc-400">{t('chat.portal.ideaBody')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
