/**
 * /settings/stt — speech-to-text providers + default selection.
 *
 * Mirrors the search-settings pattern: secrets / paths go through
 * PUT /api/env; AGIM_TRANSCRIBE_PROVIDER picks the default backend.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  CheckCircle2, Key, Loader2, Mic, RefreshCcw, Save, X, XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useEnv, useSttProviders, useUpdateEnv } from '@/hooks/use-settings'
import type { SttProviderInfo } from '@/types/api'

interface Draft {
  /** AGIM_TRANSCRIBE_PROVIDER value (or '' for auto). */
  provider: string
  keys: Record<string, string>
  keysTouched: Record<string, boolean>
}

const SECRETISH = new Set([
  'OPENAI_API_KEY',
  'AGIM_BAIDU_SPEECH_API_KEY',
  'AGIM_BAIDU_SPEECH_SECRET_KEY',
  'AGIM_TENCENT_SECRET_ID',
  'AGIM_TENCENT_SECRET_KEY',
  'AGIM_IFLYTEK_API_KEY',
  'AGIM_IFLYTEK_API_SECRET',
])

export default function SettingsSttRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const envQuery = useEnv({ reveal: false })
  const providersQuery = useSttProviders()
  const updateEnv = useUpdateEnv()

  const envData = envQuery.data?.env ?? {}
  const providers = providersQuery.data?.providers ?? []
  const active = providersQuery.data?.active ?? 'none'

  const initial = useMemo<Draft>(() => ({
    provider: (envData.AGIM_TRANSCRIBE_PROVIDER ?? '').trim(),
    keys: {},
    keysTouched: {},
  }), [envData.AGIM_TRANSCRIBE_PROVIDER])

  const [draft, setDraft] = useState<Draft>(initial)
  const [syncedHash, setSyncedHash] = useState('')

  useEffect(() => {
    const hash = JSON.stringify(initial)
    if (hash !== syncedHash) {
      setDraft(initial)
      setSyncedHash(hash)
    }
  }, [initial, syncedHash])

  const isDirty =
    draft.provider !== initial.provider
    || Object.keys(draft.keysTouched).length > 0

  function setKey(envKey: string, value: string): void {
    setDraft((d) => ({
      ...d,
      keys: { ...d.keys, [envKey]: value },
      keysTouched: { ...d.keysTouched, [envKey]: true },
    }))
  }

  function clearKey(envKey: string): void {
    setDraft((d) => ({
      ...d,
      keys: { ...d.keys, [envKey]: '' },
      keysTouched: { ...d.keysTouched, [envKey]: true },
    }))
  }

  async function onSave(): Promise<void> {
    const updates: Record<string, string | null> = {}
    if (draft.provider !== initial.provider) {
      updates.AGIM_TRANSCRIBE_PROVIDER = draft.provider.trim() === '' ? null : draft.provider.trim()
    }
    for (const [envKey, touched] of Object.entries(draft.keysTouched)) {
      if (!touched) continue
      const v = draft.keys[envKey] ?? ''
      updates[envKey] = v.trim() === '' ? null : v
    }
    if (Object.keys(updates).length === 0) return
    try {
      await updateEnv.mutateAsync({ updates })
      void providersQuery.refetch()
      toast.success(t('stt.savedToast'))
      setDraft((d) => ({ ...d, keys: {}, keysTouched: {} }))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('stt.title')}</h1>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            void envQuery.refetch()
            void providersQuery.refetch()
          }}
          disabled={envQuery.isFetching || providersQuery.isFetching}
        >
          {envQuery.isFetching || providersQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">{t('stt.refresh')}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">{t('stt.subtitle')}</p>

      <section className="rounded-md border border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Mic className="h-4 w-4 text-text-dim" />
          <span className="text-text-dim">{t('stt.activeLabel')}</span>
          <span className="font-mono text-xs">{active}</span>
          {active !== 'none' ? (
            <Badge variant="success">{t('stt.activeOk')}</Badge>
          ) : (
            <Badge variant="outline">{t('stt.activeNone')}</Badge>
          )}
        </div>
        <p className="mt-1 text-[11px] text-text-dim">{t('stt.activeHint')}</p>
      </section>

      <section className="rounded-md border border-border bg-surface p-4 space-y-3">
        <Label htmlFor="stt-default">{t('stt.defaultLabel')}</Label>
        <select
          id="stt-default"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          value={draft.provider}
          onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value }))}
        >
          <option value="">{t('stt.defaultAuto')}</option>
          <option value="openai">OpenAI Whisper</option>
          <option value="baidu">{t('stt.providers.baidu')}</option>
          <option value="tencent">{t('stt.providers.tencent')}</option>
          <option value="iflytek">{t('stt.providers.iflytek')}</option>
          <option value="whispercpp">whisper.cpp</option>
          <option value="none">{t('stt.defaultNone')}</option>
        </select>
        <p className="text-[11px] text-text-dim">{t('stt.defaultHint')}</p>
      </section>

      {envQuery.isLoading || providersQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <section className="flex flex-col gap-3">
          {providers.map((info) => (
            <ProviderCard
              key={info.id}
              info={info}
              active={active === info.id}
              draftKeys={draft.keys}
              keysTouched={draft.keysTouched}
              onSetKey={setKey}
              onClearKey={clearKey}
            />
          ))}
        </section>
      )}

      {isDirty && (
        <div className="sticky bottom-2 flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-3 shadow">
          <Badge variant="info">{t('stt.unsaved')}</Badge>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setDraft(initial)}
            disabled={updateEnv.isPending}
          >
            <X className="h-4 w-4" /> {t('stt.discard')}
          </Button>
          <Button size="sm" onClick={() => void onSave()} disabled={updateEnv.isPending}>
            {updateEnv.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Save className="h-4 w-4" />}
            {t('stt.save')}
          </Button>
        </div>
      )}
    </div>
  )
}

function ProviderCard(props: {
  info: SttProviderInfo
  active: boolean
  draftKeys: Record<string, string>
  keysTouched: Record<string, boolean>
  onSetKey: (envKey: string, value: string) => void
  onClearKey: (envKey: string) => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  const { info, active, draftKeys, keysTouched, onSetKey, onClearKey } = props
  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{info.label}</span>
        <Badge variant="outline" className="font-mono text-[10px]">{info.id}</Badge>
        {info.configured || active ? (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="h-3 w-3" /> {t('stt.configured')}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-text-dim">
            <XCircle className="h-3 w-3" /> {t('stt.missing')}
          </Badge>
        )}
        {active && <Badge variant="info">{t('stt.inUse')}</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {info.envKeys.map((envKey) => {
          const secret = SECRETISH.has(envKey)
          const touched = !!keysTouched[envKey]
          return (
            <div key={envKey} className="space-y-1.5">
              <Label className="font-mono text-[11px] text-text-dim flex items-center gap-1">
                {secret && <Key className="h-3 w-3" />}
                {envKey}
              </Label>
              <div className="flex gap-2">
                <Input
                  type={secret ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={secret ? t('stt.keyPlaceholder') : t('stt.valuePlaceholder')}
                  value={draftKeys[envKey] ?? ''}
                  onChange={(e) => onSetKey(envKey, e.target.value)}
                />
                {touched && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onClearKey(envKey)}
                    title={t('stt.clearKey')}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
