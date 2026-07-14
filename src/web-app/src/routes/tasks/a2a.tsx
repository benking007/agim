/**
 * /tasks/a2a — Agent ↔ Agent inline-call history.
 *
 * Splits into stats KPI cards (total / recent24h / maxDepth) +
 * recent-rows table. Subscribes to the SSE `job` event so a fresh
 * agent-to-agent call appears live.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, Loader2, RefreshCcw } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { useA2ARecent, useA2AStats, useInvalidateA2A } from '@/hooks/use-a2a'
import { useEventStream, type SseStatus } from '@/hooks/use-event-stream'
import type { A2ARow } from '@/types/api'
import { cn } from '@/lib/utils'
import { agentDisplayName } from '@/lib/agent-label'

const LIVE_STATUS_CLASS: Record<SseStatus, string> = {
  connected:    'text-success',
  connecting:   'text-text-dim',
  reconnecting: 'text-warning',
  closed:       'text-text-muted',
}

export default function A2ARoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const invalidate = useInvalidateA2A()

  const statsQuery = useA2AStats()
  const recentQuery = useA2ARecent({ limit: 50 })
  const rows = recentQuery.data?.rows ?? []
  const stats = statsQuery.data

  const live = useEventStream({
    job: () => invalidate(),
  })

  const columns: DataTableColumn<A2ARow>[] = useMemo(
    () => [
      {
        id: 'id',
        header: t('a2a.col.id'),
        cell: (r) => <span className="tabular-nums text-text-dim">#{r.id}</span>,
        headClassName: 'w-16',
      },
      {
        id: 'agent',
        header: t('a2a.col.agent'),
        cell: (r) => <span className="font-medium">{agentDisplayName(r.agent)}</span>,
        headClassName: 'w-32',
      },
      {
        id: 'parent',
        header: t('a2a.col.parent'),
        cell: (r) =>
          r.parent_id != null ? (
            <span className="tabular-nums text-text-dim">#{r.parent_id}</span>
          ) : (
            <span className="text-text-muted">—</span>
          ),
        headClassName: 'w-20',
      },
      {
        id: 'depth',
        header: t('a2a.col.depth'),
        cell: (r) => <span className="tabular-nums text-text-dim">{r.call_depth}</span>,
        headClassName: 'w-16',
        hideOnMobile: true,
      },
      {
        id: 'status',
        header: t('a2a.col.status'),
        cell: (r) => <StatusBadge status={r.status}>{r.status}</StatusBadge>,
        headClassName: 'w-28',
      },
      {
        id: 'prompt',
        header: t('a2a.col.prompt'),
        cell: (r) => (
          <span className="line-clamp-2 text-text-dim">{r.prompt ?? '—'}</span>
        ),
        asCardTitle: true,
      },
      {
        id: 'createdAt',
        header: t('a2a.col.createdAt'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.created_at)}</span>,
        headClassName: 'w-40',
        hideOnMobile: true,
      },
    ],
    [t],
  )

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('a2a.title')}</h1>
          <span className={cn('text-xs font-medium tabular-nums', LIVE_STATUS_CLASS[live])}>
            {t(`jobs.live.${live}`)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              void recentQuery.refetch()
              void statsQuery.refetch()
            }}
            disabled={recentQuery.isFetching || statsQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {recentQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('a2a.subtitle')}</p>
      </header>

      {stats && (
        <div className="grid grid-cols-3 gap-2">
          <StatCard label={t('a2a.stats.total')}     value={stats.total}     tone="info" />
          <StatCard label={t('a2a.stats.recent24h')} value={stats.recent24h} tone="success" />
          <StatCard label={t('a2a.stats.maxDepth')}  value={stats.maxDepth}  tone="warning" />
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={recentQuery.isLoading}
        emptyState={
          <EmptyState
            icon={<GitBranch />}
            title={t('a2a.empty.title')}
            description={t('a2a.empty.description')}
          />
        }
      />
    </div>
  )
}

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
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
