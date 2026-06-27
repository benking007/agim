/**
 * /memory/distill — "dream distillation" control surface.
 *
 * Dream distillation buffers every chat turn into pending_distill and
 * batch-extracts facts in the background when the system is idle (or
 * once a user's oldest buffered turn passes the staleness floor). This
 * tab lets the operator:
 *
 *   - configure the extraction SOURCE + SCHEDULE (DistillConfigForm)
 *   - watch the live buffer depth + last-run telemetry (status tiles)
 *   - force a pass now ("Run now" → POST /api/memory/distill)
 *
 * Status polls every 3s (useDistillStatus) so a manual run visibly
 * drains `pendingTotal` to zero without a refresh. This view is global
 * (not per-user) — the buffer spans every user — so it ignores the
 * layout's ?user= filter.
 */

import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlarmClockCheck, Loader2, Play, RefreshCcw } from 'lucide-react'

import { DistillConfigForm } from './distill-config-form'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDistillStatus, useTriggerDistill } from '@/hooks/use-memory'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

export default function MemoryDistillRoute(): JSX.Element {
  const { t } = useTranslation(['memory', 'common'])
  const statusQuery = useDistillStatus()
  const status = statusQuery.data
  const trigger = useTriggerDistill()

  async function onRunNow(): Promise<void> {
    try {
      await trigger.mutateAsync()
      toast.success(t('distill.actions.runStarted'))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  const running = !!status?.running
  const pending = status?.pendingTotal ?? 0

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('distill.title')}</h1>
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
        <p className="text-sm text-text-dim">{t('distill.subtitle')}</p>
      </header>

      {/* Configuration */}
      <DistillConfigForm onSaved={() => void statusQuery.refetch()} />

      {/* Status + actions */}
      <div className="rounded-md border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{t('distill.status.title')}</span>
          <Badge variant={status?.enabled ? 'success' : 'secondary'}>
            {status?.enabled ? t('distill.status.enabledTrue') : t('distill.status.enabledFalse')}
          </Badge>
          {running && (
            <Badge variant="info">
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
              {t('distill.status.running')}
            </Badge>
          )}
          <div className="ml-auto">
            <Button
              variant="default"
              size="sm"
              onClick={() => void onRunNow()}
              disabled={trigger.isPending || running || !status?.enabled}
            >
              {trigger.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t('distill.actions.runNow')}
            </Button>
          </div>
        </div>

        {statusQuery.isLoading ? (
          <div className="mt-3 h-20 w-full rounded-md bg-surface-2 animate-pulse" />
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatTile label={t('distill.status.pending')}       value={pending}                       tone={pending > 0 ? 'warning' : 'success'} />
              <StatTile label={t('distill.status.lastProcessed')} value={status?.lastProcessed ?? 0}    tone="info" />
              <StatTile label={t('distill.status.lastRun')}       value={formatEpoch(status?.lastRunAt)} tone="info" />
            </div>
            {pending === 0 && (
              <p className="mt-2 flex items-center gap-1 text-xs text-text-muted">
                <AlarmClockCheck className="h-3 w-3" />
                {t('distill.status.bufferEmpty')}
              </p>
            )}
            {status?.lastError && (
              <p className="mt-2 text-xs text-danger break-all">
                {t('distill.status.lastError')}: {status.lastError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface StatTileProps {
  label: string
  value: number | string
  tone: 'info' | 'success' | 'warning' | 'danger'
}

const TONE_STYLES: Record<StatTileProps['tone'], string> = {
  info:    'border-info/30    text-info',
  success: 'border-success/30 text-success',
  warning: 'border-warning/30 text-warning',
  danger:  'border-danger/30  text-danger',
}

function StatTile({ label, value, tone }: StatTileProps): JSX.Element {
  return (
    <div className={cn('rounded-md border bg-bg px-2 py-2', TONE_STYLES[tone])}>
      <div className="text-[10px] uppercase tracking-wide text-text-dim">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function formatEpoch(ms: number | null | undefined): string {
  if (!ms) return '—'
  try {
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return String(ms)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return String(ms)
  }
}
