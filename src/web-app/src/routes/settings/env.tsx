/**
 * /settings/env — bulk editor for the `~/.agim/.env` file.
 *
 * Tracks per-key dirty state in a Map<string, string|null>. The
 * `null` sentinel maps the backend's "unset this key" semantic.
 * Save submits only the dirty subset so we don't churn untouched
 * lines.
 *
 * Secrets (per the backend's `secretKeys` list) are masked unless
 * the Reveal toggle is on. The toggle issues a separate
 * `?reveal=1` fetch — it doesn't show locally-cached unmasked
 * values for free since the masked fetch never received them.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Eye, EyeOff, Loader2, RefreshCcw, Save, X } from 'lucide-react'

import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEnv, useUpdateEnv } from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

export default function SettingsEnvRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])

  const [reveal, setReveal] = useState(false)
  const envQuery = useEnv({ reveal })
  const env = envQuery.data?.env ?? {}
  const secretKeys = useMemo(
    () => new Set(envQuery.data?.secretKeys ?? []),
    [envQuery.data?.secretKeys],
  )

  /** Edits keyed by env name. null sentinel = explicit unset. */
  const [edits, setEdits] = useState<Map<string, string | null>>(() => new Map())
  const [filter, setFilter] = useState('')

  const updateEnv = useUpdateEnv()

  const orderedKeys = useMemo(() => Object.keys(env).sort(), [env])
  const filteredKeys = useMemo(
    () => orderedKeys.filter((k) => k.toLowerCase().includes(filter.toLowerCase())),
    [orderedKeys, filter],
  )

  function setDraft(key: string, next: string | null): void {
    setEdits((prev) => {
      const m = new Map(prev)
      // If the new value matches the server value, drop the entry —
      // keeps the dirty count accurate after a round-trip.
      const serverVal = env[key] ?? ''
      if (next != null && next === serverVal) {
        m.delete(key)
      } else {
        m.set(key, next)
      }
      return m
    })
  }

  async function onSave(): Promise<void> {
    if (edits.size === 0) return
    const updates: Record<string, string | null> = {}
    for (const [k, v] of edits) updates[k] = v
    try {
      await updateEnv.mutateAsync({ updates })
      setEdits(new Map())
      toast.success(t('env.savedToast', { count: Object.keys(updates).length }))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  function onDiscard(): void {
    setEdits(new Map())
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('env.title')}</h1>
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
        <p className="text-sm text-text-dim">{t('env.subtitle')}</p>
      </header>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('env.search')}
          className="h-9 w-64"
        />
        <Button
          type="button"
          variant={reveal ? 'default' : 'outline'}
          size="sm"
          onClick={() => setReveal((v) => !v)}
        >
          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {t('env.reveal')}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {edits.size > 0 ? (
            <>
              <Badge variant="info">{t('env.dirtyHint', { count: edits.size })}</Badge>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onDiscard}
                disabled={updateEnv.isPending}
              >
                <X className="h-4 w-4" />
                {t('env.discard')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void onSave()}
                disabled={updateEnv.isPending}
              >
                {updateEnv.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t('env.save')}
              </Button>
            </>
          ) : (
            <span className="text-xs text-text-muted">{t('env.noChanges')}</span>
          )}
        </div>
      </div>

      {envQuery.isLoading ? (
        <div className="h-64 w-full rounded-md bg-surface-2 animate-pulse" />
      ) : orderedKeys.length === 0 ? (
        <EmptyState title={t('env.empty')} />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
          {filteredKeys.map((key) => (
            <EnvRow
              key={key}
              envKey={key}
              serverValue={env[key] ?? ''}
              draft={edits.has(key) ? edits.get(key) ?? null : env[key] ?? ''}
              isDirty={edits.has(key)}
              isSecret={secretKeys.has(key)}
              onChange={(v) => setDraft(key, v)}
              onUnset={() => setDraft(key, null)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface EnvRowProps {
  envKey: string
  serverValue: string
  /** Current displayed value — string when edited or server-side
   *  value; null when the user staged an "unset". */
  draft: string | null
  isDirty: boolean
  isSecret: boolean
  onChange: (v: string) => void
  onUnset: () => void
}

function EnvRow({
  envKey, serverValue, draft, isDirty, isSecret, onChange, onUnset,
}: EnvRowProps): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className={cn(
      'grid grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[280px_1fr_auto] sm:items-center',
      isDirty && 'bg-accent-bg/40',
    )}>
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <code className="font-mono text-xs break-all">{envKey}</code>
        {isSecret && <Badge variant="warning">{t('env.secretTag')}</Badge>}
      </div>
      {draft === null ? (
        <div className="text-sm text-text-muted italic">{t('env.unset')}</div>
      ) : (
        <Input
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 font-mono text-xs"
          placeholder={serverValue}
        />
      )}
      <div className="flex justify-end gap-1">
        {draft !== null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onUnset}
            aria-label={t('env.unsetButton')}
          >
            <X className="h-3 w-3" />
            <span className="sr-only sm:not-sr-only sm:ml-1">{t('env.unsetButton')}</span>
          </Button>
        )}
      </div>
    </div>
  )
}
