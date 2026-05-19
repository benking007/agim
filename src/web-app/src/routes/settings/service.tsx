/**
 * /settings/service — operator-facing process control: see the
 * running agim daemon's mode/pid/uptime + start, stop, or restart it.
 *
 * R8 (this round) added a dedicated "Ports" card at the top covering
 * webPort + acpPort. They live in `~/.agim/config.json` (PUT /api/config),
 * and take effect on the next service restart — handled by the
 * Start/Restart buttons immediately below.
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
  Loader2, Network, Play, RefreshCcw, RotateCcw, Square,
} from 'lucide-react'
import { DirtySaveBar } from '@/components/common/dirty-save-bar'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  useConfig,
  useRestartService,
  useServiceStatus,
  useStartService,
  useStopService,
  useUpdateConfig,
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

const DEFAULT_WEB_PORT = 3000
const DEFAULT_ACP_PORT = 9090

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

/* ─────────────── Ports card (webPort + acpPort) ─────────────── */

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
  const currentAcp = cfg?.acpPort

  const [webDraft, setWebDraft] = useState<string>('')
  const [acpDraft, setAcpDraft] = useState<string>('')
  // Tracks the cfg snapshot we last synced from, so post-save refetch
  // re-hydrates the drafts cleanly (and so local edits don't get
  // clobbered by background refetches).
  const [syncedAt, setSyncedAt] = useState<number>(0)

  useEffect(() => {
    if (!cfg) return
    if (cfgQuery.dataUpdatedAt === syncedAt) return
    setWebDraft(currentWeb != null ? String(currentWeb) : '')
    setAcpDraft(currentAcp != null ? String(currentAcp) : '')
    setSyncedAt(cfgQuery.dataUpdatedAt)
  }, [cfg, cfgQuery.dataUpdatedAt, currentWeb, currentAcp, syncedAt])

  const webParsed = parsePort(webDraft)
  const acpParsed = parsePort(acpDraft)
  const webInvalid = !webParsed.ok
  const acpInvalid = !acpParsed.ok

  const isDirty = useMemo(() => {
    if (!cfg) return false
    const nextWeb = webParsed.ok ? webParsed.value : undefined
    const nextAcp = acpParsed.ok ? acpParsed.value : undefined
    return nextWeb !== currentWeb || nextAcp !== currentAcp
  }, [cfg, webParsed, acpParsed, currentWeb, currentAcp])

  function onDiscard(): void {
    setWebDraft(currentWeb != null ? String(currentWeb) : '')
    setAcpDraft(currentAcp != null ? String(currentAcp) : '')
  }

  async function onSave(): Promise<void> {
    if (!cfg || webInvalid || acpInvalid) return
    try {
      await updateCfg.mutateAsync({
        ...cfg,
        webPort: webParsed.ok ? webParsed.value : undefined,
        acpPort: acpParsed.ok ? acpParsed.value : undefined,
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
        <PortField
          id="acp-port"
          label={t('service.ports.acpPort')}
          hint={t('service.ports.acpPortHint', { default: DEFAULT_ACP_PORT })}
          value={acpDraft}
          onChange={setAcpDraft}
          invalid={acpInvalid}
          placeholder={String(DEFAULT_ACP_PORT)}
        />
      </div>

      <DirtySaveBar
        dirty={isDirty}
        saving={updateCfg.isPending}
        saveDisabled={webInvalid || acpInvalid}
        onSave={() => void onSave()}
        onDiscard={onDiscard}
        // Ports use a 'warning' badge (semantically "needs restart")
        // rather than the default 'info' badge — pass a node.
        hintNode={<Badge variant="warning">{t('service.ports.restartRequired')}</Badge>}
        discardLabel={t('service.ports.discard')}
        saveLabel={t('service.ports.save')}
        savingLabel={t('service.ports.saving')}
      />
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
