/**
 * /memory/facts — list / search / delete the user's facts.
 *
 * Reads `?user=` from the URL (the layout writes it). Without a
 * user_key the route shows a friendly empty state pointing at the
 * picker — no query fires until a user is chosen.
 *
 * Search + category filter live in URL params so deep-link sharing
 * works ("show me john's goals matching tax"). The free-text input
 * is local-only with a 300ms debounce, same pattern as /memos, so
 * the FTS5 layer isn't hit on every keystroke.
 *
 * Single-row delete via the per-row Delete button; batch delete via
 * checkbox selection + the bulk-delete action bar. Both route
 * through ConfirmDialog.
 */

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Brain, Loader2, RefreshCcw, Search, Trash2 } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { Pagination } from '@/components/common/pagination'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useMemoryFacts,
  useDeleteFactById,
  useBulkDeleteFacts,
} from '@/hooks/use-memory'
import { describeError } from '@/lib/api/errors'
import type { Fact, FactCategory, ListMemoryFactsQuery } from '@/types/api'

const CATEGORY_OPTIONS: FactCategory[] = ['fact', 'preference', 'goal', 'history', 'profile']
const PER_PAGE_OPTIONS = [25, 50, 100]
const DEFAULT_PER_PAGE = 50
const SEARCH_DEBOUNCE_MS = 300

export default function MemoryFactsRoute(): JSX.Element {
  const { t } = useTranslation(['memory', 'common'])
  const [params, setParams] = useSearchParams()

  const userKey = params.get('user') ?? ''
  const q       = params.get('q') ?? ''
  const cat     = (params.get('cat') as FactCategory | null) ?? null
  const page    = Math.max(1, Number(params.get('page')) || 1)
  const perPage = Number(params.get('per_page')) || DEFAULT_PER_PAGE

  const [qDraft, setQDraft] = useState(q)
  useEffect(() => {
    if (qDraft === q) return
    const timer = window.setTimeout(() => patchParams({ q: qDraft || null }), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft])

  const query: ListMemoryFactsQuery = useMemo(
    () => ({
      user_key: userKey,
      ...(q ? { query: q } : {}),
      ...(cat ? { category: cat } : {}),
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    [userKey, q, cat, page, perPage],
  )

  const { data, isLoading, isFetching, refetch } = useMemoryFacts(query, { enabled: Boolean(userKey) })
  const facts = data?.facts ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / perPage))

  // Selection state for the bulk delete bar.
  const [selection, setSelection] = useState<Set<string>>(new Set())
  useEffect(() => { setSelection(new Set()) }, [userKey, q, cat, page, perPage])

  const deleteOne = useDeleteFactById()
  const bulkDelete = useBulkDeleteFacts()

  const [confirmOneId, setConfirmOneId] = useState<number | null>(null)
  const [confirmBulk, setConfirmBulk] = useState(false)

  function patchParams(patch: Record<string, string | null>): void {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    // Reset to page 1 on any filter mutation.
    if (Object.keys(patch).some((k) => k !== 'page')) next.delete('page')
    setParams(next, { replace: false })
  }

  async function onConfirmDeleteOne(): Promise<void> {
    if (confirmOneId == null || !userKey) return
    try {
      await deleteOne.mutateAsync({ id: confirmOneId, user_key: userKey })
      toast.success(t('facts.toast.deletedOne'))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
      throw err
    }
  }

  async function onConfirmBulk(): Promise<void> {
    if (!userKey || selection.size === 0) return
    const ids = Array.from(selection).map(Number).filter(Number.isFinite)
    try {
      const r = await bulkDelete.mutateAsync({ user_key: userKey, body: { ids } })
      toast.success(t('facts.toast.deletedMany', { count: r.deleted }))
      setSelection(new Set())
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
      throw err
    }
  }

  const columns: DataTableColumn<Fact>[] = useMemo(
    () => [
      {
        id: 'id',
        header: t('facts.col.id'),
        cell: (r) => <span className="tabular-nums text-text-dim">#{r.id}</span>,
        headClassName: 'w-16',
      },
      {
        id: 'what',
        header: t('facts.col.what'),
        cell: (r) => <span className="line-clamp-2 text-text">{r.what}</span>,
        asCardTitle: true,
      },
      {
        id: 'category',
        header: t('facts.col.category'),
        cell: (r) => (
          <Badge variant="outline">
            {t(`facts.category.${r.category}`, { defaultValue: r.category })}
          </Badge>
        ),
        headClassName: 'w-28',
      },
      {
        id: 'confidence',
        header: t('facts.col.confidence'),
        cell: (r) => <span className="tabular-nums text-text-dim">{r.confidence.toFixed(2)}</span>,
        headClassName: 'w-24',
        hideOnMobile: true,
      },
      {
        id: 'source',
        header: t('facts.col.source'),
        cell: (r) => <span className="text-text-dim text-xs">{r.source}</span>,
        headClassName: 'w-28',
        hideOnMobile: true,
      },
      {
        id: 'createdAt',
        header: t('facts.col.createdAt'),
        cell: (r) => <span className="text-text-dim">{formatEpoch(r.created_at)}</span>,
        headClassName: 'w-32',
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
                setConfirmOneId(r.id)
              }}
              disabled={deleteOne.isPending || bulkDelete.isPending}
              aria-label={t('facts.action.delete')}
            >
              <Trash2 className="h-3 w-3" />
              <span className="sr-only sm:not-sr-only sm:ml-1">{t('facts.action.delete')}</span>
            </Button>
          </div>
        ),
        headClassName: 'w-24',
      },
    ],
    [t, deleteOne.isPending, bulkDelete.isPending],
  )

  if (!userKey) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={<Brain />}
          title={t('noUserSelected.title')}
          description={t('noUserSelected.description')}
        />
      </div>
    )
  }

  const selectedCount = selection.size

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('facts.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('subtitle')}</p>
      </header>

      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Label htmlFor="search" className="text-xs text-text-dim">
            {t('facts.filter.search')}
          </Label>
          <Search className="pointer-events-none absolute left-2 bottom-2 h-4 w-4 text-text-muted" />
          <Input
            id="search"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            className="h-9 pl-7 mt-1"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="category" className="text-xs text-text-dim">
            {t('facts.filter.category')}
          </Label>
          <Select
            value={cat ?? '__any__'}
            onValueChange={(v) => patchParams({ cat: v === '__any__' ? null : v })}
          >
            <SelectTrigger id="category" className="h-9 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">{t('facts.filter.categoryAny')}</SelectItem>
              {CATEGORY_OPTIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(`facts.category.${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedCount > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="secondary">
              {t('facts.batch.selected', { count: selectedCount })}
            </Badge>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmBulk(true)}
              disabled={bulkDelete.isPending}
            >
              <Trash2 className="h-4 w-4" />
              {t('facts.batch.deleteSelected')}
            </Button>
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={facts}
        getRowId={(r) => String(r.id)}
        loading={isLoading}
        selection={selection}
        onSelectionChange={setSelection}
        emptyState={
          <EmptyState
            icon={<Brain />}
            title={t('facts.empty.title')}
            description={t('facts.empty.description')}
          />
        }
      />

      {(facts.length > 0 || page > 1) && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalRows={total}
          perPage={perPage}
          perPageOptions={PER_PAGE_OPTIONS}
          onPageChange={(p) => patchParams({ page: p === 1 ? null : String(p) })}
          onPerPageChange={(pp) => patchParams({ per_page: pp === DEFAULT_PER_PAGE ? null : String(pp) })}
        />
      )}

      <ConfirmDialog
        open={confirmOneId != null}
        onOpenChange={(open) => { if (!open) setConfirmOneId(null) }}
        title={t('facts.action.confirmDelete')}
        description={t('facts.action.confirmDeleteDesc')}
        intent="danger"
        confirmLabel={t('facts.action.delete')}
        onConfirm={onConfirmDeleteOne}
      />

      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={t('facts.batch.confirmDelete', { count: selectedCount })}
        description={t('facts.batch.confirmDeleteDesc')}
        intent="danger"
        confirmLabel={t('facts.batch.deleteSelected')}
        onConfirm={onConfirmBulk}
      />
    </div>
  )
}

/** Format an epoch-ms number as a short locale string. */
function formatEpoch(ms: number): string {
  try {
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return String(ms)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return String(ms)
  }
}
