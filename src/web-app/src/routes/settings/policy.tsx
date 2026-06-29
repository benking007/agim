/**
 * /settings/policy — dedicated UI for the highest-frequency env
 * toggles. Each is a one-click switch (or 2-3 option select) that
 * persists to `~/.agim/.env` via PUT /api/env immediately.
 *
 * Surfaced here:
 *   * AGIM_DANGEROUSLY_SKIP_PERMISSIONS (safety)
 *   * AGIM_TIMEOUT_DEFAULT              (approval bus default)
 *   * AGIM_MEMORY_ENABLED               (memory subsystem)
 *   * AGIM_VIEWER_ENABLED               (long-message viewer)
 *   * AGIM_A2A_NOTIFY_MODE              (cross-agent notify verbosity)
 *
 * All five are still editable in /settings/env. This page exists
 * because:
 *   1. They're the ones operators flip most often
 *   2. The env editor's table doesn't communicate "this is a
 *      boolean / 2-state / 3-state value" — operators have to
 *      know the literal strings "1"/"0"/"allow"/"deny"/etc.
 *   3. Safety toggle deserves a visible warning + danger color
 */

import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, RefreshCcw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEnv, useUpdateEnv } from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

/** Treat the env value as a boolean — '1' / 'true' / 'yes' / 'on'
 *  → true; everything else → false. Matches the backend's casual
 *  truthy parsing in core/* modules. */
function envBool(v: string | undefined): boolean {
  if (v == null) return false
  const t = v.toLowerCase()
  return t === '1' || t === 'true' || t === 'yes' || t === 'on'
}

export default function SettingsPolicyRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const envQuery = useEnv()
  const updateEnv = useUpdateEnv()

  async function setValue(key: string, value: string | null): Promise<void> {
    try {
      await updateEnv.mutateAsync({ updates: { [key]: value } })
      toast.success(t('policy.savingToast'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  const env = envQuery.data?.env ?? {}
  const skipPerms     = envBool(env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS)
  const memEnabled    = envBool(env.AGIM_MEMORY_ENABLED)
  const viewerEnabled = envBool(env.AGIM_VIEWER_ENABLED)
  const timeoutAllow  = (env.AGIM_TIMEOUT_DEFAULT ?? '').toLowerCase() === 'allow'
  const a2aMode       = (env.AGIM_A2A_NOTIFY_MODE ?? 'essential').toLowerCase()

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('policy.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => envQuery.refetch()}
            disabled={envQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {envQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('policy.subtitle')}</p>
      </header>

      {envQuery.isLoading ? (
        <div className="h-96 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <div className="flex flex-col gap-3">
          <SafetyCard
            value={skipPerms}
            disabled={updateEnv.isPending}
            onChange={(v) => void setValue('AGIM_DANGEROUSLY_SKIP_PERMISSIONS', v ? '1' : '0')}
          />
          <ApprovalCard
            allowOnTimeout={timeoutAllow}
            disabled={updateEnv.isPending}
            onChange={(v) => void setValue('AGIM_TIMEOUT_DEFAULT', v)}
          />
          <ToggleCard
            sectionKey="memory"
            value={memEnabled}
            disabled={updateEnv.isPending}
            onChange={(v) => void setValue('AGIM_MEMORY_ENABLED', v ? '1' : '0')}
          />
          <ToggleCard
            sectionKey="viewer"
            value={viewerEnabled}
            disabled={updateEnv.isPending}
            onChange={(v) => void setValue('AGIM_VIEWER_ENABLED', v ? '1' : '0')}
          />
          <A2ANotifyCard
            value={a2aMode}
            disabled={updateEnv.isPending}
            onChange={(v) => void setValue('AGIM_A2A_NOTIFY_MODE', v)}
          />
        </div>
      )}
    </div>
  )
}

/* ─────────────── Cards ─────────────── */

interface SafetyCardProps {
  value: boolean
  disabled: boolean
  onChange: (v: boolean) => void
}

function SafetyCard({ value, disabled, onChange }: SafetyCardProps): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <section
      className={cn(
        'rounded-md border p-4',
        value ? 'border-danger/60 bg-danger-bg/30' : 'border-border bg-surface',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{t('policy.safety.title')}</span>
            {value && (
              <Badge variant="danger">
                <AlertTriangle className="h-3 w-3" />
                ON
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-text-dim">{t('policy.safety.description')}</p>
          {!value && (
            <p className="mt-1 text-xs text-text-muted">{t('policy.safety.tagWarn')}</p>
          )}
          <code className="mt-2 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
            {t('policy.safety.envKey')}
          </code>
        </div>
        <Toggle value={value} disabled={disabled} onChange={onChange} />
      </div>
    </section>
  )
}

interface ApprovalCardProps {
  allowOnTimeout: boolean
  disabled: boolean
  onChange: (value: 'allow' | 'deny') => void
}

function ApprovalCard({ allowOnTimeout, disabled, onChange }: ApprovalCardProps): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <div className="flex flex-col gap-2">
        <span className="font-medium text-text">{t('policy.approval.title')}</span>
        <p className="text-sm text-text-dim">{t('policy.approval.description')}</p>
        <code className="self-start rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
          {t('policy.approval.envKey')}
        </code>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            variant={!allowOnTimeout ? 'default' : 'outline'}
            size="sm"
            disabled={disabled}
            onClick={() => onChange('deny')}
          >
            {t('policy.approval.valDeny')}
          </Button>
          <Button
            type="button"
            variant={allowOnTimeout ? 'default' : 'outline'}
            size="sm"
            disabled={disabled}
            onClick={() => onChange('allow')}
          >
            {t('policy.approval.valAllow')}
          </Button>
        </div>
      </div>
    </section>
  )
}

interface ToggleCardProps {
  sectionKey: 'memory' | 'viewer'
  value: boolean
  disabled: boolean
  onChange: (v: boolean) => void
}

function ToggleCard({ sectionKey, value, disabled, onChange }: ToggleCardProps): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{t(`policy.${sectionKey}.title`)}</span>
            <Badge variant={value ? 'success' : 'outline'}>{value ? 'ON' : 'OFF'}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-dim">{t(`policy.${sectionKey}.description`)}</p>
          <code className="mt-2 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
            {t(`policy.${sectionKey}.envKey`)}
          </code>
        </div>
        <Toggle value={value} disabled={disabled} onChange={onChange} />
      </div>
    </section>
  )
}

interface A2ANotifyCardProps {
  value: string
  disabled: boolean
  onChange: (v: string) => void
}

function A2ANotifyCard({ value, disabled, onChange }: A2ANotifyCardProps): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <span className="font-medium text-text">{t('policy.a2aNotify.title')}</span>
          <p className="mt-1 text-sm text-text-dim">{t('policy.a2aNotify.description')}</p>
          <code className="mt-2 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
            {t('policy.a2aNotify.envKey')}
          </code>
        </div>
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="essential">{t('policy.a2aNotify.valEssential')}</SelectItem>
            <SelectItem value="verbose">{t('policy.a2aNotify.valVerbose')}</SelectItem>
            <SelectItem value="off">{t('policy.a2aNotify.valOff')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>
  )
}

interface ToggleProps {
  value: boolean
  disabled: boolean
  onChange: (v: boolean) => void
}

/** Thumb-style switch styled to the agim accent. Tailwind-only,
 *  no Radix dep — keeps the click feel snappy. */
function Toggle({ value, disabled, onChange }: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:cursor-not-allowed disabled:opacity-50',
        value ? 'bg-accent' : 'bg-surface-2 border border-border',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
          value ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
