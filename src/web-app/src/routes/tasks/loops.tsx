/**
 * /tasks/loops — Loop Engineering audit browser.
 *
 * Lists every persisted Loop run (history survives thread overwrite).
 * Expand a row for mission, timeline, verdict, and Subagent job ids.
 */

import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCcw,
  Repeat2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusBadge } from '@/components/common/status-badge'
import { useLoopDetail, useLoopReport, useLoopsList } from '@/hooks/use-loops'
import { cn } from '@/lib/utils'

function fmtTime(ms: number | undefined): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

export default function TasksLoopsRoute(): JSX.Element {
  const { t, i18n } = useTranslation(['tasks', 'common'])
  const lang = i18n.language?.startsWith('en') ? 'en' : 'zh'
  const [filter, setFilter] = useState('')
  const [appliedFilter, setAppliedFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'ended'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const listQuery = useLoopsList({
    status: statusFilter === 'all' ? undefined : statusFilter,
    threadId: appliedFilter || undefined,
    limit: 200,
    lang,
  })
  const rows = useMemo(() => listQuery.data?.loops ?? [], [listQuery.data])
  const detailQuery = useLoopDetail(expandedId, lang)
  const detail = detailQuery.data?.loop

  function applyFilter(): void {
    setAppliedFilter(filter.trim())
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <Repeat2 className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">{t('loops.title')}</h1>
        <Badge variant="info">{rows.length}</Badge>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
          aria-label={t('actions.refresh', { ns: 'common' })}
        >
          {listQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">{t('loops.refresh')}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">{t('loops.subtitle')}</p>

      <section className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <Label className="text-xs font-medium">{t('loops.filterLabel')}</Label>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilter() }}
            placeholder="thread-id"
            className="font-mono text-xs"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs font-medium">{t('loops.statusFilter')}</Label>
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="all">{t('loops.statusAll')}</option>
            <option value="active">{t('loops.statusActive')}</option>
            <option value="ended">{t('loops.statusEnded')}</option>
          </select>
        </div>
        <Button size="sm" onClick={applyFilter}>{t('loops.applyFilter')}</Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setFilter('')
            setAppliedFilter('')
            setStatusFilter('all')
          }}
        >
          {t('loops.clearFilter')}
        </Button>
      </section>

      {listQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-text-dim">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('states.loading', { ns: 'common' })}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">
          {appliedFilter ? t('loops.emptyFiltered') : t('loops.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t('loops.col.status')}</TableHead>
                <TableHead>{t('loops.col.objective')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('loops.col.thread')}</TableHead>
                <TableHead>{t('loops.col.round')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('loops.col.jobs')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('loops.col.report')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('loops.col.updated')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const open = expandedId === r.id
                return (
                  <Fragment key={r.id}>
                    <TableRow
                      className={cn('cursor-pointer', open && 'bg-surface-2/60')}
                      onClick={() => setExpandedId(open ? null : r.id)}
                    >
                      <TableCell>
                        {open
                          ? <ChevronDown className="h-4 w-4 text-text-muted" />
                          : <ChevronRight className="h-4 w-4 text-text-muted" />}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.active ? 'running' : 'completed'}>
                          {r.bucketLabel || r.status}
                        </StatusBadge>
                        {r.endReason ? (
                          <div className="mt-0.5 text-[11px] text-text-muted">{r.endReason}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="line-clamp-2 max-w-md font-medium">
                          {r.objective || '—'}
                        </div>
                        <div className="font-mono text-[11px] text-text-muted">{shortId(r.id)}</div>
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs text-text-dim md:table-cell">
                        {r.threadId}
                      </TableCell>
                      <TableCell className="tabular-nums text-text-dim">
                        {r.round}/{r.maxRounds}
                      </TableCell>
                      <TableCell className="hidden tabular-nums text-text-dim sm:table-cell">
                        {r.childJobCount}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {r.hasReport ? (
                          <Badge variant="success">{t('loops.hasReport', { defaultValue: '有报告' })}</Badge>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-text-dim lg:table-cell">
                        {fmtTime(r.updatedAt)}
                      </TableCell>
                    </TableRow>
                    {open ? (
                      <TableRow>
                        <TableCell colSpan={8} className="bg-surface-2/40 p-4">
                          {detailQuery.isFetching && !detail ? (
                            <div className="flex items-center gap-2 text-sm text-text-dim">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              {t('states.loading', { ns: 'common' })}
                            </div>
                          ) : detail && detail.id === r.id ? (
                            <LoopDetailPanel detail={detail} />
                          ) : (
                            <p className="text-sm text-danger">{t('loops.detailError')}</p>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function LoopDetailPanel({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof useLoopDetail>['data']>['loop']
}): JSX.Element {
  const { t } = useTranslation('tasks')
  const [showReport, setShowReport] = useState(false)
  const reportQuery = useLoopReport(detail.id, showReport && !!detail.hasReport)
  const reportMd = reportQuery.data?.markdown
  const reportPath = reportQuery.data?.path || detail.reportPaths?.[0]

  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={t('loops.detail.objective')} value={detail.objective || '—'} />
        <Field label={t('loops.detail.exit')} value={detail.exitDescription || '—'} />
        {detail.body ? <Field label={t('loops.detail.body')} value={detail.body} wide /> : null}
        <Field
          label={t('loops.detail.session')}
          value={`${detail.platform} / ${detail.channelId} / ${detail.threadId}`}
          mono
        />
        <Field
          label={t('loops.detail.jobs')}
          value={(detail.loopJobIds || []).length
            ? detail.loopJobIds.map((id) => `#${id}`).join(', ')
            : '—'}
          mono
        />
        {detail.historyPath ? (
          <Field label={t('loops.detail.path')} value={detail.historyPath} mono wide />
        ) : null}
        {(detail.reportPaths || []).length > 0 ? (
          <Field
            label={t('loops.detail.reportPath')}
            value={detail.reportPaths!.join('\n')}
            mono
            wide
          />
        ) : null}
      </div>

      {detail.hasReport ? (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('loops.detail.report')}
            </h3>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowReport((v) => !v)}
            >
              {showReport
                ? t('loops.hideReport', { defaultValue: '收起' })
                : t('loops.viewReport', { defaultValue: '查看' })}
            </Button>
          </div>
          {showReport ? (
            reportQuery.isFetching && !reportMd ? (
              <div className="flex items-center gap-2 text-text-dim">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('states.loading', { ns: 'common' })}
              </div>
            ) : reportMd ? (
              <div className="space-y-1">
                {reportPath ? (
                  <p className="font-mono text-[11px] text-text-muted">{reportPath}</p>
                ) : null}
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 text-xs leading-relaxed">
                  {reportMd}
                </pre>
              </div>
            ) : (
              <p className="text-text-muted">
                {t('loops.reportMissing', { defaultValue: '无报告文件' })}
              </p>
            )
          ) : null}
        </section>
      ) : null}

      {detail.lastVerification ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('loops.detail.verification')}
          </h3>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 font-mono text-xs">
            {`met=${detail.lastVerification.met}\n${detail.lastVerification.summary}`}
            {detail.lastVerification.gaps?.length
              ? `\ngaps: ${detail.lastVerification.gaps.join('; ')}`
              : ''}
            {detail.lastVerification.nextDirection
              ? `\nnext: ${detail.lastVerification.nextDirection}`
              : ''}
          </pre>
        </section>
      ) : null}

      {detail.endedSummary ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('loops.detail.endedSummary')}
          </h3>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 text-xs">
            {detail.endedSummary}
          </pre>
        </section>
      ) : null}

      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
          {t('loops.detail.timeline')}
        </h3>
        {(detail.timeline || []).length === 0 ? (
          <p className="text-text-muted">—</p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2">
            {[...detail.timeline].reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-2 text-xs">
                <span className="shrink-0 tabular-nums text-text-muted">{fmtTime(e.at)}</span>
                <span className="shrink-0 font-medium text-text-dim">{e.kind}</span>
                <span className="min-w-0 break-words text-text">{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Field({
  label,
  value,
  mono,
  wide,
}: {
  label: string
  value: string
  mono?: boolean
  wide?: boolean
}): JSX.Element {
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
      <div className={cn('break-words text-text', mono && 'font-mono text-xs')}>{value}</div>
    </div>
  )
}
