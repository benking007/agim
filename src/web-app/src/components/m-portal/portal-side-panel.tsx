/**
 * PortalSidePanel — persistent left rail (lg+) and mobile drawer content
 * for the agent portal.  Extracted from agent-portal.tsx to keep that file
 * focused on wiring and layout.
 */

import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import {
  Compass, Languages, MessageSquare, Plus, Sparkles, User, X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { type Lang } from '@/stores/prefs'
import { displayAgentName, type AgentVisual } from './agent-visuals'

type Tab = 'chat' | 'explore'

export function PortalSidePanel(props: {
  dark: boolean
  agentId: string
  visual: AgentVisual
  AgentIcon: LucideIcon
  activeTab: Tab
  status: string
  lang: Lang
  showClose: boolean
  onClose: () => void
  onChat: () => void
  onExplore: () => void
  onNew: () => void
  onToggleLang: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const {
    dark, agentId, visual, AgentIcon, activeTab, status, lang, showClose,
    onClose, onChat, onExplore, onNew, onToggleLang,
  } = props
  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-teal-500">
            <Sparkles className="h-5 w-5" />
            <span className="text-sm">{t('chat.portal.brand')}</span>
          </div>
          {showClose && (
            <button
              type="button"
              onClick={onClose}
              className={cn('rounded-full p-1.5 transition', dark ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-100')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.activeAgent')}</p>
          <div className={cn(
            'flex items-center gap-3 rounded-xl border p-3',
            dark ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-zinc-50',
          )}>
            <div className={cn('rounded-lg bg-gradient-to-tr p-2 text-white', visual.color)}>
              <AgentIcon className="h-4 w-4" />
            </div>
            <div className="truncate">
              <h4 className={cn('text-xs font-bold', dark ? 'text-zinc-200' : 'text-zinc-800')}>
                {displayAgentName(agentId)}
              </h4>
              <p className="truncate text-[10px] text-zinc-400">{visual.tagline}</p>
            </div>
          </div>
        </div>

        <nav className="space-y-1">
          <p className="mb-2 text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.shortcuts')}</p>
          <SideNavButton
            active={activeTab === 'chat'}
            dark={dark}
            icon={<MessageSquare className="h-4 w-4" />}
            label={t('chat.portal.chat')}
            onClick={onChat}
          />
          <SideNavButton
            active={activeTab === 'explore'}
            dark={dark}
            icon={<Compass className="h-4 w-4" />}
            label={t('chat.portal.explore')}
            onClick={onExplore}
          />
          <SideNavButton
            active={false}
            dark={dark}
            icon={<Plus className="h-4 w-4" />}
            label={t('chat.portal.newConversation')}
            onClick={onNew}
          />
        </nav>
      </div>

      <div className="space-y-3">
        <div className={cn('flex items-center justify-between gap-2 border-t pt-4', dark ? 'border-zinc-800' : 'border-zinc-200')}>
          <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">{t('chat.portal.language')}</p>
          <button
            type="button"
            onClick={onToggleLang}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
              dark ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800' : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100',
            )}
            aria-label={t('chat.portal.language')}
          >
            <Languages className="h-3.5 w-3.5" />
            {lang === 'zh' ? t('lang.zh') : t('lang.en')}
          </button>
        </div>
        <div className={cn('flex items-center gap-3', dark ? 'border-zinc-800' : 'border-zinc-200')}>
          <div className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full',
            dark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-600',
          )}>
            <User className="h-4 w-4" />
          </div>
          <div>
            <h4 className={cn('text-xs font-bold', dark ? 'text-zinc-200' : 'text-zinc-800')}>Agim</h4>
            <p className="text-[9px] font-semibold uppercase tracking-wider text-teal-500">
              {status === 'open' ? t('chat.portal.connected') : status}
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

function SideNavButton(props: {
  active: boolean
  dark: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}): JSX.Element {
  const { active, dark, icon, label, onClick } = props
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl p-2.5 text-xs font-semibold transition-all',
        active
          ? (dark ? 'bg-zinc-800 text-teal-400' : 'bg-zinc-100 text-teal-600')
          : (dark ? 'text-zinc-400 hover:bg-zinc-900' : 'text-zinc-600 hover:bg-zinc-50'),
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
