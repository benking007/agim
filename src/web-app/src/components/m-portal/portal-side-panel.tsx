/**
 * PortalSidePanel — persistent left rail (lg+) and mobile drawer content
 * for the agent portal.  Extracted from agent-portal.tsx to keep that file
 * focused on wiring and layout.
 */

import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import {
  ChevronDown, ChevronRight, Cloud, Folder, FolderPlus,
  Languages, MessageSquare, Plus, Sparkles, User, X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  canPickDirectory,
  dirFromFileList,
  pickWorkspaceDirectory,
} from '@/lib/pick-workspace-dir'
import { sessionWorkspaceId, type WebSessionEntry } from '@/lib/web-sessions'
import type { WebWorkspace } from '@/lib/web-workspaces'
import type { Lang } from '@/stores/prefs'
import { displayAgentName, type AgentVisual } from './agent-visuals'

export function PortalSidePanel(props: {
  dark: boolean
  agentId: string
  visual: AgentVisual
  AgentIcon: LucideIcon
  status: string
  lang: Lang
  showClose: boolean
  onClose: () => void
  onNew: () => void
  onToggleLang: () => void
  sessions: WebSessionEntry[]
  activeSessionId: string
  onSwitchSession: (threadId: string) => void
  workspaces: WebWorkspace[]
  activeWorkspaceId: string
  collapsedWorkspaces: Record<string, boolean>
  onToggleWorkspace: (id: string) => void
  onSelectWorkspace: (id: string) => void
  onWorkspaceCreated: (dir: { name: string; path: string }) => void
}): JSX.Element {
  const { t } = useTranslation()
  const {
    dark, agentId, visual, AgentIcon, status, lang, showClose,
    onClose, onNew, onToggleLang,
    sessions, activeSessionId, onSwitchSession,
    workspaces, activeWorkspaceId, collapsedWorkspaces,
    onToggleWorkspace, onSelectWorkspace, onWorkspaceCreated,
  } = props
  const dirInputRef = useRef<HTMLInputElement>(null)

  async function handleNewWorkspace(): Promise<void> {
    if (canPickDirectory()) {
      const result = await pickWorkspaceDirectory()
      if (result.status === 'picked') onWorkspaceCreated(result.dir)
      return
    }
    dirInputRef.current?.click()
  }

  function handleDirectoryInput(files: FileList | null): void {
    const dir = dirFromFileList(files)
    if (dirInputRef.current) dirInputRef.current.value = ''
    if (dir) onWorkspaceCreated(dir)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-6">
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
            active={false}
            dark={dark}
            icon={<Plus className="h-4 w-4" />}
            label={t('chat.portal.newConversation')}
            onClick={onNew}
          />
        </nav>
      </div>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
          <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">
            {t('chat.portal.workspaces')}
          </p>
          <button
            type="button"
            onClick={() => { void handleNewWorkspace() }}
            title={t('chat.portal.newWorkspace')}
            aria-label={t('chat.portal.newWorkspace')}
            className={cn(
              'rounded-md p-1 transition',
              dark ? 'text-zinc-400 hover:bg-zinc-800 hover:text-teal-400' : 'text-zinc-500 hover:bg-zinc-100 hover:text-teal-600',
            )}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
        <input
          ref={dirInputRef}
          type="file"
          data-testid="workspace-dir-input"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          multiple
          {...{ webkitdirectory: '', directory: '' }}
          onChange={(e) => handleDirectoryInput(e.target.files)}
        />
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label={t('chat.portal.workspaces')}>
          {workspaces.map((workspace) => {
            const collapsed = !!collapsedWorkspaces[workspace.id]
            const childSessions = sessions.filter((s) => sessionWorkspaceId(s) === workspace.id)
            const selected = workspace.id === activeWorkspaceId
            const label = workspace.kind === 'cloud'
              ? t('chat.portal.cloudWorkspace')
              : workspace.name
            const hint = workspace.kind === 'cloud'
              ? t('chat.portal.cloudWorkspaceHint')
              : (workspace.path && workspace.path !== workspace.name ? workspace.path : undefined)
            return (
              <div key={workspace.id} className="space-y-0.5">
                <div
                  className={cn(
                    'flex w-full items-center gap-0.5 rounded-xl px-1 py-1 transition-all',
                    selected
                      ? (dark ? 'bg-zinc-800/80 text-teal-400' : 'bg-zinc-100 text-teal-600')
                      : (dark ? 'text-zinc-400' : 'text-zinc-600'),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onToggleWorkspace(workspace.id)}
                    aria-expanded={!collapsed}
                    aria-label={label}
                    className={cn(
                      'rounded-md p-1',
                      dark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-50',
                    )}
                  >
                    {collapsed
                      ? <ChevronRight className="h-3 w-3 shrink-0" />
                      : <ChevronDown className="h-3 w-3 shrink-0" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectWorkspace(workspace.id)}
                    title={hint || label}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-0.5 text-left',
                      dark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-50',
                    )}
                  >
                    {workspace.kind === 'cloud'
                      ? <Cloud className="h-3.5 w-3.5 shrink-0" />
                      : <Folder className="h-3.5 w-3.5 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold">{label}</span>
                      {hint && (
                        <span className="block truncate text-[10px] font-medium text-zinc-400">{hint}</span>
                      )}
                    </span>
                  </button>
                </div>
                {!collapsed && (
                  <div className="space-y-0.5 pl-3">
                    {childSessions.length === 0 ? (
                      <p className="px-2.5 py-1.5 text-[11px] text-zinc-400">
                        {t('chat.portal.workspaceEmpty')}
                      </p>
                    ) : childSessions.map((session) => {
                      const active = session.id === activeSessionId
                      const title = session.title?.trim() || t('chat.portal.untitledConversation')
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => onSwitchSession(session.id)}
                          title={title}
                          aria-current={active ? 'true' : undefined}
                          className={cn(
                            'flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition-all',
                            active
                              ? (dark ? 'bg-zinc-800 text-teal-400' : 'bg-zinc-100 text-teal-600')
                              : (dark ? 'text-zinc-400 hover:bg-zinc-900' : 'text-zinc-600 hover:bg-zinc-50'),
                          )}
                        >
                          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">{title}</span>
                            <span className={cn(
                              'mt-0.5 block truncate text-[10px] font-medium',
                              active ? 'text-teal-500/80' : 'text-zinc-400',
                            )}>
                              {formatSessionAge(session.updatedAt, lang, t('chat.portal.justNow'))}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      </div>

      <div className="mt-4 shrink-0 space-y-3">
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
    </div>
  )
}

function formatSessionAge(ts: number, lang: Lang, justNow: string, now = Date.now()): string {
  const diffMs = now - ts
  if (diffMs < 45_000) return justNow
  const locale = lang === 'zh' ? 'zh' : 'en'
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const diffSec = Math.round(-diffMs / 1000)
  const abs = Math.abs(diffSec)
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), 'day')
  return new Date(ts).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
  })
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
