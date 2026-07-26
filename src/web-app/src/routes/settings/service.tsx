/**
 * /settings/service — operator-facing process control: see the
 * running agim daemon's mode/pid/uptime + start, stop, or restart it.
 *
 * The "Ports" card edits `webPort` in `~/.agim/config.json`
 * (PUT /api/config). Changes take effect on the next service restart.
 *
 * Stop and restart go through ConfirmDialog because they
 * permanently interrupt every messenger adapter + in-flight job;
 * Start is one-click since it's safe to invoke even when already
 * running (backend short-circuits to alreadyRunning:true).
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Copy, FileText, Loader2, Network, Play, RefreshCcw, RotateCcw, Save, Square, Terminal, X,
} from 'lucide-react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  useConfig,
  useServiceLogTail,
  useRestartService,
  useServiceStatus,
  useStartService,
  useStopService,
  useUpdateConfig,
} from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import type { ServiceMode, ServiceStatus } from '@/types/api'
import { cn } from '@/lib/utils'

const MODE_VARIANT: Record<ServiceMode, 'success' | 'info' | 'warning' | 'default'> = {
  systemd:    'success',
  background: 'info',
  foreground: 'warning',
  none:       'default',
}

const DEFAULT_WEB_PORT = 3000

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

      <PortsCard />

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

      <ServiceRecoveryCard service={data} />

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

function ServiceRecoveryCard({ service }: { service?: ServiceStatus }): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const logQuery = useServiceLogTail(120)
  const logPath = logQuery.data?.path ?? '~/.agim/agim.log'
  const isRunning = Boolean(service && service.mode !== 'none')
  const isBooting = Boolean(isRunning && service?.bootPhase && service.bootPhase !== 'ready')
  const state = !service ? 'loading' : !isRunning ? 'stopped' : isBooting ? 'booting' : 'running'
  const logExists = logQuery.data?.exists === true

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('service.recovery.toast.copied'))
    } catch {
      toast.error(t('service.recovery.toast.copyFailed'))
    }
  }

  const tailCommand = `tail -n 120 ${shellQuote(logPath)}`

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Terminal className="h-4 w-4 text-text-dim" />
          <h2 className="text-sm font-semibold">{t('service.recovery.title')}</h2>
          <Badge variant={state === 'running' ? 'success' : state === 'stopped' ? 'warning' : 'info'}>
            {t(`service.recovery.state.${state}`)}
          </Badge>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={logQuery.isFetching}
          onClick={() => void logQuery.refetch()}
        >
          <RefreshCcw className={cn('h-4 w-4', logQuery.isFetching && 'animate-spin')} />
          <span>{t('service.recovery.refreshLog')}</span>
        </Button>
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-dim">
            {state === 'running'
              ? t('service.recovery.detail.running')
              : state === 'booting'
                ? t('service.recovery.detail.booting', { phase: service?.bootPhase ?? '' })
                : state === 'stopped'
                  ? t('service.recovery.detail.stopped')
                  : t('service.recovery.detail.loading')}
          </p>

          <div className="grid gap-2">
            <RecoveryCommand
              icon={<Terminal className="h-4 w-4" />}
              label={t('service.recovery.commands.doctor')}
              command="agim doctor"
              onCopy={copy}
            />
            <RecoveryCommand
              icon={<FileText className="h-4 w-4" />}
              label={t('service.recovery.commands.status')}
              command="agim status"
              onCopy={copy}
            />
            {logExists ? (
              <RecoveryCommand
                icon={<FileText className="h-4 w-4" />}
                label={t('service.recovery.commands.tail')}
                command={tailCommand}
                onCopy={copy}
              />
            ) : (
              <RecoveryInfo
                icon={<FileText className="h-4 w-4" />}
                label={t('service.recovery.commands.tailPending')}
                detail={logQuery.isLoading
                  ? t('service.recovery.commands.tailChecking')
                  : t('service.recovery.commands.tailPendingDetail')}
              />
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-border bg-surface-2">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <FileText className="h-4 w-4 text-text-dim" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{logPath}</span>
            {logQuery.data?.truncated && (
              <Badge variant="warning">{t('service.recovery.truncated')}</Badge>
            )}
          </div>
          {logQuery.isLoading ? (
            <div className="h-40 animate-pulse" />
          ) : logQuery.isError ? (
            <p className="p-3 text-sm text-danger">{describeError(logQuery.error, t).message}</p>
          ) : !logQuery.data?.exists ? (
            <p className="p-3 text-sm text-text-dim">{t('service.recovery.logMissing')}</p>
          ) : (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-text-dim">
              {logQuery.data.content || t('service.recovery.logEmpty')}
            </pre>
          )}
        </div>
      </div>
    </section>
  )
}

function RecoveryInfo({
  icon,
  label,
  detail,
}: {
  icon: JSX.Element
  label: string
  detail: string
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
      <span className="text-text-dim" aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{label}</div>
        <p className="text-[11px] text-text-dim">{detail}</p>
      </div>
    </div>
  )
}

function RecoveryCommand({
  icon,
  label,
  command,
  onCopy,
}: {
  icon: JSX.Element
  label: string
  command: string
  onCopy: (text: string) => Promise<void>
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
      <span className="text-text-dim" aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{label}</div>
        <code className="block truncate text-[11px] text-text-dim">{command}</code>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void onCopy(command)}
        aria-label={label}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  )
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/* ─────────────── Ports card (webPort) ─────────────── */

/** Validate a port string. Empty = "use the default", which we
 *  represent on the wire as `undefined` (omitted field). Non-empty
 *  must parse to 1..65535. */
function parsePort(s: string): { ok: true; value: number | undefined } | { ok: false } {
  const trimmed = s.trim()
  if (!trimmed) return { ok: true, value: undefined }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(n) || n < 1 || n > 65535) return { ok: false }
  return { ok: true, value: n }
}

function PortsCard(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const cfgQuery = useConfig()
  const updateCfg = useUpdateConfig()

  const cfg = cfgQuery.data
  const currentWeb = cfg?.webPort

  const [webDraft, setWebDraft] = useState<string>('')
  // Tracks the cfg snapshot we last synced from, so post-save refetch
  // re-hydrates the drafts cleanly (and so local edits don't get
  // clobbered by background refetches).
  const [syncedAt, setSyncedAt] = useState<number>(0)

  useEffect(() => {
    if (!cfg) return
    if (cfgQuery.dataUpdatedAt === syncedAt) return
    setWebDraft(currentWeb != null ? String(currentWeb) : '')
    setSyncedAt(cfgQuery.dataUpdatedAt)
  }, [cfg, cfgQuery.dataUpdatedAt, currentWeb, syncedAt])

  const webParsed = parsePort(webDraft)
  const webInvalid = !webParsed.ok

  const isDirty = useMemo(() => {
    if (!cfg) return false
    const nextWeb = webParsed.ok ? webParsed.value : undefined
    return nextWeb !== currentWeb
  }, [cfg, webParsed, currentWeb])

  function onDiscard(): void {
    setWebDraft(currentWeb != null ? String(currentWeb) : '')
  }

  async function onSave(): Promise<void> {
    if (!cfg || webInvalid) return
    try {
      await updateCfg.mutateAsync({
        ...cfg,
        webPort: webParsed.ok ? webParsed.value : undefined,
      })
      toast.success(t('service.ports.toast.saved'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  if (cfgQuery.isLoading) {
    return <div className="h-32 rounded-md bg-surface-2 animate-pulse" />
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Network className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('service.ports.title')}</h2>
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('service.ports.subtitle')}</p>

      <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
        <PortField
          id="web-port"
          label={t('service.ports.webPort')}
          hint={t('service.ports.webPortHint', { default: DEFAULT_WEB_PORT })}
          value={webDraft}
          onChange={setWebDraft}
          invalid={webInvalid}
          placeholder={String(DEFAULT_WEB_PORT)}
        />
      </div>

      {isDirty && (
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Badge variant="warning">{t('service.ports.restartRequired')}</Badge>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={onDiscard}
            disabled={updateCfg.isPending}
          >
            <X className="h-4 w-4" />
            {t('service.ports.discard')}
          </Button>
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={updateCfg.isPending || webInvalid}
          >
            {updateCfg.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Save className="h-4 w-4" />}
            {updateCfg.isPending ? t('service.ports.saving') : t('service.ports.save')}
          </Button>
        </div>
      )}
    </section>
  )
}

interface PortFieldProps {
  id: string
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  invalid: boolean
  placeholder: string
}

function PortField({
  id, label, hint, value, onChange, invalid, placeholder,
}: PortFieldProps): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs font-medium">{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={65535}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid}
        className={cn('font-mono', invalid && 'border-danger focus:ring-danger')}
      />
      <p className={cn('text-[11px]', invalid ? 'text-danger' : 'text-text-dim')}>
        {invalid ? t('service.ports.invalidPort') : hint}
      </p>
    </div>
  )
}
