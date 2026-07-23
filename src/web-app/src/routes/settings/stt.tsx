/**
 * /settings/stt — speech-to-text providers + default selection.
 *
 * Copy lives in this lazy chunk (defaultValues) so settings.json
 * eager i18n does not inflate the SPA entry budget.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CheckCircle2, Key, Loader2, Mic, RefreshCcw, Save, X, XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { client } from '@/lib/api/client'
import { useEnv, useUpdateEnv } from '@/hooks/use-settings'
import type { SttProviderInfo, SttProvidersResponse } from '@/types/api'

interface Draft {
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

function useSttProviders() {
  return useQuery<SttProvidersResponse>({
    queryKey: ['settings', 'stt', 'providers'],
    queryFn: () => client.get<SttProvidersResponse>('/api/stt/providers'),
  })
}

export default function SettingsSttRoute(): JSX.Element {
  const { i18n } = useTranslation(['settings', 'common'])
  const zh = i18n.language?.startsWith('zh')
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
      toast.success(zh ? '已保存。下一次转写即生效。' : 'Saved. Applies on next transcription.')
      setDraft((d) => ({ ...d, keys: {}, keysTouched: {} }))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{zh ? '语音转写' : 'Speech-to-text'}</h1>
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
          <span className="hidden sm:inline">{zh ? '刷新' : 'Refresh'}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">
        {zh
          ? 'Portal 按住说话与 IM 语音共用。可配置 OpenAI / 百度 / 腾讯 / 讯飞 / whisper.cpp，并指定默认服务。密钥写入 ~/.agim/env。'
          : 'Shared by Portal hold-to-talk and IM voice. Configure OpenAI, Baidu, Tencent, iFlytek, or whisper.cpp. Secrets go to ~/.agim/env.'}
      </p>

      <section className="rounded-md border border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Mic className="h-4 w-4 text-text-dim" />
          <span className="text-text-dim">{zh ? '当前生效：' : 'Active:'}</span>
          <span className="font-mono text-xs">{active}</span>
          {active !== 'none' ? (
            <Badge variant="success">{zh ? '已就绪' : 'Ready'}</Badge>
          ) : (
            <Badge variant="outline">{zh ? '未配置' : 'Not configured'}</Badge>
          )}
        </div>
        <p className="mt-1 text-[11px] text-text-dim">
          {zh
            ? '由 AGIM_TRANSCRIBE_PROVIDER 决定；留空则自动选第一个已配置项。'
            : 'Set by AGIM_TRANSCRIBE_PROVIDER; empty = auto-pick first configured.'}
        </p>
      </section>

      <section className="rounded-md border border-border bg-surface p-4 space-y-3">
        <Label htmlFor="stt-default">{zh ? '默认转写服务' : 'Default STT provider'}</Label>
        <select
          id="stt-default"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          value={draft.provider}
          onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value }))}
        >
          <option value="">{zh ? '自动（按可用密钥选择）' : 'Auto (first configured)'}</option>
          <option value="openai">OpenAI Whisper</option>
          <option value="baidu">{zh ? '百度短语音识别' : 'Baidu short ASR'}</option>
          <option value="tencent">{zh ? '腾讯云一句话识别' : 'Tencent SentenceRecognition'}</option>
          <option value="iflytek">{zh ? '讯飞语音听写' : 'iFlytek dictation'}</option>
          <option value="whispercpp">whisper.cpp</option>
          <option value="none">{zh ? '禁用转写' : 'Disable STT'}</option>
        </select>
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
              zh={!!zh}
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
          <Badge variant="info">{zh ? '有未保存改动' : 'Unsaved changes'}</Badge>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setDraft(initial)}
            disabled={updateEnv.isPending}
          >
            <X className="h-4 w-4" /> {zh ? '放弃' : 'Discard'}
          </Button>
          <Button size="sm" onClick={() => void onSave()} disabled={updateEnv.isPending}>
            {updateEnv.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Save className="h-4 w-4" />}
            {zh ? '保存' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  )
}

function ProviderCard(props: {
  info: SttProviderInfo
  active: boolean
  zh: boolean
  draftKeys: Record<string, string>
  keysTouched: Record<string, boolean>
  onSetKey: (envKey: string, value: string) => void
  onClearKey: (envKey: string) => void
}): JSX.Element {
  const { info, active, zh, draftKeys, keysTouched, onSetKey, onClearKey } = props
  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{info.label}</span>
        <Badge variant="outline" className="font-mono text-[10px]">{info.id}</Badge>
        {info.configured || active ? (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="h-3 w-3" /> {zh ? '已配置' : 'Configured'}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-text-dim">
            <XCircle className="h-3 w-3" /> {zh ? '未配置' : 'Missing'}
          </Badge>
        )}
        {active && <Badge variant="info">{zh ? '使用中' : 'In use'}</Badge>}
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
                  placeholder={secret
                    ? (zh ? '输入新密钥（留空不改）' : 'New secret (blank = keep)')
                    : (zh ? '输入值' : 'Value')}
                  value={draftKeys[envKey] ?? ''}
                  onChange={(e) => onSetKey(envKey, e.target.value)}
                />
                {touched && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onClearKey(envKey)}
                    title={zh ? '清空' : 'Clear'}
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
