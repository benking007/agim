/**
 * /tasks/schedules — cron-style triggers list. Read-only; mutations
 * (create / delete / toggle) only exist via CLI today; the page
 * shows what's scheduled and when the next run lands.
 */

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CalendarClock, Loader2, RefreshCcw } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSchedules } from '@/hooks/use-schedules'
import type { Schedule } from '@/types/api'

export default function SchedulesRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const [params, setParams] = useSearchParams()
  const agent = params.get('agent') ?? ''

  const { data, isLoading, isFetching, refetch } = useSchedules(
    agent ? { agent } : {},
  )
  const schedules = data?.schedules ?? []

  function setAgentFilter(v: string): void {
    const next = new URLSearchParams(params)
    if (!v) next.delete('agent')
    else next.set('agent', v)
    setParams(next, { replace: true })
  }

  const columns: DataTableColumn<Schedule>[] = useMemo(
    () => [
      {
        id: 'id',
        header: t('schedules.col.id'),
        cell: (r) => <span className="tabular-nums text-text-dim">#{r.id}</span>,
        headClassName: 'w-16',
      },
      {
        id: 'name',
        header: t('schedules.col.name'),
        cell: (r) => <span className="font-medium">{r.name}</span>,
        asCardTitle: true,
      },
      {
        id: 'agent',
        header: t('schedules.col.agent'),
        cell: (r) => <span className="text-text-dim">{r.agent}</span>,
        headClassName: 'w-32',
      },
      {
        id: 'cron',
        header: t('schedules.col.cron'),
        cell: (r) => <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{r.cron}</code>,
        headClassName: 'w-32',
      },
      {
        id: 'prompt',
        header: t('schedules.col.prompt'),
        cell: (r) => <span className="line-clamp-2 text-text-dim">{r.prompt}</span>,
        hideOnMobile: true,
      },
      {
        id: 'enabled',
        header: t('schedules.col.enabled'),
        cell: (r) =>
          r.enabled ? (
            <Badge variant="success">{t('schedules.enabled')}</Badge>
          ) : (
            <Badge variant="outline">{t('schedules.disabled')}</Badge>
          ),
        headClassName: 'w-20',
      },
      {
        id: 'nextRun',
        header: t('schedules.col.nextRun'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.next_run)}</span>,
        headClassName: 'w-40',
      },
      {
        id: 'lastRun',
        header: t('schedules.col.lastRun'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.last_run)}</span>,
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
          <h1 className="text-xl font-semibold">{t('schedules.title')}</h1>
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
        <p className="text-sm text-text-dim">{t('schedules.subtitle')}</p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-filter" className="text-xs text-text-dim">
            {t('schedules.filter.agent')}
          </Label>
          <Input
            id="agent-filter"
            value={agent}
            onChange={(e) => setAgentFilter(e.target.value)}
            placeholder={t('schedules.filter.agentAny')}
            className="w-48"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={schedules}
        getRowId={(r) => String(r.id)}
        loading={isLoading}
        emptyState={
          <EmptyState
            icon={<CalendarClock />}
            title={t('schedules.empty.title')}
            description={t('schedules.empty.description')}
          />
        }
      />
    </div>
  )
}

function formatTime(iso: string | undefined | null): string {
  if (iso == null) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
