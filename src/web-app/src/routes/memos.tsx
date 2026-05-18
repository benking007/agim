/**
 * /memos — searchable memo list. Free-form text + who/what filters +
 * has-location toggle. Delete is the one mutation.
 *
 * Memos with location surface a small "Open map" dropdown that
 * routes to the provider URLs the backend prepared in `mapUrls`
 * (Baidu / Apple / Google / OSM).
 *
 * Searches are user-triggered (input + debounce) rather than poll-
 * driven — the query is read straight from URL params so deep-link
 * sharing works ("memos about taxes between Jan and April").
 *
 * Debounce: 300ms between the last keystroke and URL/query commit
 * — keeps the backend's FTS5 from running on every keypress.
 */

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { MapPin, NotebookText, RefreshCcw, Search, Trash2 } from 'lucide-react'

import { Topbar } from '@/components/shell/topbar'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useMemos, useDeleteMemo } from '@/hooks/use-memos'
import { describeError } from '@/lib/api/errors'
import type { Memo, ListMemosQuery } from '@/types/api'

const SEARCH_DEBOUNCE_MS = 300

export default function MemosRoute(): JSX.Element {
  const { t } = useTranslation(['memos', 'common'])
  const [params, setParams] = useSearchParams()

  // URL-driven filter state (read once per render).
  const q          = params.get('q') ?? ''
  const who        = params.get('who') ?? ''
  const what       = params.get('what') ?? ''
  const hasLoc     = params.get('has_location') === '1'
  const incExpired = params.get('include_expired') === '1'

  // Local-only echo of the text input. Effects below sync the URL
  // after the debounce so each keypress doesn't kick a fetch.
  const [qDraft, setQDraft] = useState(q)

  useEffect(() => {
    if (qDraft === q) return
    const timer = window.setTimeout(() => {
      patchParams({ q: qDraft || null })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft])

  const query: ListMemosQuery = useMemo(
    () => ({
      ...(q ? { query: q } : {}),
      ...(who ? { who } : {}),
      ...(what ? { what } : {}),
      ...(hasLoc ? { has_location: true } : {}),
      ...(incExpired ? { include_expired: true } : {}),
      limit: 200,
    }),
    [q, who, what, hasLoc, incExpired],
  )

  const { data, isLoading, isFetching, refetch } = useMemos(query)
  const memos = data?.memos ?? []

  const del = useDeleteMemo()
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  function patchParams(patch: Record<string, string | null>): void {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  async function onConfirmDelete(): Promise<void> {
    if (confirmDeleteId == null) return
    try {
      await del.mutateAsync(confirmDeleteId)
      toast.success(t('toast.deleted'))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
      throw err
    }
  }

  const columns: DataTableColumn<Memo>[] = useMemo(
    () => [
      {
        id: 'id',
        header: t('col.id'),
        cell: (r) => <span className="tabular-nums text-text-dim">#{r.id}</span>,
        headClassName: 'w-16',
      },
      {
        id: 'what',
        header: t('col.what'),
        cell: (r) => (
          <span className="line-clamp-2">
            {r.memo ? <span className="text-text">{r.memo}</span> : <span className="font-medium text-text">{r.what}</span>}
          </span>
        ),
        asCardTitle: true,
      },
      {
        id: 'who',
        header: t('col.who'),
        cell: (r) =>
          r.who ? (
            <Badge variant="secondary">{r.who}</Badge>
          ) : (
            <span className="text-text-muted">—</span>
          ),
        headClassName: 'w-32',
      },
      {
        id: 'when',
        header: t('col.when'),
        cell: (r) => (
          <span className="text-text-dim">
            {r.whenText || (r.whenAt ? formatTime(r.whenAt) : '—')}
          </span>
        ),
        headClassName: 'w-36',
      },
      {
        id: 'where',
        header: t('col.where'),
        cell: (r) =>
          r.where_label || (r.where_lat != null && r.where_lng != null) ? (
            <MapCell memo={r} />
          ) : (
            <span className="text-text-muted">—</span>
          ),
        headClassName: 'w-44',
      },
      {
        id: 'platform',
        header: t('col.platform'),
        cell: (r) => <span className="text-text-dim">{r.platform}</span>,
        headClassName: 'w-24',
        hideOnMobile: true,
      },
      {
        id: 'createdAt',
        header: t('col.createdAt'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.createdAt)}</span>,
        headClassName: 'w-36',
        hideOnMobile: true,
      },
      {
        id: 'actions',
        header: '',
        cell: (r) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                setConfirmDeleteId(r.id)
              }}
              disabled={del.isPending}
              aria-label={t('action.delete')}
            >
              <Trash2 className="h-3 w-3" />
              <span className="sr-only sm:not-sr-only sm:ml-1">{t('action.delete')}</span>
            </Button>
          </div>
        ),
        headClassName: 'w-24',
      },
    ],
    [t, del.isPending],
  )

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
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label={t('actions.refresh', { ns: 'common' })}
            >
              <RefreshCcw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
            </Button>
          </div>
          <p className="text-sm text-text-dim">{t('subtitle')}</p>
        </header>

        {/* Search bar */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <Input
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              placeholder={t('search.placeholder')}
              className="h-9 pl-7"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-end">
            <div className="flex flex-col gap-1">
              <Label htmlFor="who-filter" className="text-xs text-text-dim">
                {t('search.who')}
              </Label>
              <Input
                id="who-filter"
                value={who}
                onChange={(e) => patchParams({ who: e.target.value || null })}
                className="h-9 w-36"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="what-filter" className="text-xs text-text-dim">
                {t('search.what')}
              </Label>
              <Input
                id="what-filter"
                value={what}
                onChange={(e) => patchParams({ what: e.target.value || null })}
                className="h-9 w-36"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-1 text-sm text-text-dim">
              <input
                type="checkbox"
                checked={hasLoc}
                onChange={(e) => patchParams({ has_location: e.target.checked ? '1' : null })}
                className="h-4 w-4 accent-accent"
              />
              {t('search.hasLocation')}
            </label>
            <label className="inline-flex items-center gap-1 text-sm text-text-dim">
              <input
                type="checkbox"
                checked={incExpired}
                onChange={(e) => patchParams({ include_expired: e.target.checked ? '1' : null })}
                className="h-4 w-4 accent-accent"
              />
              {t('search.includeExpired')}
            </label>
          </div>
        </div>

        <DataTable
          columns={columns}
          rows={memos}
          getRowId={(r) => String(r.id)}
          loading={isLoading}
          emptyState={
            <EmptyState
              icon={<NotebookText />}
              title={t('empty.title')}
              description={t('empty.description')}
            />
          }
        />

        <ConfirmDialog
          open={confirmDeleteId != null}
          onOpenChange={(open) => {
            if (!open) setConfirmDeleteId(null)
          }}
          title={t('action.confirmDelete')}
          description={t('action.confirmDeleteDesc')}
          intent="danger"
          confirmLabel={t('action.delete')}
          onConfirm={onConfirmDelete}
        />
      </main>
    </div>
  )
}

interface MapCellProps {
  memo: Memo
}

const PROVIDER_LABEL_KEY: Record<string, string> = {
  baidu:  'openMap.baidu',
  apple:  'openMap.apple',
  google: 'openMap.google',
  osm:    'openMap.osm',
}

function MapCell({ memo }: MapCellProps): JSX.Element {
  const { t } = useTranslation('memos')
  const label = memo.where_label || `${memo.where_lat}, ${memo.where_lng}`
  const entries = Object.entries(memo.mapUrls ?? {})
  if (entries.length === 0) {
    return <span className="text-text-dim">{label}</span>
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-sm text-text-dim hover:text-accent"
          onClick={(e) => e.stopPropagation()}
        >
          <MapPin className="h-3 w-3" />
          <span className="line-clamp-1 underline-offset-2 hover:underline">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {entries.map(([provider, url]) => (
          <DropdownMenuItem key={provider} asChild>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t(PROVIDER_LABEL_KEY[provider] ?? 'openMap.label', { defaultValue: provider })}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
