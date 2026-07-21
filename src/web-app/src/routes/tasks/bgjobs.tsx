/**
 * /tasks/bgjobs — long-running scripts via the shared Agim bgjob wrapper
 * (~/.agim/scripts/bgjob → ~/.agim/bgjobs). Read-only; the wrapper owns
 * kill/restart. Legacy Claude / opencode / Codex roots stay visible.
 *
 * Response shape: without `?root=` the API returns `{ roots, groups }`;
 * with a root filter, `{ roots: [one], jobs }`. We flatten for DataTable.
 * Detail uses GET /api/bgjobs/:id (3s poll while running).
 */

import { useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCcw, Terminal } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useBgjobDetail, useBgjobs } from '@/hooks/use-bgjobs'
import type { BgjobRoot, BgjobSummary } from '@/types/api'
import { cn } from '@/lib/utils'

const STATUS_OPTIONS = [
  'running',
  'paused',
  'completed',
  'failed',
  'killed',
  'stale',
] as const

const PRIMARY_ROOT_ID = 'agim'

export default function BgjobsRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const [params, setParams] = useSearchParams()
  const rootFilter = params.get('root') ?? null
  const statusFilter = params.get('status') ?? null

  const [selected, setSelected] = useState<{ id: string; rootId: string } | null>(null)

  const { data, isLoading, isFetching, refetch } = useBgjobs(
    rootFilter ? { root: rootFilter } : {},
  )

  const roots = data?.roots ?? []
  const allRows: BgjobSummary[] = useMemo(() => {
    if (!data) return []
    if (data.jobs) return data.jobs
    if (data.groups) return data.groups.flatMap((g) => g.jobs)
    return []
  }, [data])

  const rows = useMemo(() => {
    if (!statusFilter) return allRows
    return allRows.filter((r) => r.status.toLowerCase() === statusFilter)
  }, [allRows, statusFilter])

  const runningCount = useMemo(
    () => allRows.filter((r) => {
      const s = r.status.toLowerCase()
      return s === 'running' || s === 'paused' || s === 'starting'
    }).length,
    [allRows],
  )

  // Hide Root column when the operator already filtered to the shared Agim root.
  const showRootColumn = rootFilter !== PRIMARY_ROOT_ID

  function patchParams(patch: Record<string, string | null>): void {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') p.delete(k)
      else p.set(k, v)
    }
    setParams(p, { replace: true })
  }

  const columns: DataTableColumn<BgjobSummary>[] = useMemo(() => {
    const cols: DataTableColumn<BgjobSummary>[] = [
      {
        id: 'name',
        header: t('bgjobs.col.name'),
        cell: (r) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{r.name}</div>
            <div className="truncate font-mono text-xs text-text-muted" title={r.id}>
              {r.id}
            </div>
          </div>
        ),
        asCardTitle: true,
      },
      {
        id: 'status',
        header: t('bgjobs.col.status'),
        cell: (r) => (
          <StatusBadge status={r.status}>
            {t(`bgjobs.status.${r.status}`, { defaultValue: r.status })}
          </StatusBadge>
        ),
        headClassName: 'w-28',
      },
    ]

    if (showRootColumn) {
      cols.push({
        id: 'root',
        header: t('bgjobs.col.root'),
        cell: (r) => <RootLabel root={roots.find((rt) => rt.id === r.rootId)} fallback={r.rootId} />,
        headClassName: 'w-36',
      })
    }

    cols.push(
      {
        id: 'pid',
        header: t('bgjobs.col.pid'),
        cell: (r) => (
          <span className="tabular-nums text-text-dim">{r.pid ?? '—'}</span>
        ),
        headClassName: 'w-20',
        hideOnMobile: true,
      },
      {
        id: 'startedAt',
        header: t('bgjobs.col.startedAt'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.started_at)}</span>,
        headClassName: 'w-36',
        hideOnMobile: true,
      },
      {
        id: 'duration',
        header: t('bgjobs.col.duration'),
        cell: (r) => (
          <span className="tabular-nums text-text-dim">
            {formatDuration(r.started_at, r.ended_at)}
          </span>
        ),
        headClassName: 'w-24',
        hideOnMobile: true,
      },
      {
        id: 'exit',
        header: t('bgjobs.col.exit'),
        cell: (r) => {
          if (r.ended_at == null && (r.status === 'running' || r.status === 'paused' || r.status === 'starting')) {
            return <span className="text-text-muted">{t('bgjobs.stillRunning')}</span>
          }
          if (r.exit_code === 0) return <span className="text-success">{t('bgjobs.exitOk')}</span>
          if (r.exit_code != null) return <span className="text-danger tabular-nums">{r.exit_code}</span>
          return <span className="text-text-muted">—</span>
        },
        headClassName: 'w-20',
      },
    )

    return cols
  }, [t, roots, showRootColumn])

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('bgjobs.title')}</h1>
          {runningCount > 0 && (
            <Badge variant="info" className="normal-case tracking-normal">
              {t('bgjobs.runningCount', { count: runningCount })}
            </Badge>
          )}
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
        <p className="text-sm text-text-dim">{t('bgjobs.subtitle')}</p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-dim" htmlFor="root-filter">
            {t('bgjobs.filter.root')}
          </label>
          <Select
            value={rootFilter ?? '__any__'}
            onValueChange={(v) => patchParams({ root: v === '__any__' ? null : v })}
          >
            <SelectTrigger id="root-filter" className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">{t('bgjobs.filter.rootAny')}</SelectItem>
              {roots.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {rootOptionLabel(r, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-text-dim" htmlFor="status-filter">
            {t('bgjobs.filter.status')}
          </label>
          <Select
            value={statusFilter ?? '__any__'}
            onValueChange={(v) => patchParams({ status: v === '__any__' ? null : v })}
          >
            <SelectTrigger id="status-filter" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">{t('bgjobs.filter.statusAny')}</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`bgjobs.status.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => `${r.rootId}:${r.id}`}
        loading={isLoading}
        onRowClick={(r) => setSelected({ id: r.id, rootId: r.rootId })}
        emptyState={
          <EmptyState
            icon={<Terminal />}
            title={t('bgjobs.empty.title')}
            description={t('bgjobs.empty.description')}
          />
        }
      />

      <BgjobDetailDialog
        open={selected != null}
        onOpenChange={(open) => { if (!open) setSelected(null) }}
        jobId={selected?.id ?? null}
        rootId={selected?.rootId ?? null}
        roots={roots}
      />
    </div>
  )
}

function BgjobDetailDialog({
  open,
  onOpenChange,
  jobId,
  rootId,
  roots,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  jobId: string | null
  rootId: string | null
  roots: BgjobRoot[]
}): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const { data, isLoading, isFetching, isError } = useBgjobDetail(open ? jobId : null, rootId)
  const job = data?.job
  const root = roots.find((r) => r.id === (job?.rootId ?? rootId ?? ''))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
            <span className="truncate">{job?.name ?? jobId ?? '…'}</span>
            {job && (
              <StatusBadge status={job.status}>
                {t(`bgjobs.status.${job.status}`, { defaultValue: job.status })}
              </StatusBadge>
            )}
            {isFetching && !isLoading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" aria-hidden />
            )}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {job?.id ?? jobId}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center gap-2 py-8 text-sm text-text-dim">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('states.loading', { ns: 'common', defaultValue: 'Loading…' })}
          </div>
        )}

        {isError && !job && (
          <p className="text-sm text-danger">{t('bgjobs.detail.loadError')}</p>
        )}

        {job && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              <DetailField label={t('bgjobs.col.root')}>
                <RootLabel root={root} fallback={job.rootId} />
              </DetailField>
              <DetailField label={t('bgjobs.col.pid')}>
                <span className="tabular-nums">{job.pid ?? '—'}</span>
              </DetailField>
              <DetailField label={t('bgjobs.col.startedAt')}>
                {formatTime(job.started_at)}
              </DetailField>
              <DetailField label={t('bgjobs.col.duration')}>
                <span className="tabular-nums">{formatDuration(job.started_at, job.ended_at)}</span>
              </DetailField>
              <DetailField label={t('bgjobs.col.exit')}>
                {job.exit_code === 0
                  ? t('bgjobs.exitOk')
                  : job.exit_code != null
                    ? String(job.exit_code)
                    : '—'}
              </DetailField>
              {job.restart_generation > 1 && (
                <DetailField label={t('bgjobs.detail.restartGen')}>
                  {job.restart_generation}
                </DetailField>
              )}
              <DetailField label={t('bgjobs.detail.workdir')} className="sm:col-span-2">
                <span className="break-all font-mono text-xs">{job.workdir ?? '—'}</span>
              </DetailField>
              <DetailField label={t('bgjobs.detail.cmd')} className="sm:col-span-2">
                <code className="block whitespace-pre-wrap break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs">
                  {job.cmd.length ? job.cmd.join(' ') : '—'}
                </code>
              </DetailField>
              {job.out_dir && (
                <DetailField label={t('bgjobs.detail.outDir')} className="sm:col-span-2">
                  <span className="break-all font-mono text-xs">{job.out_dir}</span>
                </DetailField>
              )}
              {job.log_path && (
                <DetailField label={t('bgjobs.detail.logPath')} className="sm:col-span-2">
                  <span className="break-all font-mono text-xs">{job.log_path}</span>
                </DetailField>
              )}
              {job.resources && (
                <DetailField label={t('bgjobs.detail.resources')} className="sm:col-span-2">
                  <span className="tabular-nums text-text-dim">
                    {[
                      job.resources.cpu_time != null ? `cpu ${job.resources.cpu_time.toFixed(1)}s` : null,
                      job.resources.rss_kb != null ? `rss ${formatBytes(job.resources.rss_kb * 1024)}` : null,
                      job.resources.state ? `state ${job.resources.state}` : null,
                    ].filter(Boolean).join(' · ') || '—'}
                  </span>
                </DetailField>
              )}
            </dl>

            <div className="flex min-h-0 flex-col gap-1">
              <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
                {t('bgjobs.detail.logTail')}
              </div>
              <pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-text whitespace-pre-wrap break-all">
                {job.log_tail?.trim() ? job.log_tail : t('bgjobs.detail.logEmpty')}
              </pre>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailField({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-text">{children}</dd>
    </div>
  )
}

function RootLabel({
  root,
  fallback,
}: {
  root: BgjobRoot | undefined
  fallback: string
}): JSX.Element {
  const { t } = useTranslation('tasks')
  const id = root?.id ?? fallback
  const label = root?.label ?? fallback
  const legacy = id !== PRIMARY_ROOT_ID
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" title={root?.path ?? id}>
      <span className={cn('text-text-dim', !legacy && 'font-medium text-text')}>{label}</span>
      {legacy && (
        <Badge variant="outline" className="normal-case tracking-normal font-normal">
          {t('bgjobs.rootLegacy')}
        </Badge>
      )}
    </span>
  )
}

function rootOptionLabel(
  root: BgjobRoot,
  t: (key: string) => string,
): string {
  if (root.id === PRIMARY_ROOT_ID) return `${root.label} — ${t('bgjobs.rootPrimaryHint')}`
  return `${root.label} (${t('bgjobs.rootLegacy')})`
}

function formatTime(iso: string | null): string {
  if (iso == null) return '—'
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

function formatDuration(started: string | null, ended: string | null): string {
  if (!started) return '—'
  const startMs = Date.parse(started)
  if (Number.isNaN(startMs)) return '—'
  const endMs = ended ? Date.parse(ended) : Date.now()
  if (Number.isNaN(endMs) || endMs < startMs) return '—'
  const sec = Math.floor((endMs - startMs) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h${String(m).padStart(2, '0')}m`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`
}
