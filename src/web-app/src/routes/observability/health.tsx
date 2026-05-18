/**
 * /observability/health — invocation totals + per-day breakdown.
 *
 * No chart library yet (would push bundle past budget). Instead we
 * render a CSS bar chart inline: each byDay row gets a horizontal
 * bar proportional to the max calls across the window. Cheap,
 * readable, no JS dependency.
 */

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, Loader2, RefreshCcw } from 'lucide-react'

import { EmptyState } from '@/components/common/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { useHealthSummary } from '@/hooks/use-observability'
import { cn } from '@/lib/utils'

export default function ObservabilityHealthRoute(): JSX.Element {
  const { t } = useTranslation(['observability', 'common'])
  const [params] = useSearchParams()
  const days = Math.max(1, Number(params.get('days')) || 7)

  const { data, isLoading, isFetching, refetch } = useHealthSummary(days)
  const totals = data?.totals
  const byDay = data?.byDay ?? []

  const maxCalls = useMemo(
    () => byDay.reduce((m, r) => (r.calls > m ? r.calls : m), 0),
    [byDay],
  )

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('health.title')}</h1>
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
        {data && (
          <p className="text-xs text-text-dim tabular-nums">{data.since} → {data.until}</p>
        )}
      </header>

      {isLoading ? (
        <div className="h-48 w-full rounded-md bg-surface-2 animate-pulse" />
      ) : !totals || (totals.calls === 0 && byDay.length === 0) ? (
        <EmptyState
          icon={<Activity />}
          title={t('health.empty.title')}
          description={t('health.empty.description')}
        />
      ) : (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label={t('health.kpi.calls')}        value={String(totals.calls)} tone="info" />
            <Kpi label={t('health.kpi.cost')}         value={`$${totals.cost.toFixed(4)}`} tone="info" />
            <Kpi label={t('health.kpi.errors')}       value={String(totals.errors)} tone={totals.errors > 0 ? 'danger' : 'success'} />
            <Kpi label={t('health.kpi.errorRate')}    value={`${(totals.errorRate * 100).toFixed(1)}%`} tone={totals.errorRate > 0.05 ? 'warning' : 'success'} />
            <Kpi label={t('health.kpi.avgLatencyMs')} value={`${Math.round(totals.avgLatencyMs)}ms`} tone="info" />
            <Kpi label={t('health.kpi.p95LatencyMs')} value={`${Math.round(totals.p95LatencyMs)}ms`} tone="info" />
          </div>

          {/* By-day table with inline CSS bars */}
          <div>
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-text-dim">
              {t('health.byDay')}
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">{t('health.byDayCol.date')}</TableHead>
                  <TableHead>{t('health.byDayCol.calls')}</TableHead>
                  <TableHead className="w-24">{t('health.byDayCol.cost')}</TableHead>
                  <TableHead className="w-24">{t('health.byDayCol.errors')}</TableHead>
                  <TableHead className="w-32">{t('health.byDayCol.avgLatencyMs')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byDay.map((r) => (
                  <TableRow key={r.date}>
                    <TableCell className="font-mono text-xs">{r.date}</TableCell>
                    <TableCell>
                      <CallsBar value={r.calls} max={maxCalls} />
                    </TableCell>
                    <TableCell className="tabular-nums">${r.cost.toFixed(4)}</TableCell>
                    <TableCell className="tabular-nums">
                      <span className={r.errors > 0 ? 'text-danger' : 'text-text-dim'}>{r.errors}</span>
                    </TableCell>
                    <TableCell className="tabular-nums">{Math.round(r.avgLatencyMs)}ms</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}

interface KpiProps {
  label: string
  value: string
  tone: 'info' | 'success' | 'warning' | 'danger'
}

const TONE_STYLES: Record<KpiProps['tone'], string> = {
  info:    'border-info/30    text-info',
  success: 'border-success/30 text-success',
  warning: 'border-warning/30 text-warning',
  danger:  'border-danger/30  text-danger',
}

function Kpi({ label, value, tone }: KpiProps): JSX.Element {
  return (
    <div className={cn('rounded-md border bg-surface px-3 py-2', TONE_STYLES[tone])}>
      <div className="text-xs uppercase tracking-wide text-text-dim">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

interface CallsBarProps {
  value: number
  max: number
}

/** Inline CSS bar — width proportional to max across the window. */
function CallsBar({ value, max }: CallsBarProps): JSX.Element {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-3 w-full max-w-xs overflow-hidden rounded bg-surface-2">
        <div
          className="absolute inset-y-0 left-0 bg-accent/60"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-sm text-text-dim">{value}</span>
    </div>
  )
}
