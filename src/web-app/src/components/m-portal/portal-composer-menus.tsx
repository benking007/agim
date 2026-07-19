/**
 * Portal `/` and `@` popups (Cursor-style) + "show more" modals.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Bell,
  Boxes,
  Bug,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  HelpCircle,
  ListTodo,
  Sparkles,
  Star,
  StickyNote,
  X,
  Zap,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { client } from '@/lib/api/client'
import { api } from '@/lib/api/endpoints'
import type { WorkspaceFileEntry } from '@/types/api'
import {
  bumpSkillUsage,
  bumpSlashUsage,
  filterSlashCommands,
  sortSkillsByUsage,
  type PortalSkillItem,
  type PortalSlashCommand,
  PRIORITY_COMMAND_IDS,
} from './portal-slash-commands'

const SKILL_PREVIEW = 3
const CMD_PREVIEW = 5

function PopupShell({
  dark,
  anchor,
  children,
  width = 280,
}: {
  dark: boolean
  anchor: { left: number; bottom: number; maxH: number } | null
  children: ReactNode
  width?: number
}): JSX.Element | null {
  if (!anchor) return null
  return createPortal(
    <div
      role="listbox"
      style={{
        left: anchor.left,
        bottom: anchor.bottom,
        maxHeight: anchor.maxH,
        width,
      }}
      className={cn(
        'fixed z-[110] overflow-y-auto rounded-xl border p-1.5 shadow-2xl scrollbar-none',
        dark ? 'border-zinc-700/80 bg-zinc-900 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-800',
      )}
    >
      {children}
    </div>,
    document.body,
  )
}

function SectionLabel({ dark, children }: { dark: boolean; children: ReactNode }): JSX.Element {
  return (
    <p className={cn(
      'px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide',
      dark ? 'text-zinc-500' : 'text-zinc-400',
    )}>
      {children}
    </p>
  )
}

function RowButton({
  dark,
  active,
  onClick,
  icon,
  title,
  subtitle,
  trailing,
}: {
  dark: boolean
  active?: boolean
  onClick: () => void
  icon: ReactNode
  title: string
  subtitle?: string
  trailing?: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
        active
          ? (dark ? 'bg-zinc-800' : 'bg-zinc-100')
          : (dark ? 'hover:bg-zinc-800/70' : 'hover:bg-zinc-50'),
      )}
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight">{title}</span>
        {subtitle ? (
          <span className={cn('mt-0.5 block truncate text-[11px] leading-tight', dark ? 'text-zinc-500' : 'text-zinc-400')}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {trailing}
    </button>
  )
}

function MoreLink({
  dark,
  label,
  onClick,
}: {
  dark: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors',
        dark ? 'text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-300' : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600',
      )}
    >
      {label}
    </button>
  )
}

function ModalShell({
  dark,
  title,
  onClose,
  children,
}: {
  dark: boolean
  title: string
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className={cn(
          'flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl shadow-2xl sm:rounded-2xl',
          dark ? 'bg-zinc-950 text-zinc-100' : 'bg-white text-zinc-900',
        )}
      >
        <div className={cn(
          'flex items-center justify-between gap-2 border-b px-4 py-3',
          dark ? 'border-zinc-800' : 'border-zinc-200',
        )}>
          <p className="truncate text-sm font-semibold">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full',
              dark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100',
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function useComposerAnchor(open: boolean, formRef: React.RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<{ left: number; bottom: number; maxH: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const sync = (): void => {
      const el = formRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const gap = 6
      const bottom = Math.max(8, window.innerHeight - rect.top + gap)
      const maxH = Math.max(160, window.innerHeight - bottom - 12)
      const left = Math.max(8, Math.min(rect.left + 8, window.innerWidth - 288))
      setPos({ left, bottom, maxH })
    }
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [open, formRef])
  return pos
}

function usePortalSkills(): PortalSkillItem[] {
  const agim = useQuery({
    queryKey: ['portal', 'agim-skills'],
    queryFn: async () => {
      try {
        const res = await client.get<{ skills: Array<{ name: string; description: string }> }>('/api/agim-skills')
        return (res.skills || []).map((s) => ({
          name: s.name,
          description: s.description || '',
        }))
      } catch {
        return [] as PortalSkillItem[]
      }
    },
    staleTime: 60_000,
  })
  const cli = useQuery({
    queryKey: ['portal', 'cli-skills'],
    queryFn: async () => {
      try {
        const res = await api.listSkills()
        return (res.skills || []).map((s) => ({
          name: s.slug || s.name,
          description: s.description || '',
        }))
      } catch {
        return [] as PortalSkillItem[]
      }
    },
    staleTime: 60_000,
    enabled: !agim.isLoading && (agim.data?.length ?? 0) === 0,
  })
  return useMemo(() => {
    const list = (agim.data && agim.data.length > 0) ? agim.data : (cli.data || [])
    return sortSkillsByUsage(list)
  }, [agim.data, cli.data])
}

function commandIcon(id: string): ReactNode {
  switch (id) {
    case 'plan': return <ListTodo className="h-3.5 w-3.5 text-orange-400" />
    case 'memo': return <StickyNote className="h-3.5 w-3.5 text-amber-400" />
    case 'goal': return <ListTodo className="h-3.5 w-3.5 text-sky-400" />
    case 'remember': return <Bell className="h-3.5 w-3.5 text-rose-400" />
    case 'models': return <Boxes className="h-3.5 w-3.5 text-violet-400" />
    case 'help': return <HelpCircle className="h-3.5 w-3.5 text-zinc-400" />
    case 'abort': return <Bug className="h-3.5 w-3.5 text-pink-400" />
    default: return <Zap className="h-3.5 w-3.5 text-yellow-400" />
  }
}

export interface PortalSlashPopupProps {
  dark: boolean
  open: boolean
  query: string
  formRef: React.RefObject<HTMLElement | null>
  planMode: boolean
  activeIndex: number
  onActiveIndexChange: (next: number | ((prev: number) => number)) => void
  onPickCommand: (cmd: PortalSlashCommand) => void
  onPickSkill: (skill: PortalSkillItem) => void
  onClose: () => void
}

export function PortalSlashPopup({
  dark,
  open,
  query,
  formRef,
  planMode,
  activeIndex,
  onActiveIndexChange,
  onPickCommand,
  onPickSkill,
  onClose,
}: PortalSlashPopupProps): JSX.Element | null {
  const { t } = useTranslation()
  const skills = usePortalSkills()
  const commands = useMemo(() => filterSlashCommands(query), [query])
  const q = query.trim().toLowerCase().replace(/^\//, '')
  const filteredSkills = useMemo(() => {
    if (!q) return skills
    return skills.filter((s) =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [skills, q])

  const previewSkills = filteredSkills.slice(0, SKILL_PREVIEW)
  const moreSkills = Math.max(0, filteredSkills.length - SKILL_PREVIEW)

  // Priority commands first among filtered, capped at CMD_PREVIEW
  const previewCommands = useMemo(() => {
    const priority = PRIORITY_COMMAND_IDS
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is PortalSlashCommand => !!c)
    const rest = commands.filter((c) => !(PRIORITY_COMMAND_IDS as readonly string[]).includes(c.id))
    const merged = [...priority, ...rest]
    return merged.slice(0, CMD_PREVIEW)
  }, [commands])
  const moreCommands = Math.max(0, commands.length - previewCommands.length)

  const [skillsModal, setSkillsModal] = useState(false)
  const [cmdsModal, setCmdsModal] = useState(false)

  const flatItems = useMemo(() => {
    const items: Array<{ kind: 'skill'; skill: PortalSkillItem } | { kind: 'command'; cmd: PortalSlashCommand }> = []
    for (const s of previewSkills) items.push({ kind: 'skill', skill: s })
    for (const c of previewCommands) items.push({ kind: 'command', cmd: c })
    return items
  }, [previewSkills, previewCommands])

  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex
  const flatItemsRef = useRef(flatItems)
  flatItemsRef.current = flatItems

  useEffect(() => {
    if (!open) return
    if (activeIndex >= flatItems.length) onActiveIndexChange(Math.max(0, flatItems.length - 1))
  }, [open, activeIndex, flatItems.length, onActiveIndexChange])

  useEffect(() => {
    if (!open) {
      setSkillsModal(false)
      setCmdsModal(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (skillsModal || cmdsModal) return
      const items = flatItemsRef.current
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (items.length === 0) return
        onActiveIndexChange((prev) => (prev + 1) % items.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (items.length === 0) return
        onActiveIndexChange((prev) => (prev - 1 + items.length) % items.length)
      } else if (e.key === 'Enter' && !e.shiftKey) {
        const item = items[activeIndexRef.current]
        if (!item) return
        e.preventDefault()
        e.stopPropagation()
        if (item.kind === 'skill') onPickSkill(item.skill)
        else onPickCommand(item.cmd)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, skillsModal, cmdsModal, onActiveIndexChange, onPickSkill, onPickCommand, onClose])

  const anchor = useComposerAnchor(open && !skillsModal && !cmdsModal, formRef)
  if (!open) return null

  let idx = 0

  return (
    <>
      <PopupShell dark={dark} anchor={anchor}>
        {previewSkills.length > 0 && (
          <>
            <SectionLabel dark={dark}>
              {t('chat.portal.slash.skills', { defaultValue: 'Skills' })}
            </SectionLabel>
            {previewSkills.map((s) => {
              const i = idx++
              return (
                <RowButton
                  key={`skill-${s.name}`}
                  dark={dark}
                  active={i === activeIndex}
                  onClick={() => onPickSkill(s)}
                  icon={<Sparkles className="h-3.5 w-3.5 text-teal-400" />}
                  title={s.name}
                  subtitle={s.description || undefined}
                />
              )
            })}
            {moreSkills > 0 && (
              <MoreLink
                dark={dark}
                label={t('chat.portal.slash.showMoreSkills', {
                  count: moreSkills,
                  defaultValue: `Show ${moreSkills} more skills`,
                })}
                onClick={() => setSkillsModal(true)}
              />
            )}
          </>
        )}
        {previewCommands.length > 0 && (
          <>
            <SectionLabel dark={dark}>
              {t('chat.portal.slash.commands', { defaultValue: 'Commands' })}
            </SectionLabel>
            {previewCommands.map((c) => {
              const i = idx++
              const subtitle = c.id === 'plan'
                ? (planMode
                  ? t('chat.portal.slash.planOn', { defaultValue: 'Plan mode is on — click to turn off' })
                  : (c.description || undefined))
                : c.description
              return (
                <RowButton
                  key={`cmd-${c.id}`}
                  dark={dark}
                  active={i === activeIndex}
                  onClick={() => onPickCommand(c)}
                  icon={commandIcon(c.id)}
                  title={c.label}
                  subtitle={subtitle}
                />
              )
            })}
            {moreCommands > 0 && (
              <MoreLink
                dark={dark}
                label={t('chat.portal.slash.showMoreCommands', {
                  count: moreCommands,
                  defaultValue: `Show ${moreCommands} more commands`,
                })}
                onClick={() => setCmdsModal(true)}
              />
            )}
          </>
        )}
        {previewSkills.length === 0 && previewCommands.length === 0 && (
          <p className={cn('px-2 py-3 text-center text-[12px]', dark ? 'text-zinc-500' : 'text-zinc-400')}>
            {t('chat.portal.slash.empty', { defaultValue: 'No matching skills or commands' })}
          </p>
        )}
      </PopupShell>

      {skillsModal && (
        <ModalShell
          dark={dark}
          title={t('chat.portal.slash.allSkills', { defaultValue: 'Skills' })}
          onClose={() => setSkillsModal(false)}
        >
          {filteredSkills.map((s) => (
            <RowButton
              key={s.name}
              dark={dark}
              onClick={() => {
                setSkillsModal(false)
                onPickSkill(s)
              }}
              icon={<Star className="h-3.5 w-3.5 text-teal-400" />}
              title={s.name}
              subtitle={s.description || undefined}
            />
          ))}
        </ModalShell>
      )}

      {cmdsModal && (
        <ModalShell
          dark={dark}
          title={t('chat.portal.slash.allCommands', { defaultValue: 'Commands' })}
          onClose={() => setCmdsModal(false)}
        >
          {commands.map((c) => (
            <RowButton
              key={c.id}
              dark={dark}
              onClick={() => {
                setCmdsModal(false)
                onPickCommand(c)
              }}
              icon={commandIcon(c.id)}
              title={c.label}
              subtitle={c.description}
            />
          ))}
        </ModalShell>
      )}
    </>
  )
}

export interface PortalAtPopupProps {
  dark: boolean
  open: boolean
  query: string
  agentId: string
  formRef: React.RefObject<HTMLElement | null>
  activeIndex: number
  onActiveIndexChange: (next: number | ((prev: number) => number)) => void
  onPickWorkspace: () => void
  onPickFile: (relPath: string, isDir: boolean) => void
  onClose: () => void
}

type AtMode = 'root' | 'browse'

export function PortalAtPopup({
  dark,
  open,
  query,
  agentId,
  formRef,
  activeIndex,
  onActiveIndexChange,
  onPickWorkspace,
  onPickFile,
  onClose,
}: PortalAtPopupProps): JSX.Element | null {
  const { t } = useTranslation()
  const [mode, setMode] = useState<AtMode>('root')
  const [dirPath, setDirPath] = useState('')
  const q = query.trim().toLowerCase()

  useEffect(() => {
    if (!open) {
      setMode('root')
      setDirPath('')
    }
  }, [open])

  const listing = useQuery({
    queryKey: ['portal', 'workspace-files', agentId, dirPath],
    queryFn: () => api.getWorkspaceFiles({ agent: agentId, path: dirPath || undefined }),
    enabled: open && mode === 'browse' && !!agentId,
    staleTime: 15_000,
  })

  const entries = useMemo(() => {
    const data = listing.data
    if (data?.type !== 'dir') return [] as WorkspaceFileEntry[]
    const list = data.entries.filter((e) => !e.broken && !e.symlink_escape)
    if (!q) return list
    return list.filter((e) => e.name.toLowerCase().includes(q))
  }, [listing.data, q])

  const rootItems = useMemo(() => {
    const items = [
      { id: 'workspace', label: 'workspace', sub: 'workspace' },
      { id: 'files', label: 'Files & Folders', sub: undefined as string | undefined },
    ]
    if (!q) return items
    return items.filter((i) => i.label.toLowerCase().includes(q) || (i.sub || '').includes(q))
  }, [q])

  const flatCount = mode === 'root' ? rootItems.length : entries.length
  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex
  const rootItemsRef = useRef(rootItems)
  rootItemsRef.current = rootItems
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const modeRef = useRef(mode)
  modeRef.current = mode
  const dirPathRef = useRef(dirPath)
  dirPathRef.current = dirPath
  const flatCountRef = useRef(flatCount)
  flatCountRef.current = flatCount

  useEffect(() => {
    if (!open) return
    if (activeIndex >= flatCount) onActiveIndexChange(Math.max(0, flatCount - 1))
  }, [open, activeIndex, flatCount, onActiveIndexChange])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (modeRef.current === 'browse') {
          if (dirPathRef.current) {
            const parts = dirPathRef.current.split('/').filter(Boolean)
            parts.pop()
            setDirPath(parts.join('/'))
          } else {
            setMode('root')
          }
          return
        }
        onClose()
        return
      }
      const count = flatCountRef.current
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (count === 0) return
        onActiveIndexChange((prev) => (prev + 1) % count)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (count === 0) return
        onActiveIndexChange((prev) => (prev - 1 + count) % count)
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        const idx = activeIndexRef.current
        if (modeRef.current === 'root') {
          const item = rootItemsRef.current[idx]
          if (!item) return
          if (item.id === 'workspace') onPickWorkspace()
          else {
            setMode('browse')
            setDirPath('')
            onActiveIndexChange(0)
          }
        } else {
          const entry = entriesRef.current[idx]
          if (!entry) return
          const rel = dirPathRef.current ? `${dirPathRef.current}/${entry.name}` : entry.name
          if (entry.isDir) {
            setDirPath(rel)
            onActiveIndexChange(0)
          } else {
            onPickFile(rel, false)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onActiveIndexChange, onPickWorkspace, onPickFile, onClose])

  const anchor = useComposerAnchor(open, formRef)
  if (!open) return null

  return (
    <PopupShell dark={dark} anchor={anchor} width={300}>
      {mode === 'root' && rootItems.map((item, i) => (
        <RowButton
          key={item.id}
          dark={dark}
          active={i === activeIndex}
          onClick={() => {
            if (item.id === 'workspace') onPickWorkspace()
            else {
              setMode('browse')
              setDirPath('')
              onActiveIndexChange(0)
            }
          }}
          icon={item.id === 'workspace'
            ? <Folder className="h-3.5 w-3.5 text-sky-400" />
            : <FolderOpen className="h-3.5 w-3.5 text-sky-400" />}
          title={item.label}
          subtitle={item.sub}
          trailing={item.id === 'files'
            ? <ChevronRight className="mt-0.5 h-3.5 w-3.5 text-zinc-500" />
            : undefined}
        />
      ))}

      {mode === 'browse' && (
        <>
          <button
            type="button"
            onClick={() => {
              if (dirPath) {
                const parts = dirPath.split('/').filter(Boolean)
                parts.pop()
                setDirPath(parts.join('/'))
              } else {
                setMode('root')
              }
              onActiveIndexChange(0)
            }}
            className={cn(
              'mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]',
              dark ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-50',
            )}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="truncate">{dirPath || t('chat.portal.at.workspaceRoot', { defaultValue: 'workspace' })}</span>
          </button>
          {listing.isLoading && (
            <p className={cn('px-2 py-3 text-[12px]', dark ? 'text-zinc-500' : 'text-zinc-400')}>
              {t('chat.portal.at.loading', { defaultValue: 'Loading…' })}
            </p>
          )}
          {listing.isError && (
            <p className="px-2 py-3 text-[12px] text-rose-400">
              {t('chat.portal.at.loadFailed', { defaultValue: 'Failed to load workspace files' })}
            </p>
          )}
          {!listing.isLoading && !listing.isError && entries.length === 0 && (
            <p className={cn('px-2 py-3 text-[12px]', dark ? 'text-zinc-500' : 'text-zinc-400')}>
              {t('chat.portal.at.empty', { defaultValue: 'Empty folder' })}
            </p>
          )}
          {entries.map((entry, i) => {
            const rel = dirPath ? `${dirPath}/${entry.name}` : entry.name
            return (
              <RowButton
                key={rel}
                dark={dark}
                active={i === activeIndex}
                onClick={() => {
                  if (entry.isDir) {
                    setDirPath(rel)
                    onActiveIndexChange(0)
                  } else {
                    onPickFile(rel, false)
                  }
                }}
                icon={entry.isDir
                  ? <Folder className="h-3.5 w-3.5 text-sky-400" />
                  : <FileIcon className="h-3.5 w-3.5 text-zinc-400" />}
                title={entry.name}
                trailing={entry.isDir
                  ? (
                    <button
                      type="button"
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-medium',
                        dark ? 'bg-zinc-800 text-sky-300 hover:bg-zinc-700' : 'bg-zinc-100 text-sky-600 hover:bg-zinc-200',
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        onPickFile(rel, true)
                      }}
                    >
                      {t('chat.portal.at.selectFolder', { defaultValue: 'Select' })}
                    </button>
                  )
                  : undefined}
              />
            )
          })}
        </>
      )}
    </PopupShell>
  )
}

/** Detect trailing `/query` (slash menu) at end of string. */
export function detectSlashTrigger(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor)
  const m = /(^|[\s\n])\/([^\s]*)$/.exec(before)
  if (!m) return null
  const query = m[2] ?? ''
  const start = before.length - query.length - 1
  return { start, query }
}

/** Detect trailing `@query` at end of string before cursor. */
export function detectAtTrigger(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor)
  // Don't fire when inside a completed marker `[...]`
  const m = /(^|[\s\n])@([^\s@[\]]*)$/.exec(before)
  if (!m) return null
  const query = m[2] ?? ''
  const start = before.length - query.length - 1
  return { start, query }
}

export function replaceTriggerRange(
  text: string,
  start: number,
  cursor: number,
  insertion: string,
): { next: string; cursor: number } {
  const next = `${text.slice(0, start)}${insertion}${text.slice(cursor)}`
  const nextCursor = start + insertion.length
  return { next, cursor: nextCursor }
}

export { bumpSlashUsage, bumpSkillUsage }
