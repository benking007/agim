/**
 * Choose a host subdirectory under `.agim-workspaces/<agent>/`.
 *
 * Same-machine browsers can also open the native folder picker; the
 * chosen name still has to resolve under that agent tree. Remote
 * browsers type a path or walk the listing from GET /api/workspace-files.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Folder, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api/endpoints'
import { canPickDirectory, pickWorkspaceDirectory } from '@/lib/pick-workspace-dir'
import { workspaceBasename } from '@/lib/web-workspaces'
import { cn } from '@/lib/utils'
import type { WorkspaceDirListing, WorkspaceFileEntry } from '@/types/api'

export function PortalWorkspacePicker(props: {
  open: boolean
  agentId: string
  onOpenChange: (open: boolean) => void
  onPicked: (dir: { name: string; path: string }) => void
  /** `relative` returns a workspace-relative path (schedule artifacts). */
  pathKind?: 'absolute' | 'relative'
  /** Prefill / start listing at this workspace-relative path. */
  initialPath?: string
}): JSX.Element {
  const { open, agentId, onOpenChange, onPicked, pathKind = 'absolute', initialPath } = props
  const relative = pathKind === 'relative'
  const { t } = useTranslation()
  const [relPath, setRelPath] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const start = sanitizeRel(initialPath || '')
    setRelPath(parentRel(start))
    setTyped(start)
    setError('')
    setBusy(false)
  }, [open, initialPath])

  const listing = useQuery({
    queryKey: ['portal', 'workspace-picker', agentId, relPath],
    queryFn: () => api.getWorkspaceFiles({ agent: agentId, path: relPath || undefined }),
    enabled: open && !!agentId,
    staleTime: 15_000,
    retry: false,
  })

  useEffect(() => {
    if (!open || !listing.isError || !relPath) return
    setRelPath('')
  }, [open, listing.isError, relPath])

  const dir: WorkspaceDirListing | undefined = (() => {
    const data = listing.data
    return data && data.type === 'dir' ? data : undefined
  })()
  const folders = useMemo(() => {
    if (!dir) return [] as WorkspaceFileEntry[]
    return dir.entries.filter((e) => e.isDir && !e.broken && !e.symlink_escape)
  }, [dir])
  const crumbs = relPath.split('/').filter(Boolean)
  const atRoot = crumbs.length === 0

  async function confirm(path: string): Promise<void> {
    const next = path.trim()
    if (!next) {
      setError(t('chat.portal.workspacePickerRootHint'))
      return
    }
    if (relative) {
      const rel = sanitizeRel(next) || (dir?.base ? toWorkspaceRel(next, dir.base) : null)
      if (!rel) {
        setError(t('chat.portal.workspacePickerRootHint'))
        return
      }
      onPicked({ name: workspaceBasename(rel), path: rel })
      onOpenChange(false)
      return
    }
    setBusy(true)
    setError('')
    try {
      const resolved = await api.resolveWorkspacePath({ path: next, agent: agentId })
      if (!resolved.ok || !resolved.path) {
        setError(t('chat.portal.workspaceUnresolved', { agent: agentId }))
        return
      }
      onPicked({ name: resolved.name || workspaceBasename(resolved.path), path: resolved.path })
      onOpenChange(false)
    } catch {
      setError(t('chat.portal.workspaceUnresolved', { agent: agentId }))
    } finally {
      setBusy(false)
    }
  }

  async function pickLocal(): Promise<void> {
    const result = await pickWorkspaceDirectory()
    if (result.status !== 'picked') return
    setTyped(result.dir.path)
    await confirm(result.dir.path)
  }

  function enter(name: string): void {
    setRelPath(joinRel(relPath, name))
    setError('')
  }

  function jumpTo(index: number): void {
    setRelPath(crumbs.slice(0, index + 1).join('/'))
    setError('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="z-[70] sm:max-w-lg"
        overlayClassName="z-[60]"
        data-testid="workspace-picker"
      >
        <DialogHeader>
          <DialogTitle>{t('chat.portal.workspacePickerTitle')}</DialogTitle>
          <DialogDescription>
            {t('chat.portal.workspacePickerDesc', { agent: agentId })}
            {dir?.base && (
              <span className="mt-1 block truncate font-mono text-[11px]">{dir.base}</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs" aria-label={t('chat.portal.workspacePickerTitle')}>
          <button
            type="button"
            className="rounded px-1 py-0.5 font-semibold text-accent hover:underline"
            onClick={() => { setRelPath(''); setError('') }}
          >
            {agentId}
          </button>
          {crumbs.map((crumb, i) => {
            const trail = crumbs.slice(0, i + 1).join('/')
            return (
              <span key={trail} className="flex min-w-0 items-center gap-0.5">
                <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" />
                <button
                  type="button"
                  className="truncate rounded px-1 py-0.5 hover:underline"
                  onClick={() => jumpTo(i)}
                >
                  {crumb}
                </button>
              </span>
            )
          })}
        </nav>

        <div className="max-h-56 min-h-[8rem] overflow-y-auto rounded-md border border-border">
          {listing.isLoading && (
            <p className="flex items-center gap-2 px-3 py-6 text-sm text-text-dim">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('chat.portal.workspacePickerLoading')}
            </p>
          )}
          {listing.isError && (
            <p className="px-3 py-6 text-sm text-danger">{t('chat.portal.workspacePickerError')}</p>
          )}
          {dir && folders.length === 0 && !listing.isLoading && (
            <p className="px-3 py-6 text-sm text-text-dim">{t('chat.portal.workspacePickerEmpty')}</p>
          )}
          {folders.map((entry) => (
            <FolderRow
              key={entry.name}
              entry={entry}
              onEnter={() => enter(entry.name)}
              onSelect={() => { void confirm(joinRel(relPath, entry.name)) }}
              selectLabel={t('chat.portal.workspacePickerUse')}
              disabled={busy}
            />
          ))}
        </div>

        {atRoot && (
          <p className="text-xs text-text-dim">{t('chat.portal.workspacePickerRootHint')}</p>
        )}

        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void confirm(typed)
          }}
        >
          <label className="text-xs font-medium text-text-dim" htmlFor="workspace-picker-path">
            {t('chat.portal.workspacePickerPath')}
          </label>
          <Input
            id="workspace-picker-path"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t('chat.portal.workspacePickerPathPlaceholder')}
            disabled={busy}
            autoComplete="off"
          />
        </form>

        {error && <p className="text-sm text-danger" role="alert">{error}</p>}

        <DialogFooter>
          {canPickDirectory() && !relative && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => { void pickLocal() }}>
              {t('chat.portal.workspacePickerBrowseLocal')}
            </Button>
          )}
          {!atRoot && (
            <Button
              type="button"
              data-testid="workspace-picker-use-current"
              disabled={busy || !dir}
              onClick={() => { void confirm(relPath) }}
            >
              {t('chat.portal.workspacePickerUse')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FolderRow(props: {
  entry: WorkspaceFileEntry
  onEnter: () => void
  onSelect: () => void
  selectLabel: string
  disabled: boolean
}): JSX.Element {
  const { entry, onEnter, onSelect, selectLabel, disabled } = props
  return (
    <div className="flex items-center gap-1 border-b border-border last:border-b-0">
      <button
        type="button"
        disabled={disabled}
        onClick={onEnter}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm',
          'hover:bg-surface-hover disabled:opacity-55',
        )}
      >
        <Folder className="h-4 w-4 shrink-0 text-text-dim" />
        <span className="truncate">{entry.name}</span>
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className="shrink-0 px-2 py-2 text-xs font-medium text-accent hover:underline disabled:opacity-55"
      >
        {selectLabel}
      </button>
    </div>
  )
}

export function joinRel(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split(/[\\/]/))
    .filter((p) => p && p !== '.')
    .join('/')
}

/** Workspace-relative path, or empty when the value is missing / escapes. */
export function sanitizeRel(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return ''
  const parts = trimmed.split('/').filter((p) => p && p !== '.')
  if (parts.length === 0 || parts.some((p) => p === '..')) return ''
  return parts.join('/')
}

export function parentRel(rel: string): string {
  const parts = sanitizeRel(rel).split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

/** Strip `base` from an absolute workspace path. Root itself is not a subfolder. */
export function toWorkspaceRel(absPath: string, base: string): string | null {
  const abs = absPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = base.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!abs || !root || abs === root) return null
  if (!abs.startsWith(`${root}/`)) return null
  return sanitizeRel(abs.slice(root.length + 1)) || null
}
