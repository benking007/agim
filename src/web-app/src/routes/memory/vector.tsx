/**
 * /memory/vector — backend status + maintenance actions.
 *
 * Status (left): backend name + ready badge + model + dims + last
 * error.  Coverage (right): three KPI tiles (total / embedded /
 * mismatched).  Actions (bottom): test, download, backfill, clear
 * (destructive — ConfirmDialog). Recent-job strip pulls from the
 * shared in-memory tracker via the status endpoint.
 *
 * The clear action picks up the ?user= filter from the layout, so
 * clearing scoped to a single user is a one-click operation.
 */

import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CheckCircle, Download, ExternalLink, Loader2, Play, RefreshCcw, Trash2, XCircle } from 'lucide-react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  useVectorStatus,
  useTriggerVectorBackfill,
  useTriggerVectorClear,
  useTriggerVectorDownload,
  useTriggerVectorTest,
} from '@/hooks/use-vector'
import { describeError } from '@/lib/api/errors'
import type { VectorJob } from '@/types/api'
import { cn } from '@/lib/utils'

export default function MemoryVectorRoute(): JSX.Element {
  const { t } = useTranslation(['memory', 'common'])
  const [params] = useSearchParams()
  const userKey = params.get('user') ?? ''

  const statusQuery = useVectorStatus(userKey ? { user_key: userKey } : {})
  const status   = statusQuery.data?.status
  const coverage = statusQuery.data?.coverage
  const jobs     = statusQuery.data?.jobs ?? []

  const test     = useTriggerVectorTest()
  const download = useTriggerVectorDownload()
  const backfill = useTriggerVectorBackfill()
  const clear    = useTriggerVectorClear()
  const [confirmClear, setConfirmClear] = useState(false)

  async function onTest(): Promise<void> {
    try {
      const r = await test.mutateAsync()
      if (r.ok) toast.success(t('vector.actions.testOk'))
      else toast.error(t('vector.actions.testFail', { detail: r.error ?? '' }))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  async function onDownload(): Promise<void> {
    try {
      const r = await download.mutateAsync()
      toast.success(r.alreadyReady ? t('vector.actions.downloadAlreadyReady') : t('vector.actions.downloadStarted'))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  async function onBackfill(): Promise<void> {
    try {
      await backfill.mutateAsync(userKey ? { user_key: userKey } : undefined)
      toast.success(t('vector.actions.backfillStarted'))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  async function onConfirmClear(): Promise<void> {
    try {
      const r = await clear.mutateAsync(userKey ? { user_key: userKey } : undefined)
      toast.success(t('vector.actions.clearStarted', { count: r.cleared }))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
      throw err
    }
  }

  if (statusQuery.isLoading) {
    return <div className="h-48 w-full rounded-md bg-surface-2 animate-pulse" />
  }
  if (!status) {
    return (
      <EmptyState
        icon={<XCircle />}
        title={t('common:states.error')}
        description={statusQuery.error?.message ?? ''}
      />
    )
  }

  const coverageScope = userKey
    ? t('vector.coverage.scope_user', { userKey })
    : t('vector.coverage.scope_global')

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('vector.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => statusQuery.refetch()}
            disabled={statusQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {statusQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('vector.subtitle')}</p>
      </header>

      {/* Backend configuration hint — points the operator at the
          env editor where the IMHUB_MEMORY_VECTOR_* keys live
          (backend / model / openai base url + api key / batch size /
          hybrid weight). */}
      <div className="rounded-md border border-info/30 bg-info-bg/30 px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text">{t('vector.config.title')}</span>
          <Button asChild variant="ghost" size="sm" className="ml-auto">
            <Link to="/settings/env?q=IMHUB_MEMORY_VECTOR">
              <ExternalLink className="h-3 w-3" />
              {t('vector.config.editLink')}
            </Link>
          </Button>
        </div>
        <p className="mt-1 text-xs text-text-dim">{t('vector.config.hint')}</p>
        <ul className="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 text-xs font-mono text-text-dim sm:grid-cols-2">
          <li>IMHUB_MEMORY_VECTOR_BACKEND</li>
          <li>IMHUB_MEMORY_VECTOR_LOCAL_MODEL</li>
          <li>IMHUB_MEMORY_VECTOR_OPENAI_BASE_URL</li>
          <li>IMHUB_MEMORY_VECTOR_OPENAI_MODEL</li>
          <li>IMHUB_MEMORY_VECTOR_OPENAI_API_KEY</li>
          <li>IMHUB_MEMORY_VECTOR_BATCH_SIZE</li>
          <li>IMHUB_MEMORY_VECTOR_HYBRID_WEIGHT</li>
        </ul>
      </div>

      {/* Status + Coverage */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{t('vector.backendLabel')}</span>
            <Badge variant="secondary">{status.backend}</Badge>
            <Badge variant={status.ready ? 'success' : 'warning'}>
              {status.ready ? t('vector.readyTrue') : t('vector.readyFalse')}
            </Badge>
            {status.downloaded && <Badge variant="info">{t('vector.downloadedTrue')}</Badge>}
          </div>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-text-dim">{t('vector.modelLabel')}</dt>
            <dd className="font-mono text-text">{status.modelId || '—'}</dd>
            <dt className="text-text-dim">{t('vector.dimsLabel')}</dt>
            <dd className="tabular-nums text-text">{status.dims || '—'}</dd>
            {status.lastError && (
              <>
                <dt className="text-text-dim">{t('vector.lastError')}</dt>
                <dd className="text-danger text-xs break-all">{status.lastError}</dd>
              </>
            )}
          </dl>
        </div>

        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-sm font-medium">{t('vector.coverage.title')}</div>
          <div className="mt-1 text-xs text-text-dim">{coverageScope}</div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <CoverageTile label={t('vector.coverage.total')}              value={coverage?.total ?? 0}              tone="info" />
            <CoverageTile label={t('vector.coverage.withEmbedding')}      value={coverage?.withEmbedding ?? 0}      tone="success" />
            <CoverageTile label={t('vector.coverage.withDifferentModel')} value={coverage?.withDifferentModel ?? 0} tone="warning" />
          </div>
        </div>
      </div>

      {/* Maintenance actions */}
      <div className="rounded-md border border-border bg-surface p-3">
        <div className="text-sm font-medium">{t('vector.actions.title')}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onTest()}
            disabled={test.isPending}
          >
            {test.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {t('vector.actions.test')}
          </Button>
          {status.backend === 'local' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onDownload()}
              disabled={download.isPending}
            >
              {download.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {t('vector.actions.download')}
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            onClick={() => void onBackfill()}
            disabled={backfill.isPending || !status.ready}
          >
            {backfill.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {t('vector.actions.backfill')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmClear(true)}
            disabled={clear.isPending}
          >
            <Trash2 className="h-4 w-4" />
            {t('vector.actions.clear')}
          </Button>
        </div>
      </div>

      {/* Jobs strip */}
      <div className="rounded-md border border-border bg-surface p-3">
        <div className="text-sm font-medium">{t('vector.jobs.title')}</div>
        {jobs.length === 0 ? (
          <div className="mt-2 text-sm text-text-muted">{t('vector.jobs.empty')}</div>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {jobs.map((j) => <li key={j.id}><JobRow job={j} /></li>)}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t('vector.actions.confirmClear')}
        description={t('vector.actions.confirmClearDesc', { scope: coverageScope })}
        intent="danger"
        confirmLabel={t('vector.actions.clear')}
        onConfirm={onConfirmClear}
      />
    </div>
  )
}

interface CoverageTileProps {
  label: string
  value: number
  tone: 'info' | 'success' | 'warning' | 'danger'
}

const TONE_STYLES: Record<CoverageTileProps['tone'], string> = {
  info:    'border-info/30    text-info',
  success: 'border-success/30 text-success',
  warning: 'border-warning/30 text-warning',
  danger:  'border-danger/30  text-danger',
}

function CoverageTile({ label, value, tone }: CoverageTileProps): JSX.Element {
  return (
    <div className={cn('rounded-md border bg-bg px-2 py-2', TONE_STYLES[tone])}>
      <div className="text-[10px] uppercase tracking-wide text-text-dim">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function JobRow({ job }: { job: VectorJob }): JSX.Element {
  const { t } = useTranslation('memory')
  const phaseClass =
    job.phase === 'done' ? 'text-success' :
    job.phase === 'failed' ? 'text-danger' :
    'text-info'
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="outline">{job.kind}</Badge>
      <span className={cn('font-medium', phaseClass)}>
        {job.phase === 'running' && <Loader2 className="inline h-3 w-3 animate-spin" />}
        {job.phase === 'done'    && <CheckCircle className="inline h-3 w-3" />}
        {job.phase === 'failed'  && <XCircle className="inline h-3 w-3" />}
        {' '}
        {t(`vector.jobs.phase.${job.phase}`)}
      </span>
      <span className="text-text-dim">{job.message}</span>
      <span className="ml-auto text-text-muted tabular-nums">{formatEpoch(job.finishedAt ?? job.startedAt)}</span>
    </div>
  )
}

function formatEpoch(ms: number): string {
  try {
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return String(ms)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return String(ms)
  }
}
