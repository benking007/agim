/**
 * /tasks/plans — admin view of native_exit_plan_mode handshakes
 * (v1.2.133).
 *
 * Surfaces the plan_history sqlite table populated by v1.2.131's
 * exit-plan-mode dispatcher. Each row shows what plan the model
 * proposed, what outcome the user picked (approved / rejected /
 * edited / expired), how long the operator took to decide, and
 * the rejection / edit reason if any.
 *
 * Layout mirrors /tasks/asks: header with title + count + refresh +
 * optional thread filter, then a table. Each row's plan markdown
 * is collapsed by default — click to expand into a fenced markdown
 * block (no live render; that's a v1.2.134 idea once we know
 * operators actually use this surface).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2, ChevronDown, ChevronRight, ClipboardList,
  Edit3, Loader2, RefreshCcw, XCircle, Clock,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { usePlansList, type PlanHistoryRow, type PlanOutcome } from '@/hooks/use-background-tasks'

const OUTCOME_ICONS: Record<PlanOutcome, JSX.Element> = {
  approved: <CheckCircle2 className="h-3 w-3" />,
  rejected: <XCircle className="h-3 w-3" />,
  edited:   <Edit3 className="h-3 w-3" />,
  expired:  <Clock className="h-3 w-3" />,
}

const OUTCOME_VARIANT: Record<PlanOutcome, 'success' | 'warning' | 'info' | 'outline'> = {
  approved: 'success',
  rejected: 'warning',
  edited:   'info',
  expired:  'outline',
}

function fmtPending(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${(s / 60).toFixed(1)}min`
}

export default function TasksPlansRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const [filter, setFilter] = useState('')
  const [appliedFilter, setAppliedFilter] = useState('')
  const listQuery = usePlansList({ threadKey: appliedFilter || undefined, limit: 200 })

  const rows = useMemo(() => listQuery.data?.plans ?? [], [listQuery.data])

  function applyFilter(): void {
    setAppliedFilter(filter.trim())
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <ClipboardList className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">{t('plans.title')}</h1>
        <Badge variant="info">{rows.length}</Badge>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
          aria-label={t('actions.refresh', { ns: 'common' })}
        >
          {listQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">{t('plans.refresh')}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">
        {t('plans.subtitle')}
      </p>

      <section className="flex items-end gap-2 rounded-md border border-border bg-surface p-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label className="text-xs font-medium">
            {t('plans.filterLabel')}
          </Label>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilter() }}
            placeholder="tg:8754479311:default"
            className="font-mono text-xs"
          />
        </div>
        <Button size="sm" onClick={applyFilter} disabled={listQuery.isFetching}>
          {t('plans.applyFilter')}
        </Button>
        {appliedFilter && (
          <Button
            size="sm" variant="ghost"
            onClick={() => { setFilter(''); setAppliedFilter('') }}
          >
            {t('plans.clearFilter')}
          </Button>
        )}
      </section>

      {listQuery.isLoading ? (
        <div className="h-32 rounded-md bg-surface-2 animate-pulse" />
      ) : rows.length === 0 ? (
        <section className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-dim">
          {appliedFilter
            ? t('plans.emptyFiltered')
            : t('plans.empty')}
        </section>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>{t('plans.col.outcome')}</TableHead>
              <TableHead>{t('plans.col.thread')}</TableHead>
              <TableHead>{t('plans.col.resolvedAt')}</TableHead>
              <TableHead>{t('plans.col.pending')}</TableHead>
              <TableHead>{t('plans.col.detail')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => <PlanRow key={r.id} row={r} />)}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

function PlanRow({ row }: { row: PlanHistoryRow }): JSX.Element {
  const { t } = useTranslation(['tasks'])
  const [open, setOpen] = useState(false)
  return (
    <>
      <TableRow className="cursor-pointer hover:bg-surface-hover" onClick={() => setOpen((v) => !v)}>
        <TableCell className="p-1 align-top text-text-dim">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </TableCell>
        <TableCell className="align-top">
          <Badge variant={OUTCOME_VARIANT[row.outcome]}>
            {OUTCOME_ICONS[row.outcome]}
            <span className="ml-1">{t(`plans.outcome.${row.outcome}`, { defaultValue: row.outcome })}</span>
          </Badge>
        </TableCell>
        <TableCell className="align-top">
          <code className="text-[11px]">{row.threadKey}</code>
        </TableCell>
        <TableCell className="align-top text-[11px] text-text-dim">{row.resolvedAt}</TableCell>
        <TableCell className="align-top text-[11px] text-text-dim">{fmtPending(row.pendingMs)}</TableCell>
        <TableCell className="align-top text-xs">
          {row.detail
            ? <span title={row.detail}>{row.detail.slice(0, 80)}{row.detail.length > 80 ? '…' : ''}</span>
            : <span className="text-text-dim">—</span>}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={6} className="bg-surface-2 p-3">
            <div className="text-[11px] text-text-dim">
              {t('plans.planMdLabel')}
            </div>
            <pre className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-surface p-3 text-[12px]">
              {row.planMd}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
