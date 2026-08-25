/**
 * Portal library — workspace directory tree + preview/code pane.
 * Independent of the chat session; bound to the current agent's cwd.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown, ChevronRight, File, Folder, Loader2, X,
} from 'lucide-react'

import { useWorkspaceFiles } from '@/hooks/use-workspace'
import { MarkdownView } from '@/components/chat/markdown-view'
import { CodeFence } from '@/components/chat/code-fence'
import { cn } from '@/lib/utils'
import type { WorkspaceFileContent, WorkspaceFileEntry, WorkspaceFilesResponse } from '@/types/api'

function isWorkspaceFile(data: WorkspaceFilesResponse | undefined): data is WorkspaceFileContent {
  return data?.type === 'file'
}

export function PortalLibraryPane(props: {
  dark: boolean
  agentId: string
  path: string
  onPathChange: (path: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { dark, agentId, path, onPathChange } = props
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<'preview' | 'code'>('preview')
  const selected = path
  const fileQuery = useWorkspaceFiles(agentId, selected, {
    enabled: Boolean(agentId) && Boolean(selected),
  })
  const fileData = fileQuery.data
  const file = isWorkspaceFile(fileData) ? fileData : null

  return (
    <div
      className="flex h-full min-h-0 flex-col lg:flex-row"
      data-testid="portal-library-pane"
    >
      <div className={cn(
        'flex min-h-0 w-full shrink-0 flex-col border-b lg:w-72 lg:border-b-0 lg:border-r',
        dark ? 'border-zinc-800' : 'border-zinc-200',
      )}>
        <div className="shrink-0 space-y-2 p-3">
          <h2 className={cn('text-sm font-semibold', dark ? 'text-zinc-100' : 'text-zinc-900')}>
            {t('chat.portal.libraryTitle')}
          </h2>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('chat.portal.librarySearch')}
            className={cn(
              'h-8 w-full rounded-md border px-2 text-xs',
              dark
                ? 'border-zinc-700 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500'
                : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400',
            )}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <LibraryDir
            agent={agentId}
            dirPath=""
            depth={0}
            search={search.trim().toLowerCase()}
            selected={selected}
            dark={dark}
            onSelectFile={onPathChange}
          />
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={cn(
          'flex shrink-0 items-center gap-2 border-b px-3 py-2',
          dark ? 'border-zinc-800' : 'border-zinc-200',
        )}>
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-400">
            {selected || t('chat.portal.librarySelectFile')}
          </p>
          {file && (
            <>
              <ModeButton dark={dark} active={mode === 'preview'} onClick={() => setMode('preview')}>
                {t('chat.portal.libraryPreview')}
              </ModeButton>
              <ModeButton dark={dark} active={mode === 'code'} onClick={() => setMode('code')}>
                {t('chat.portal.libraryCode')}
              </ModeButton>
              <button
                type="button"
                onClick={() => onPathChange('')}
                className={cn('rounded-md p-1', dark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100')}
                aria-label={t('chat.portal.libraryClosePreview')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {!selected ? (
            <p className="text-xs text-zinc-400">{t('chat.portal.librarySelectFile')}</p>
          ) : fileQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('chat.portal.libraryLoading')}
            </div>
          ) : file ? (
            <FilePreview file={file} mode={mode} />
          ) : (
            <p className="text-xs text-zinc-400">{t('chat.portal.librarySelectFile')}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function ModeButton(props: {
  dark: boolean
  active: boolean
  onClick: () => void
  children: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'rounded-md px-2 py-0.5 text-[11px] font-semibold',
        props.active
          ? (props.dark ? 'bg-zinc-800 text-teal-400' : 'bg-zinc-100 text-teal-600')
          : (props.dark ? 'text-zinc-400 hover:bg-zinc-900' : 'text-zinc-500 hover:bg-zinc-50'),
      )}
    >
      {props.children}
    </button>
  )
}

function LibraryDir(props: {
  agent: string
  dirPath: string
  depth: number
  search: string
  selected: string
  dark: boolean
  onSelectFile: (path: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { agent, dirPath, depth, search, selected, dark, onSelectFile } = props
  const query = useWorkspaceFiles(agent, dirPath, { enabled: Boolean(agent) })
  const entries = query.data?.type === 'dir' ? query.data.entries : []
  const filtered = useMemo(() => {
    if (!search) return entries
    return entries.filter((e) => e.name.toLowerCase().includes(search)
      || (search.startsWith('.') && e.name.toLowerCase().endsWith(search)))
  }, [entries, search])

  if (depth === 0) {
    if (query.isLoading) {
      return (
        <div className="flex items-center gap-2 px-2 py-3 text-xs text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('chat.portal.libraryLoading')}
        </div>
      )
    }
    if (filtered.length === 0) {
      return <p className="px-2 py-3 text-xs text-zinc-400">{t('chat.portal.libraryEmpty')}</p>
    }
    return (
      <ul className="space-y-0.5">
        {filtered.map((entry) => (
          <LibraryEntry
            key={entry.name}
            agent={agent}
            parent={dirPath}
            entry={entry}
            depth={0}
            search={search}
            selected={selected}
            dark={dark}
            onSelectFile={onSelectFile}
          />
        ))}
      </ul>
    )
  }

  if (query.isLoading) {
    return (
      <div className="px-2 py-1 text-[11px] text-zinc-400">{t('chat.portal.libraryLoading')}</div>
    )
  }
  return (
    <ul className="space-y-0.5">
      {filtered.map((entry) => (
        <LibraryEntry
          key={entry.name}
          agent={agent}
          parent={dirPath}
          entry={entry}
          depth={depth}
          search={search}
          selected={selected}
          dark={dark}
          onSelectFile={onSelectFile}
        />
      ))}
    </ul>
  )
}

function LibraryEntry(props: {
  agent: string
  parent: string
  entry: WorkspaceFileEntry
  depth: number
  search: string
  selected: string
  dark: boolean
  onSelectFile: (path: string) => void
}): JSX.Element {
  const { agent, parent, entry, depth, search, selected, dark, onSelectFile } = props
  const path = parent ? `${parent}/${entry.name}` : entry.name
  const [open, setOpen] = useState(false)
  const active = selected === path

  if (entry.isDir) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs',
            dark ? 'text-zinc-300 hover:bg-zinc-900' : 'text-zinc-700 hover:bg-zinc-50',
          )}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <Folder className="h-3.5 w-3.5 shrink-0 text-teal-500" />
          <span className="truncate">{entry.name}</span>
        </button>
        {open && (
          <LibraryDir
            agent={agent}
            dirPath={path}
            depth={depth + 1}
            search={search}
            selected={selected}
            dark={dark}
            onSelectFile={onSelectFile}
          />
        )}
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectFile(path)}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs',
          active
            ? (dark ? 'bg-zinc-800 text-teal-400' : 'bg-zinc-100 text-teal-600')
            : (dark ? 'text-zinc-400 hover:bg-zinc-900' : 'text-zinc-600 hover:bg-zinc-50'),
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <File className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.name}</span>
      </button>
    </li>
  )
}

function FilePreview(props: { file: WorkspaceFileContent; mode: 'preview' | 'code' }): JSX.Element {
  const { t } = useTranslation()
  const { file, mode } = props
  if (file.encoding === 'base64') {
    return <p className="text-xs text-zinc-400">{t('chat.portal.libraryBinary')}</p>
  }
  const ext = file.path.split('.').pop()?.toLowerCase() ?? ''
  const lang = langFromExt(ext)
  return (
    <div className="space-y-2">
      {file.truncated && (
        <p className="text-[11px] text-amber-500">{t('chat.portal.libraryTruncated')}</p>
      )}
      {mode === 'preview' && ext === 'html' ? (
        <iframe
          title={file.path}
          sandbox=""
          className="h-[min(70vh,32rem)] w-full rounded-lg border border-zinc-200 bg-white"
          srcDoc={file.content}
        />
      ) : mode === 'preview' && (ext === 'md' || ext === 'markdown') ? (
        <MarkdownView content={file.content} className="text-sm" />
      ) : (
        <CodeFence className={`language-${lang}`}>{file.content}</CodeFence>
      )}
    </div>
  )
}

function langFromExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', markdown: 'markdown', py: 'python',
    sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', css: 'css',
    html: 'xml', htm: 'xml', go: 'go', rs: 'rust', sql: 'sql', txt: 'plaintext',
  }
  return map[ext] ?? 'plaintext'
}
