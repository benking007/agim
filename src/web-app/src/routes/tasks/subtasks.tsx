/**
 * /tasks/subtasks — flattened view of per-conversation child tasks
 * spawned by parent agents.
 *
 * Read-only: the backend doesn't expose cancel / re-run for subtasks
 * separately from the parent session. The page mirrors the columns
 * of /tasks/jobs but adds parent context (agent + platform) and
 * drops the duration / cost columns (which session.subtasks doesn't
 * track per-subtask).
 *
 * SSE: subscribes to the same `job` event as /tasks/jobs — subtask
 * status changes piggy-back on the parent job lifecycle in the
 * backend's event-bus.
 */

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, ListTree, RefreshCcw } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSubtasks, useInvalidateSubtasks } from '@/hooks/use-subtasks'
import { useEventStream, type SseStatus } from '@/hooks/use-event-stream'
import type { Subtask } from '@/types/api'
import { cn } from '@/lib/utils'

const LIVE_STATUS_CLASS: Record<SseStatus, string> = {
  connected:    'text-success',
  connecting:   'text-text-dim',
  reconnecting: 'text-warning',
  closed:       'text-text-muted',
}

export default function SubtasksRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const [params, setParams] = useSearchParams()
  const invalidate = useInvalidateSubtasks()
  const agent = params.get('agent') ?? ''

  const { data, isLoading, isFetching, refetch } = useSubtasks(
    agent ? { agent } : {},
  )
  const subtasks = data?.subtasks ?? []

  const live = useEventStream({
    job: () => invalidate(),
  })

  function setAgentFilter(v: string): void {
    const next = new URLSearchParams(params)
    if (!v) next.delete('agent')
    else next.set('agent', v)
    setParams(next, { replace: true })
  }

  const columns: DataTableColumn<Subtask>[] = useMemo(
    () => [
      {
        id: 'id',
        header: t('subtasks.col.id'),
        cell: (r) => <span className="tabular-nums text-text-dim">#{r.id}</span>,
        headClassName: 'w-16',
      },
      {
        id: 'agent',
        header: t('subtasks.col.agent'),
        cell: (r) => <span className="font-medium">{r.agent}</span>,
        headClassName: 'w-32',
      },
      {
        id: 'prompt',
        header: t('subtasks.col.prompt'),
        cell: (r) => <span className="line-clamp-2 text-text-dim">{r.prompt}</span>,
        asCardTitle: true,
      },
      {
        id: 'status',
        header: t('subtasks.col.status'),
        cell: (r) => (
          <StatusBadge status={r.status}>
            {t(`subtasks.status.${r.status}`, { defaultValue: r.status })}
          </StatusBadge>
        ),
        headClassName: 'w-32',
      },
      {
        id: 'parent',
        header: t('subtasks.col.parent'),
        cell: (r) => (
          <span className="text-text-dim">
            <span className="font-medium text-text">{r.parentAgent}</span>
            <span className="text-text-muted"> / </span>
            <span title={r.parentSessionId}>{r.parentSessionId.slice(0, 8)}</span>
          </span>
        ),
        headClassName: 'w-40',
      },
      {
        id: 'platform',
        header: t('subtasks.col.platform'),
        cell: (r) => <span className="text-text-dim">{r.platform}</span>,
        headClassName: 'w-28',
        hideOnMobile: true,
      },
      {
        id: 'createdAt',
        header: t('subtasks.col.createdAt'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.createdAt)}</span>,
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
          <h1 className="text-xl font-semibold">{t('subtasks.title')}</h1>
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
        <p className="text-sm text-text-dim">{t('subtasks.subtitle')}</p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-filter" className="text-xs text-text-dim">
            {t('subtasks.filter.agent')}
          </Label>
          <Input
            id="agent-filter"
            value={agent}
            onChange={(e) => setAgentFilter(e.target.value)}
            placeholder={t('subtasks.filter.agentAny')}
            className="h-9 w-48"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={subtasks}
        getRowId={(r) => `${r.parentSessionId}:${r.id}`}
        loading={isLoading}
        emptyState={
          <EmptyState
            icon={<ListTree />}
            title={t('subtasks.empty.title')}
            description={t('subtasks.empty.description')}
          />
        }
      />
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
