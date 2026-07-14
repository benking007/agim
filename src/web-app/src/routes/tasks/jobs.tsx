/**
 * /tasks/jobs — the long-running agent invocations list.
 *
 * Composes every PR-8/9 primitive: DataTable + StatusBadge + Pagination
 * + ConfirmDialog + EmptyState + useEventStream. The route is a thin
 * presenter: data via useJobs (react-query), URL state via useSearchParams,
 * live refresh via the SSE `job` event invalidating the jobs query key.
 *
 * URL contract (all params optional):
 *   ?page=2&per_page=20&status=running
 *
 * Why URL state rather than zustand:
 *   * deep-link friendly ("show me failed jobs page 3")
 *   * back/forward browser history navigates filter state
 *   * no risk of a leftover filter showing wrong rows after route swap
 *
 * Mobile: the DataTable already swaps to a card view below md. The
 * stats strip wraps; the filter row stacks vertically.
 */

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Briefcase, Loader2, RefreshCcw, XCircle } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Pagination } from '@/components/common/pagination'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useJobs,
  useInvalidateJobs,
  useBatchCancelJobs,
} from '@/hooks/use-jobs'
import { useEventStream, type SseStatus } from '@/hooks/use-event-stream'
import type { Job, JobStatus, ListJobsQuery } from '@/types/api'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'
import { agentDisplayName } from '@/lib/agent-label'

const PER_PAGE_OPTIONS = [10, 20, 50, 100]
const DEFAULT_PER_PAGE = 20

const STATUS_OPTIONS: JobStatus[] = [
  'pending',
  'running',
  'completed',
  'delivered',
  'failed',
  'cancelled',
  'interrupted',
  'replaced',
  'abandoned',
]

const LIVE_STATUS_CLASS: Record<SseStatus, string> = {
  connected:    'text-success',
  connecting:   'text-text-dim',
  reconnecting: 'text-warning',
  closed:       'text-text-muted',
}

export default function JobsRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const [params, setParams] = useSearchParams()
  const invalidateJobs = useInvalidateJobs()

  // ─── URL state ───
  const page     = Math.max(1, Number(params.get('page'))     || 1)
  const perPage  = Number(params.get('per_page')) || DEFAULT_PER_PAGE
  const status   = (params.get('status') as JobStatus | null) ?? null

  const query: ListJobsQuery = useMemo(
    () => ({
      limit:  perPage,
      offset: (page - 1) * perPage,
      ...(status ? { status } : {}),
    }),
    [page, perPage, status],
  )

  const { data, isLoading, isFetching, refetch } = useJobs(query)
  const jobs = data?.jobs ?? []
  const stats = data?.stats

  // ─── Live refresh via SSE ───
  const live = useEventStream({
    job: () => invalidateJobs(),
  })

  // ─── Selection ───
  const [selection, setSelection] = useState<Set<string>>(new Set())

  // ─── Confirm dialog ───
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false)
  const batchCancel = useBatchCancelJobs()

  async function onConfirmBatchCancel(): Promise<void> {
    const ids = Array.from(selection).map(Number).filter(Number.isFinite)
    if (ids.length === 0) return
    try {
      await batchCancel.mutateAsync({ ids })
      setSelection(new Set())
      toast.success(t('states.saved', { ns: 'common' }))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
      throw err  // keep dialog open
    }
  }

  // ─── URL writers (single source of truth for filter state) ───
  function patchParams(patch: Record<string, string | null>): void {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    // Any filter change implicitly resets to page 1.
    if (Object.keys(patch).some((k) => k !== 'page')) next.delete('page')
    setParams(next, { replace: false })
  }

  // ─── Derived ───
  // The backend doesn't ship a true total-count field. Until it does
  // we infer pagination from the page itself: if a page returns a
  // full page, assume there's at least one more; otherwise this is
  // the last one. Stats give an exact total of pending/running but
  // not "all kinds", so the page label stays "Page X of N" with N
  // derived conservatively.
  const totalRows = stats
    ? (stats.pending + stats.running + stats.completed + stats.failed + (stats.delivered ?? 0))
    : undefined
  const totalPages = totalRows
    ? Math.max(1, Math.ceil(totalRows / perPage))
    : jobs.length === perPage ? page + 1 : page

  // ─── Columns ───
  const columns: DataTableColumn<Job>[] = useMemo(
    () => [
      {
        id: 'id',
        header: t('jobs.col.id'),
        cell: (r) => <span className="tabular-nums text-text-dim">#{r.id}</span>,
        headClassName: 'w-16',
        hideOnMobile: false,
      },
      {
        id: 'agent',
        header: t('jobs.col.agent'),
        cell: (r) => <span className="font-medium">{agentDisplayName(r.agent)}</span>,
        headClassName: 'w-32',
      },
      {
        id: 'prompt',
        header: t('jobs.col.prompt'),
        cell: (r) => (
          <span className="line-clamp-2 text-text-dim">{r.prompt}</span>
        ),
        asCardTitle: true,
      },
      {
        id: 'status',
        header: t('jobs.col.status'),
        cell: (r) => (
          <StatusBadge status={r.status}>
            {t(`jobs.status.${r.status}`, { defaultValue: r.status })}
          </StatusBadge>
        ),
        headClassName: 'w-32',
      },
      {
        id: 'createdAt',
        header: t('jobs.col.createdAt'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.created_at)}</span>,
        headClassName: 'w-40',
        hideOnMobile: true,
      },
      {
        id: 'duration',
        header: t('jobs.col.duration'),
        cell: (r) => (
          <span className="tabular-nums text-text-dim">{formatDuration(r.duration_ms)}</span>
        ),
        headClassName: 'w-24',
        hideOnMobile: true,
      },
      {
        id: 'cost',
        header: t('jobs.col.cost'),
        cell: (r) => (
          <span className="tabular-nums text-text-dim">
            {r.cost != null ? `$${r.cost.toFixed(4)}` : '—'}
          </span>
        ),
        headClassName: 'w-24',
        hideOnMobile: true,
      },
    ],
    [t],
  )

  const selectedCount = selection.size

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      {/* Page header */}
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('jobs.title')}</h1>
          <span className={cn('text-xs font-medium tabular-nums', LIVE_STATUS_CLASS[live])}>
            {t(`jobs.live.${live}`)}
          </span>
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
        <p className="text-sm text-text-dim">{t('jobs.subtitle')}</p>
      </header>

      {/* Stats KPI strip */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard label={t('jobs.stats.pending')}   value={stats.pending}   tone="info" />
          <StatCard label={t('jobs.stats.running')}   value={stats.running}   tone="warning" />
          <StatCard label={t('jobs.stats.completed')} value={stats.completed} tone="success" />
          <StatCard label={t('jobs.stats.failed')}    value={stats.failed}    tone="danger" />
        </div>
      )}

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-dim" htmlFor="status-filter">
            {t('jobs.filter.status')}
          </label>
          <Select
            value={status ?? '__any__'}
            onValueChange={(v) => patchParams({ status: v === '__any__' ? null : v })}
          >
            <SelectTrigger id="status-filter" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">{t('jobs.filter.statusAny')}</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`jobs.status.${s}`, { defaultValue: s })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Bulk action bar — appears when rows are selected. */}
        {selectedCount > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="secondary">
              {t('jobs.batch.selected', { count: selectedCount })}
            </Badge>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmCancelOpen(true)}
              disabled={batchCancel.isPending}
            >
              <XCircle className="h-4 w-4" />
              {t('jobs.batch.cancel')}
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <DataTable
        columns={columns}
        rows={jobs}
        getRowId={(r) => String(r.id)}
        loading={isLoading}
        selection={selection}
        onSelectionChange={setSelection}
        emptyState={
          <EmptyState
            icon={<Briefcase />}
            title={t('jobs.empty.title')}
            description={t('jobs.empty.description')}
          />
        }
      />

      {/* Footer pagination */}
      {(jobs.length > 0 || page > 1) && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalRows={totalRows}
          perPage={perPage}
          perPageOptions={PER_PAGE_OPTIONS}
          onPageChange={(p) => patchParams({ page: p === 1 ? null : String(p) })}
          onPerPageChange={(pp) => patchParams({ per_page: pp === DEFAULT_PER_PAGE ? null : String(pp) })}
        />
      )}

      <ConfirmDialog
        open={confirmCancelOpen}
        onOpenChange={setConfirmCancelOpen}
        title={t('jobs.batch.confirmCancel', { count: selectedCount })}
        description={t('jobs.batch.confirmCancelDesc')}
        intent="danger"
        confirmLabel={t('jobs.batch.cancel')}
        onConfirm={onConfirmBatchCancel}
      />
    </div>
  )
}

// ─── Helpers ───

interface StatCardProps {
  label: string
  value: number
  tone: 'info' | 'success' | 'warning' | 'danger'
}

const TONE_STYLES: Record<StatCardProps['tone'], string> = {
  info:    'border-info/30    text-info',
  success: 'border-success/30 text-success',
  warning: 'border-warning/30 text-warning',
  danger:  'border-danger/30  text-danger',
}

function StatCard({ label, value, tone }: StatCardProps): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border bg-surface px-3 py-2',
        TONE_STYLES[tone],
      )}
    >
      <div className="text-xs uppercase tracking-wide text-text-dim">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m${rs}s`
}
