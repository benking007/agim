/**
 * /tasks/bgjobs — long-running scripts launched by agent wrappers
 * via their bgjob facility. Read-only; the wrapper is the source of
 * truth for writes (kill / restart).
 *
 * Response shape: when no `?root=` filter, backend returns
 * `{ roots, groups: [{ rootId, jobs }] }`; with a root filter,
 * `{ roots: [oneRoot], jobs }`. We flatten via useMemo so the
 * DataTable consumes one flat list regardless of mode.
 *
 * No SSE: bgjob events aren't on the event-bus. We rely on the 5s
 * react-query poll set in use-bgjobs.ts.
 */

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCcw, Terminal } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useBgjobs } from '@/hooks/use-bgjobs'
import type { BgjobSummary } from '@/types/api'

export default function BgjobsRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const [params, setParams] = useSearchParams()
  const rootFilter = params.get('root') ?? null

  const { data, isLoading, isFetching, refetch } = useBgjobs(
    rootFilter ? { root: rootFilter } : {},
  )

  const roots = data?.roots ?? []
  const rows: BgjobSummary[] = useMemo(() => {
    if (!data) return []
    if (data.jobs) return data.jobs
    if (data.groups) return data.groups.flatMap((g) => g.jobs)
    return []
  }, [data])

  function setRoot(next: string | null): void {
    const p = new URLSearchParams(params)
    if (!next) p.delete('root')
    else p.set('root', next)
    setParams(p, { replace: true })
  }

  const columns: DataTableColumn<BgjobSummary>[] = useMemo(
    () => [
      {
        id: 'name',
        header: t('bgjobs.col.name'),
        cell: (r) => <span className="font-medium">{r.name}</span>,
        asCardTitle: true,
      },
      {
        id: 'status',
        header: t('bgjobs.col.status'),
        cell: (r) => <StatusBadge status={r.status}>{r.status}</StatusBadge>,
        headClassName: 'w-28',
      },
      {
        id: 'root',
        header: t('bgjobs.col.root'),
        cell: (r) => {
          const root = roots.find((rt) => rt.id === r.rootId)
          return (
            <span className="text-text-dim" title={root?.path ?? r.rootId}>
              {root?.label ?? r.rootId}
            </span>
          )
        },
        headClassName: 'w-32',
      },
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
        headClassName: 'w-40',
        hideOnMobile: true,
      },
      {
        id: 'endedAt',
        header: t('bgjobs.col.endedAt'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.ended_at)}</span>,
        headClassName: 'w-40',
        hideOnMobile: true,
      },
      {
        id: 'exit',
        header: t('bgjobs.col.exit'),
        cell: (r) => {
          if (r.ended_at == null) return <span className="text-text-muted">{t('bgjobs.stillRunning')}</span>
          if (r.exit_code === 0) return <span className="text-success">{t('bgjobs.exitOk')}</span>
          if (r.exit_code != null) return <span className="text-danger tabular-nums">{r.exit_code}</span>
          return <span className="text-text-muted">—</span>
        },
        headClassName: 'w-20',
      },
    ],
    [t, roots],
  )

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('bgjobs.title')}</h1>
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

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-text-dim" htmlFor="root-filter">
          {t('bgjobs.filter.root')}
        </label>
        <Select
          value={rootFilter ?? '__any__'}
          onValueChange={(v) => setRoot(v === '__any__' ? null : v)}
        >
          <SelectTrigger id="root-filter" className="h-9 w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any__">{t('bgjobs.filter.rootAny')}</SelectItem>
            {roots.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => `${r.rootId}:${r.id}`}
        loading={isLoading}
        emptyState={
          <EmptyState
            icon={<Terminal />}
            title={t('bgjobs.empty.title')}
            description={t('bgjobs.empty.description')}
          />
        }
      />
    </div>
  )
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
