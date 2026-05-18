/**
 * /settings/service — operator-facing process control: see the
 * running agim daemon's mode/pid/uptime + start, stop, or restart it.
 *
 * Stop and restart go through ConfirmDialog because they
 * permanently interrupt every messenger adapter + in-flight job;
 * Start is one-click since it's safe to invoke even when already
 * running (backend short-circuits to alreadyRunning:true).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Play, RefreshCcw, Square, RotateCcw } from 'lucide-react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  useServiceStatus,
  useStartService,
  useStopService,
  useRestartService,
} from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import type { ServiceMode } from '@/types/api'
import { cn } from '@/lib/utils'

const MODE_VARIANT: Record<ServiceMode, 'success' | 'info' | 'warning' | 'default'> = {
  systemd:    'success',
  background: 'info',
  foreground: 'warning',
  none:       'default',
}

export default function SettingsServiceRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const status = useServiceStatus()
  const data = status.data
  const isRunning = data && data.mode !== 'none'

  const start   = useStartService()
  const stop    = useStopService()
  const restart = useRestartService()

  const [confirmStop, setConfirmStop] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)

  async function onStart(): Promise<void> {
    try {
      await start.mutateAsync()
      toast.success(t('service.toast.started'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }
  async function onConfirmStop(): Promise<void> {
    try {
      await stop.mutateAsync()
      toast.success(t('service.toast.stopped'))
    } catch (err) {
      toast.error(describeError(err, t).message)
      throw err
    }
  }
  async function onConfirmRestart(): Promise<void> {
    try {
      await restart.mutateAsync()
      toast.success(t('service.toast.restarted'))
    } catch (err) {
      toast.error(describeError(err, t).message)
      throw err
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('service.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => status.refetch()}
            disabled={status.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {status.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('service.subtitle')}</p>
      </header>

      {status.isLoading ? (
        <div className="h-48 rounded-md bg-surface-2 animate-pulse" />
      ) : data ? (
        <div className="rounded-md border border-border bg-surface p-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-dim">{t('service.modeLabel')}</dt>
            <dd>
              <Badge variant={MODE_VARIANT[data.mode]}>
                {t(`service.mode.${data.mode}`)}
              </Badge>
            </dd>
            {data.pid != null && (
              <>
                <dt className="text-text-dim">{t('service.pidLabel')}</dt>
                <dd className="tabular-nums font-mono">{data.pid}</dd>
              </>
            )}
            {data.uptime && (
              <>
                <dt className="text-text-dim">{t('service.uptimeLabel')}</dt>
                <dd className="tabular-nums">{data.uptime}</dd>
              </>
            )}
            {data.web && (
              <>
                <dt className="text-text-dim">{t('service.webLabel')}</dt>
                <dd className="font-mono text-xs">{data.web.bind}:{data.web.port}</dd>
              </>
            )}
            <dt className="text-text-dim">{t('service.bootPhaseLabel')}</dt>
            <dd>
              <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{data.bootPhase}</code>
            </dd>
          </dl>

          {/* Action buttons */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={isRunning || start.isPending}
              onClick={() => void onStart()}
            >
              {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t('service.actions.start')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!isRunning || restart.isPending}
              onClick={() => setConfirmRestart(true)}
            >
              <RotateCcw className={cn('h-4 w-4', restart.isPending && 'animate-spin')} />
              {t('service.actions.restart')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!isRunning || stop.isPending}
              onClick={() => setConfirmStop(true)}
            >
              <Square className="h-4 w-4" />
              {t('service.actions.stop')}
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={t('service.actions.confirmStop')}
        description={t('service.actions.confirmStopDesc')}
        intent="danger"
        confirmLabel={t('service.actions.stop')}
        onConfirm={onConfirmStop}
      />
      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title={t('service.actions.confirmRestart')}
        description={t('service.actions.confirmRestartDesc')}
        intent="danger"
        confirmLabel={t('service.actions.restart')}
        onConfirm={onConfirmRestart}
      />
    </div>
  )
}
