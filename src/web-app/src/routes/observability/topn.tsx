/**
 * /observability/topn — leaderboard grouped by a dimension, sorted
 * by a metric. Dim + metric live in URL state alongside the
 * layout's ?days= so the URL fully describes the view.
 */

import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { BarChart3, Loader2, RefreshCcw } from 'lucide-react'

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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTopN } from '@/hooks/use-observability'
import type { TopNDim, TopNMetric } from '@/types/api'

const DIMS: TopNDim[] = ['user', 'agent', 'platform', 'intent']
const METRICS: TopNMetric[] = ['cost', 'calls', 'errors', 'avg_latency']

export default function ObservabilityTopNRoute(): JSX.Element {
  const { t } = useTranslation(['observability', 'common'])
  const [params, setParams] = useSearchParams()
  const days = Math.max(1, Number(params.get('days')) || 7)
  const dim = (params.get('dim') as TopNDim | null) ?? 'agent'
  const by  = (params.get('by')  as TopNMetric | null) ?? 'cost'

  function patchParams(patch: Record<string, string | null>): void {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  const { data, isLoading, isFetching, refetch } = useTopN({ dim, by, days, limit: 20 })
  const items = data?.items ?? []

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('topn.title')}</h1>
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
      </header>

      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="dim" className="text-xs text-text-dim">{t('topn.filter.dim')}</Label>
          <Select value={dim} onValueChange={(v) => patchParams({ dim: v === 'agent' ? null : v })}>
            <SelectTrigger id="dim" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIMS.map((d) => (
                <SelectItem key={d} value={d}>{t(`topn.dim.${d}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="by" className="text-xs text-text-dim">{t('topn.filter.metric')}</Label>
          <Select value={by} onValueChange={(v) => patchParams({ by: v === 'cost' ? null : v })}>
            <SelectTrigger id="by" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRICS.map((m) => (
                <SelectItem key={m} value={m}>{t(`topn.metric.${m}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="h-48 w-full rounded-md bg-surface-2 animate-pulse" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<BarChart3 />}
          title={t('topn.empty.title')}
          description={t('topn.empty.description')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">{t('topn.col.rank')}</TableHead>
              <TableHead>{t('topn.col.key')}</TableHead>
              <TableHead className="w-24">{t('topn.col.calls')}</TableHead>
              <TableHead className="w-24">{t('topn.col.cost')}</TableHead>
              <TableHead className="w-24">{t('topn.col.errors')}</TableHead>
              <TableHead className="w-32">{t('topn.col.avgLatencyMs')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((row, i) => (
              <TableRow key={`${row.key}-${i}`}>
                <TableCell className="tabular-nums text-text-dim">{i + 1}</TableCell>
                <TableCell className="font-medium">{row.key}</TableCell>
                <TableCell className="tabular-nums">{row.calls}</TableCell>
                <TableCell className="tabular-nums">${row.cost.toFixed(4)}</TableCell>
                <TableCell className="tabular-nums">
                  <span className={row.errors > 0 ? 'text-danger' : 'text-text-dim'}>{row.errors}</span>
                </TableCell>
                <TableCell className="tabular-nums">{Math.round(row.avgLatencyMs)}ms</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
