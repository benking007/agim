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
  'AGIM_ZHIPU_API_KEY',
])

/** Human labels + hints for env keys (lazy chunk — not in entry i18n). */
const FIELD_META_ZH: Record<string, { title: string; hint: string; placeholder?: string }> = {
  OPENAI_API_KEY: { title: 'API Key', hint: 'OpenAI 或兼容网关的密钥', placeholder: 'sk-...' },
  OPENAI_BASE_URL: { title: 'API 地址（可选）', hint: '默认 https://api.openai.com/v1', placeholder: 'https://api.openai.com/v1' },
  AGIM_OPENAI_TRANSCRIBE_MODEL: { title: '模型名（可选）', hint: '默认 whisper-1', placeholder: 'whisper-1' },
  AGIM_BAIDU_SPEECH_API_KEY: { title: 'API Key', hint: '百度智能云语音应用的 API Key' },
  AGIM_BAIDU_SPEECH_SECRET_KEY: { title: 'Secret Key', hint: '百度智能云语音应用的 Secret Key' },
  AGIM_TENCENT_SECRET_ID: { title: 'SecretId', hint: '腾讯云 API 密钥 SecretId' },
  AGIM_TENCENT_SECRET_KEY: { title: 'SecretKey', hint: '腾讯云 API 密钥 SecretKey' },
  AGIM_TENCENT_ASR_ENGINE: { title: '引擎（可选）', hint: '默认 16k_zh；英语可用 16k_en', placeholder: '16k_zh' },
  AGIM_IFLYTEK_APP_ID: { title: 'AppID', hint: '讯飞开放平台应用 AppID' },
  AGIM_IFLYTEK_API_KEY: { title: 'APIKey', hint: '讯飞开放平台 APIKey' },
  AGIM_IFLYTEK_API_SECRET: { title: 'APISecret', hint: '讯飞开放平台 APISecret' },
  AGIM_ZHIPU_API_KEY: { title: 'API Key', hint: '智谱开放平台 API Key（与 LLM 可用同一把）', placeholder: '...' },
  AGIM_ZHIPU_BASE_URL: {
    title: 'API 地址（可选）',
    hint: '默认 https://open.bigmodel.cn/api/paas/v4；国际站可用 api.z.ai',
    placeholder: 'https://open.bigmodel.cn/api/paas/v4',
  },
  AGIM_ZHIPU_TRANSCRIBE_MODEL: {
    title: '模型名（可选）',
    hint: '默认 glm-asr-2512；单段音频 ≤30 秒',
    placeholder: 'glm-asr-2512',
  },
}

const FIELD_META_EN: Record<string, { title: string; hint: string; placeholder?: string }> = {
  OPENAI_API_KEY: { title: 'API Key', hint: 'OpenAI or compatible gateway key', placeholder: 'sk-...' },
  OPENAI_BASE_URL: { title: 'Base URL (optional)', hint: 'Default https://api.openai.com/v1', placeholder: 'https://api.openai.com/v1' },
  AGIM_OPENAI_TRANSCRIBE_MODEL: { title: 'Model (optional)', hint: 'Default whisper-1', placeholder: 'whisper-1' },
  AGIM_BAIDU_SPEECH_API_KEY: { title: 'API Key', hint: 'Baidu Speech API Key' },
  AGIM_BAIDU_SPEECH_SECRET_KEY: { title: 'Secret Key', hint: 'Baidu Speech Secret Key' },
  AGIM_TENCENT_SECRET_ID: { title: 'SecretId', hint: 'Tencent Cloud SecretId' },
  AGIM_TENCENT_SECRET_KEY: { title: 'SecretKey', hint: 'Tencent Cloud SecretKey' },
  AGIM_TENCENT_ASR_ENGINE: { title: 'Engine (optional)', hint: 'Default 16k_zh; use 16k_en for English', placeholder: '16k_zh' },
  AGIM_IFLYTEK_APP_ID: { title: 'AppID', hint: 'iFlytek AppID' },
  AGIM_IFLYTEK_API_KEY: { title: 'APIKey', hint: 'iFlytek APIKey' },
  AGIM_IFLYTEK_API_SECRET: { title: 'APISecret', hint: 'iFlytek APISecret' },
  AGIM_ZHIPU_API_KEY: { title: 'API Key', hint: 'Zhipu open.bigmodel.cn API Key (can reuse LLM key)', placeholder: '...' },
  AGIM_ZHIPU_BASE_URL: {
    title: 'Base URL (optional)',
    hint: 'Default https://open.bigmodel.cn/api/paas/v4; intl: api.z.ai',
    placeholder: 'https://open.bigmodel.cn/api/paas/v4',
  },
  AGIM_ZHIPU_TRANSCRIBE_MODEL: {
    title: 'Model (optional)',
    hint: 'Default glm-asr-2512; clips ≤30s',
    placeholder: 'glm-asr-2512',
  },
}

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
          ? 'Portal 按住说话与 IM 语音共用。可配置 讯飞 / 腾讯 / 百度 / 智谱 GLM / OpenAI / whisper.cpp，并指定默认服务。密钥写入 ~/.agim/env。'
          : 'Shared by Portal hold-to-talk and IM voice. Configure iFlytek, Tencent, Baidu, Zhipu GLM, OpenAI, or whisper.cpp. Secrets go to ~/.agim/env.'}
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
            ? '由「默认转写服务」决定。选「自动」时：只要配置了任一云厂商，就优先用云服务（讯飞 → 腾讯 → 百度 → 智谱 GLM → OpenAI）；都没有才用本地 whisper.cpp 兜底。'
            : 'Set by the default below. Auto prefers any configured cloud STT (iFlytek → Tencent → Baidu → Zhipu GLM → OpenAI) over local whisper.cpp.'}
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
          <option value="">{zh ? '自动（云优先，本地兜底）' : 'Auto (cloud first, local fallback)'}</option>
          {providers.map((info) => (
            <option key={info.id} value={info.id}>
              {info.label}
              {info.id === active
                ? (zh ? ' · 使用中' : ' · in use')
                : info.configured
                  ? (zh ? ' · 已配置' : ' · configured')
                  : ''}
            </option>
          ))}
          <option value="none">{zh ? '禁用转写' : 'Disable STT'}</option>
        </select>
        <p className="text-[11px] text-text-dim">
          {zh
            ? '列表与下拉均按「当前生效 → 已配置 → 未配置」分组，组内按自动优先级（中文能力 → 稳定性 → 性价比）。'
            : 'List and dropdown: in-use → configured → missing; within each group by auto priority (Chinese quality → stability → cost).'}
        </p>
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
  const fieldMeta = zh ? FIELD_META_ZH : FIELD_META_EN
  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{info.label}</span>
        <Badge variant="outline" className="font-mono text-[10px]">{info.id}</Badge>
        {info.fallback && (
          <Badge variant="accent">{zh ? '兜底' : 'Fallback'}</Badge>
        )}
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
      {info.fallback && (
        <p className="text-[11px] text-text-dim">
          {zh
            ? '本地离线兜底。路径由主机环境配置（AGIM_WHISPERCPP_BIN / MODEL），控制台不开放修改，避免误改导致转写不可用。'
            : 'Local offline fallback. Binary/model paths are host-managed (AGIM_WHISPERCPP_BIN / MODEL) and not editable here.'}
        </p>
      )}
      {info.envKeys.length > 0 && (
      <div className="grid gap-3 sm:grid-cols-2">
        {info.envKeys.map((envKey) => {
          const secret = SECRETISH.has(envKey)
          const touched = !!keysTouched[envKey]
          const meta = fieldMeta[envKey]
          const current = info.currentValues?.[envKey]
          const placeholder = secret
            ? (zh ? '输入新密钥（留空不改）' : 'New secret (blank = keep)')
            : (current || meta?.placeholder || (zh ? '输入值' : 'Value'))
          return (
            <div key={envKey} className="space-y-1.5">
              <Label className="text-[12px] flex items-center gap-1">
                {secret && <Key className="h-3 w-3 text-text-dim" />}
                <span>{meta?.title ?? envKey}</span>
              </Label>
              <p className="font-mono text-[10px] text-text-dim">{envKey}</p>
              <div className="flex gap-2">
                <Input
                  type={secret ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={placeholder}
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
              {meta?.hint && (
                <p className="text-[11px] text-text-dim">{meta.hint}</p>
              )}
              {!secret && !touched && current && (
                <p className="text-[11px] text-text-dim">
                  {zh ? '当前生效：' : 'Active: '}
                  <span className="font-mono break-all">{current}</span>
                </p>
              )}
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}
