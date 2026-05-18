/**
 * /workspace — file browser + editor for the per-agent CWD.
 *
 * Single-column finder UI: pick an agent → drill into the workspace
 * via ?path=, click a file → opens the editor pane below the
 * listing. No recursive tree because the listing handler is cheap
 * and the typical workspace has ≤ 30 entries per dir.
 *
 * Editor is a plain `<textarea>` — Monaco / CodeMirror would balloon
 * the bundle for what is realistically operator-edits to
 * CLAUDE.md / AGENTS.md / config snippets. Binary files render a
 * read-only placeholder. Truncated files (> 1 MiB) block save to
 * prevent destructive overwrites.
 */

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronUp, File, Folder, FolderTree, Loader2, RefreshCcw } from 'lucide-react'

import { Topbar } from '@/components/shell/topbar'
import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useAgentsStatus,
  useWorkspaceFiles,
  useWriteWorkspaceFile,
} from '@/hooks/use-workspace'
import { describeError } from '@/lib/api/errors'
import type {
  WorkspaceFileContent,
  WorkspaceFileEntry,
} from '@/types/api'
import { cn } from '@/lib/utils'

export default function WorkspaceRoute(): JSX.Element {
  const { t } = useTranslation(['workspace', 'common'])
  const [params, setParams] = useSearchParams()
  const agent = params.get('agent') ?? ''
  const path  = params.get('path')  ?? ''

  const agentsQuery = useAgentsStatus()
  const agents = agentsQuery.data ?? {}
  const agentNames = useMemo(() => Object.keys(agents).sort(), [agents])

  /** Query may resolve to either a dir listing or file content — we
   *  branch on `data.type` in the render. */
  const filesQuery = useWorkspaceFiles(agent, path, { enabled: Boolean(agent) })
  const data = filesQuery.data
  const isDir = data?.type === 'dir'
  const isFile = data?.type === 'file'

  function patchParams(patch: Record<string, string | null>): void {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: false })
  }

  function setAgent(next: string): void {
    // Switching agent always resets the path so we don't drag a
    // claude-specific path into codex's workspace.
    patchParams({ agent: next || null, path: null })
  }
  function navigateTo(nextPath: string): void {
    patchParams({ path: nextPath || null })
  }
  function navigateUp(): void {
    if (!path) return
    const idx = path.lastIndexOf('/')
    const parent = idx >= 0 ? path.slice(0, idx) : ''
    navigateTo(parent)
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-3 py-4 sm:px-4 pb-safe">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => filesQuery.refetch()}
              disabled={!agent || filesQuery.isFetching}
              aria-label={t('actions.refresh', { ns: 'common' })}
            >
              {filesQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
            </Button>
          </div>
          <p className="text-sm text-text-dim">{t('subtitle')}</p>
        </header>

        {/* Agent picker */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="agent" className="text-xs text-text-dim">
              {t('agentPicker.label')}
            </Label>
            <Select value={agent || '__placeholder__'} onValueChange={(v) => setAgent(v === '__placeholder__' ? '' : v)}>
              <SelectTrigger id="agent" className="h-9 w-64">
                <SelectValue placeholder={t('agentPicker.placeholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__placeholder__" disabled>
                  {t('agentPicker.placeholder')}
                </SelectItem>
                {agentNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs">{name}</span>
                      <span className={cn(
                        'inline-block h-1.5 w-1.5 rounded-full',
                        agents[name] ? 'bg-success' : 'bg-text-muted',
                      )} />
                      <span className="text-text-dim text-xs">
                        {agents[name] ? t('agentPicker.online') : t('agentPicker.offline')}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {!agent ? (
          <EmptyState
            icon={<FolderTree />}
            title={t('noAgent.title')}
            description={t('noAgent.description')}
          />
        ) : (
          <>
            {/* Breadcrumb + Up */}
            <Breadcrumb
              path={path}
              onNavigate={navigateTo}
              onUp={navigateUp}
            />

            {filesQuery.isLoading ? (
              <div className="h-32 rounded-md bg-surface-2 animate-pulse" />
            ) : isDir && data?.type === 'dir' ? (
              <DirListing
                entries={data.entries}
                onEnter={(entry) => navigateTo(
                  path ? `${path}/${entry.name}` : entry.name,
                )}
              />
            ) : isFile && data?.type === 'file' ? (
              <FileEditor
                file={data}
                agent={agent}
                onBack={navigateUp}
              />
            ) : (
              <EmptyState
                icon={<FolderTree />}
                title={t('editor.loadFailed')}
                description={filesQuery.error?.message ?? ''}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}

interface BreadcrumbProps {
  path: string
  onNavigate: (path: string) => void
  onUp: () => void
}

function Breadcrumb({ path, onNavigate, onUp }: BreadcrumbProps): JSX.Element {
  const { t } = useTranslation('workspace')
  const parts = path ? path.split('/') : []
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onUp}
        disabled={!path}
        aria-label={t('tree.up')}
      >
        <ChevronUp className="h-4 w-4" />
      </Button>
      <button
        type="button"
        onClick={() => onNavigate('')}
        className="text-text-dim hover:text-text rounded px-1 py-0.5"
      >
        {t('tree.rootLabel')}
      </button>
      {parts.map((part, i) => {
        const upto = parts.slice(0, i + 1).join('/')
        return (
          <span key={upto} className="flex items-center gap-1">
            <span className="text-text-muted">/</span>
            <button
              type="button"
              onClick={() => onNavigate(upto)}
              className="text-text-dim hover:text-text rounded px-1 py-0.5"
            >
              {part}
            </button>
          </span>
        )
      })}
    </div>
  )
}

interface DirListingProps {
  entries: WorkspaceFileEntry[]
  onEnter: (entry: WorkspaceFileEntry) => void
}

function DirListing({ entries, onEnter }: DirListingProps): JSX.Element {
  const { t } = useTranslation('workspace')
  if (entries.length === 0) {
    return <div className="rounded-md border border-border bg-surface p-3 text-sm text-text-dim">{t('tree.empty')}</div>
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border bg-surface">
      {entries.map((e) => (
        <li key={e.name}>
          <button
            type="button"
            onClick={() => onEnter(e)}
            disabled={e.broken || e.symlink_escape}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-sm text-left',
              'transition-colors hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {e.isDir ? <Folder className="h-4 w-4 text-accent" /> : <File className="h-4 w-4 text-text-dim" />}
            <span className={e.isDir ? 'font-medium text-text' : 'text-text'}>{e.name}</span>
            {e.symlink_escape && (
              <Badge variant="warning" className="ml-2">{t('tree.symlinkEscape')}</Badge>
            )}
            {e.broken && !e.symlink_escape && (
              <Badge variant="danger" className="ml-2">{t('tree.broken')}</Badge>
            )}
            {!e.isDir && e.size != null && (
              <span className="ml-auto text-xs text-text-muted tabular-nums">{formatSize(e.size)}</span>
            )}
            {e.mtime && (
              <span className={cn('text-xs text-text-muted tabular-nums', !e.isDir && e.size != null ? 'ml-3' : 'ml-auto')}>
                {formatTime(e.mtime)}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

interface FileEditorProps {
  file: WorkspaceFileContent
  agent: string
  onBack: () => void
}

function FileEditor({ file, agent, onBack }: FileEditorProps): JSX.Element {
  const { t } = useTranslation(['workspace', 'common'])
  const [draft, setDraft] = useState(file.content)
  useEffect(() => { setDraft(file.content) }, [file.content])
  const dirty = draft !== file.content

  const write = useWriteWorkspaceFile()

  async function onSave(): Promise<void> {
    try {
      await write.mutateAsync({ agent, path: file.path, body: { content: draft } })
      toast.success(t('toast.saved', { path: file.path }))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  if (file.encoding === 'base64') {
    return (
      <div className="rounded-md border border-border bg-surface p-4 text-sm">
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">
          <ChevronUp className="h-4 w-4" />
          {t('tree.up')}
        </Button>
        <p className="text-text-dim">{t('editor.binary')}</p>
        <p className="mt-2 text-xs text-text-muted tabular-nums">
          {file.path} · {formatSize(file.size)}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronUp className="h-4 w-4" />
          {t('tree.up')}
        </Button>
        <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-mono">{file.path}</code>
        {file.truncated && <Badge variant="warning">truncated</Badge>}
        {dirty && <Badge variant="info">{t('editor.dirtyHint')}</Badge>}
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={() => void onSave()}
          disabled={!dirty || write.isPending || file.truncated}
        >
          {write.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {write.isPending ? t('editor.saving') : t('editor.save')}
        </Button>
      </div>
      {file.truncated && (
        <p className="text-xs text-warning">{t('editor.truncated')}</p>
      )}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={24}
        spellCheck={false}
        className={cn(
          'w-full resize-y rounded-md border bg-bg px-3 py-2',
          'font-mono text-xs leading-5',
          'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg',
          dirty ? 'border-accent' : 'border-border',
        )}
      />
      {!dirty && (
        <p className="text-xs text-text-muted">
          {t('editor.savedMeta', { size: file.size, at: formatTime(file.mtime) })}
        </p>
      )}
    </div>
  )
}

function formatTime(iso: string | null): string {
  if (iso == null) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
}
