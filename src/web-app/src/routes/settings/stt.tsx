/**
 * /settings/stt — speech-to-text providers + default selection.
 *
 * Copy lives in this lazy chunk (defaultValues) so settings.json
 * eager i18n does not inflate the SPA entry budget.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CheckCircle2, Download, Key, Loader2, Mic, RefreshCcw, Save, X, XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { client } from '@/lib/api/client'
import { useEnv, useUpdateEnv } from '@/hooks/use-settings'
import type {
  SttProviderInfo, SttProvidersResponse, SttWhisperModelInitResponse,
  WhisperModelStatus,
} from '@/types/api'

interface Draft {
  provider: string
  keys: Record<string, string>
  keysTouched: Record<string, boolean>
}

const SECRETISH = new Set([
  'AGIM_STT_OPENAI_API_KEY',
  'AGIM_STT_BAIDU_API_KEY',
  'AGIM_STT_BAIDU_SECRET_KEY',
  'AGIM_STT_TENCENT_SECRET_ID',
  'AGIM_STT_TENCENT_SECRET_KEY',
  'AGIM_STT_IFLYTEK_API_KEY',
  'AGIM_STT_IFLYTEK_API_SECRET',
  'AGIM_STT_ZHIPU_API_KEY',
  'AGIM_STT_MIMO_API_KEY',
  'AGIM_STT_STEPFUN_API_KEY',
])

/** Human labels + hints for env keys (lazy chunk — not in entry i18n). */
const FIELD_META_ZH: Record<string, { title: string; hint: string; placeholder?: string }> = {
  AGIM_STT_OPENAI_API_KEY: { title: 'API Key', hint: 'STT 专用 OpenAI/兼容网关密钥（勿复用 LLM 的 OPENAI_API_KEY）', placeholder: 'sk-...' },
  AGIM_STT_OPENAI_BASE_URL: { title: 'API 地址（可选）', hint: '默认 https://api.openai.com/v1', placeholder: 'https://api.openai.com/v1' },
  AGIM_STT_OPENAI_MODEL: { title: '模型名（可选）', hint: '默认 whisper-1', placeholder: 'whisper-1' },
  AGIM_STT_BAIDU_API_KEY: { title: 'API Key', hint: '百度智能云语音应用的 API Key' },
  AGIM_STT_BAIDU_SECRET_KEY: { title: 'Secret Key', hint: '百度智能云语音应用的 Secret Key' },
  AGIM_STT_TENCENT_SECRET_ID: { title: 'SecretId', hint: '腾讯云 API 密钥 SecretId' },
  AGIM_STT_TENCENT_SECRET_KEY: { title: 'SecretKey', hint: '腾讯云 API 密钥 SecretKey' },
  AGIM_STT_TENCENT_ENGINE: { title: '引擎（可选）', hint: '默认 16k_zh；英语可用 16k_en', placeholder: '16k_zh' },
  AGIM_STT_IFLYTEK_APP_ID: { title: 'AppID', hint: '讯飞开放平台应用 AppID' },
  AGIM_STT_IFLYTEK_API_KEY: { title: 'APIKey', hint: '讯飞开放平台 APIKey' },
  AGIM_STT_IFLYTEK_API_SECRET: { title: 'APISecret', hint: '讯飞开放平台 APISecret' },
  AGIM_STT_ZHIPU_API_KEY: { title: 'API Key', hint: 'STT 专用智谱 Key（勿复用 LLM 的 AGIM_ZHIPU_API_KEY）', placeholder: '...' },
  AGIM_STT_ZHIPU_BASE_URL: {
    title: 'API 地址（可选）',
    hint: '默认 https://open.bigmodel.cn/api/paas/v4；国际站可用 api.z.ai',
    placeholder: 'https://open.bigmodel.cn/api/paas/v4',
  },
  AGIM_STT_ZHIPU_MODEL: {
    title: '模型名（可选）',
    hint: '默认 glm-asr-2512；单段音频 ≤30 秒',
    placeholder: 'glm-asr-2512',
  },
  AGIM_STT_MIMO_API_KEY: {
    title: 'API Key',
    hint: 'STT 专用小米 MiMo Key（勿复用 LLM 的 MIMO_API_KEY）',
    placeholder: '...',
  },
  AGIM_STT_MIMO_BASE_URL: {
    title: 'API 地址（可选）',
    hint: '默认 https://api.xiaomimimo.com/v1',
    placeholder: 'https://api.xiaomimimo.com/v1',
  },
  AGIM_STT_MIMO_MODEL: {
    title: '模型名（可选）',
    hint: '默认 mimo-v2.5-asr；支持中英与多种方言',
    placeholder: 'mimo-v2.5-asr',
  },
  AGIM_STT_STEPFUN_API_KEY: {
    title: 'API Key',
    hint: 'STT 专用阶跃 Key（AGIM_STT_*；勿与 LLM 的 STEPFUN_API_KEY 混用）',
    placeholder: '...',
  },
  AGIM_STT_STEPFUN_BASE_URL: {
    title: 'API 地址（可选）',
    hint: '默认 https://api.stepfun.com/v1',
    placeholder: 'https://api.stepfun.com/v1',
  },
  AGIM_STT_STEPFUN_MODEL: {
    title: '模型名（可选）',
    hint: '默认 stepaudio-2.5-asr；性价比高、中文转写强',
    placeholder: 'stepaudio-2.5-asr',
  },
}

const FIELD_META_EN: Record<string, { title: string; hint: string; placeholder?: string }> = {
  AGIM_STT_OPENAI_API_KEY: { title: 'API Key', hint: 'STT-only OpenAI/compatible key (do not reuse LLM OPENAI_API_KEY)', placeholder: 'sk-...' },
  AGIM_STT_OPENAI_BASE_URL: { title: 'Base URL (optional)', hint: 'Default https://api.openai.com/v1', placeholder: 'https://api.openai.com/v1' },
  AGIM_STT_OPENAI_MODEL: { title: 'Model (optional)', hint: 'Default whisper-1', placeholder: 'whisper-1' },
  AGIM_STT_BAIDU_API_KEY: { title: 'API Key', hint: 'Baidu Speech API Key' },
  AGIM_STT_BAIDU_SECRET_KEY: { title: 'Secret Key', hint: 'Baidu Speech Secret Key' },
  AGIM_STT_TENCENT_SECRET_ID: { title: 'SecretId', hint: 'Tencent Cloud SecretId' },
  AGIM_STT_TENCENT_SECRET_KEY: { title: 'SecretKey', hint: 'Tencent Cloud SecretKey' },
  AGIM_STT_TENCENT_ENGINE: { title: 'Engine (optional)', hint: 'Default 16k_zh; use 16k_en for English', placeholder: '16k_zh' },
  AGIM_STT_IFLYTEK_APP_ID: { title: 'AppID', hint: 'iFlytek AppID' },
  AGIM_STT_IFLYTEK_API_KEY: { title: 'APIKey', hint: 'iFlytek APIKey' },
  AGIM_STT_IFLYTEK_API_SECRET: { title: 'APISecret', hint: 'iFlytek APISecret' },
  AGIM_STT_ZHIPU_API_KEY: { title: 'API Key', hint: 'STT-only Zhipu key (do not reuse LLM AGIM_ZHIPU_API_KEY)', placeholder: '...' },
  AGIM_STT_ZHIPU_BASE_URL: {
    title: 'Base URL (optional)',
    hint: 'Default https://open.bigmodel.cn/api/paas/v4; intl: api.z.ai',
    placeholder: 'https://open.bigmodel.cn/api/paas/v4',
  },
  AGIM_STT_ZHIPU_MODEL: {
    title: 'Model (optional)',
    hint: 'Default glm-asr-2512; clips ≤30s',
    placeholder: 'glm-asr-2512',
  },
  AGIM_STT_MIMO_API_KEY: {
    title: 'API Key',
    hint: 'STT-only Xiaomi MiMo key (do not reuse LLM MIMO_API_KEY)',
    placeholder: '...',
  },
  AGIM_STT_MIMO_BASE_URL: {
    title: 'Base URL (optional)',
    hint: 'Default https://api.xiaomimimo.com/v1',
    placeholder: 'https://api.xiaomimimo.com/v1',
  },
  AGIM_STT_MIMO_MODEL: {
    title: 'Model (optional)',
    hint: 'Default mimo-v2.5-asr; Chinese + dialects',
    placeholder: 'mimo-v2.5-asr',
  },
  AGIM_STT_STEPFUN_API_KEY: {
    title: 'API Key',
    hint: 'STT-only StepFun key (AGIM_STT_*; never reuse LLM STEPFUN_API_KEY)',
    placeholder: '...',
  },
  AGIM_STT_STEPFUN_BASE_URL: {
    title: 'Base URL (optional)',
    hint: 'Default https://api.stepfun.com/v1',
    placeholder: 'https://api.stepfun.com/v1',
  },
  AGIM_STT_STEPFUN_MODEL: {
    title: 'Model (optional)',
    hint: 'Default stepaudio-2.5-asr; strong Chinese, low cost',
    placeholder: 'stepaudio-2.5-asr',
  },
}

/**
 * Built-in catalog — always render cards even if /api/stt/providers fails
 * (404 on stale process, 403 non-admin, network blip). Live configured /
 * active flags are merged from the API when available.
 */
const STT_PROVIDER_CATALOG: SttProviderInfo[] = [
  {
    id: 'iflytek',
    label: '讯飞语音听写',
    envKeys: ['AGIM_STT_IFLYTEK_APP_ID', 'AGIM_STT_IFLYTEK_API_KEY', 'AGIM_STT_IFLYTEK_API_SECRET'],
    configured: false,
  },
  {
    id: 'tencent',
    label: '腾讯云一句话识别',
    envKeys: ['AGIM_STT_TENCENT_SECRET_ID', 'AGIM_STT_TENCENT_SECRET_KEY', 'AGIM_STT_TENCENT_ENGINE'],
    configured: false,
  },
  {
    id: 'baidu',
    label: '百度短语音识别',
    envKeys: ['AGIM_STT_BAIDU_API_KEY', 'AGIM_STT_BAIDU_SECRET_KEY'],
    configured: false,
  },
  {
    id: 'stepfun',
    label: '阶跃 StepAudio-ASR',
    envKeys: ['AGIM_STT_STEPFUN_API_KEY', 'AGIM_STT_STEPFUN_BASE_URL', 'AGIM_STT_STEPFUN_MODEL'],
    configured: false,
  },
  {
    id: 'mimo',
    label: '小米 MiMo-ASR',
    envKeys: ['AGIM_STT_MIMO_API_KEY', 'AGIM_STT_MIMO_BASE_URL', 'AGIM_STT_MIMO_MODEL'],
    configured: false,
  },
  {
    id: 'glm',
    label: '智谱 GLM-ASR',
    envKeys: ['AGIM_STT_ZHIPU_API_KEY', 'AGIM_STT_ZHIPU_BASE_URL', 'AGIM_STT_ZHIPU_MODEL'],
    configured: false,
  },
  {
    id: 'openai',
    label: 'OpenAI Whisper',
    envKeys: ['AGIM_STT_OPENAI_API_KEY', 'AGIM_STT_OPENAI_BASE_URL', 'AGIM_STT_OPENAI_MODEL'],
    configured: false,
  },
  {
    id: 'whispercpp',
    label: 'whisper.cpp（本地兜底）',
    envKeys: [],
    configured: false,
    fallback: true,
  },
]

/** Best-effort configured flags from masked /api/env (truthy = key present). */
function configuredFromEnv(id: string, env: Record<string, string>): boolean {
  const has = (...keys: string[]) => keys.every((k) => !!(env[k] && String(env[k]).trim()))
  switch (id) {
    case 'openai': return has('AGIM_STT_OPENAI_API_KEY')
    case 'baidu': return has('AGIM_STT_BAIDU_API_KEY', 'AGIM_STT_BAIDU_SECRET_KEY')
    case 'tencent': return has('AGIM_STT_TENCENT_SECRET_ID', 'AGIM_STT_TENCENT_SECRET_KEY')
    case 'iflytek': return has('AGIM_STT_IFLYTEK_APP_ID', 'AGIM_STT_IFLYTEK_API_KEY', 'AGIM_STT_IFLYTEK_API_SECRET')
    case 'glm': return has('AGIM_STT_ZHIPU_API_KEY')
    case 'mimo': return has('AGIM_STT_MIMO_API_KEY')
    case 'stepfun': return has('AGIM_STT_STEPFUN_API_KEY')
    case 'whispercpp': return false // host-only paths — SPA cannot see them
    default: return false
  }
}

function mergeProviders(
  live: SttProviderInfo[] | undefined,
  active: string,
  env: Record<string, string>,
): SttProviderInfo[] {
  const byId = new Map((live ?? []).map((p) => [p.id, p]))
  const merged = STT_PROVIDER_CATALOG.map((base) => {
    const hit = byId.get(base.id)
    if (!hit) {
      return { ...base, configured: configuredFromEnv(base.id, env) }
    }
    return {
      ...base,
      ...hit,
      label: hit.label || base.label,
      envKeys: Array.isArray(hit.envKeys) ? hit.envKeys : base.envKeys,
      configured: !!hit.configured || configuredFromEnv(base.id, env),
      currentValues: hit.currentValues,
      fallback: hit.fallback ?? base.fallback,
    }
  })
  // Keep any unexpected API-only providers at the end.
  for (const p of live ?? []) {
    if (!merged.some((m) => m.id === p.id)) merged.push(p)
  }
  // Sort: active → configured → rest, preserving catalog order within groups.
  const rank = new Map(STT_PROVIDER_CATALOG.map((p, i) => [p.id, i]))
  return [...merged].sort((a, b) => {
    const aActive = a.id === active ? 0 : 1
    const bActive = b.id === active ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    const aCfg = a.configured ? 0 : 1
    const bCfg = b.configured ? 0 : 1
    if (aCfg !== bCfg) return aCfg - bCfg
    return (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99)
  })
}

async function fetchSttProviders(): Promise<SttProvidersResponse> {
  try {
    return await client.get<SttProvidersResponse>('/api/stt/providers')
  } catch (err) {
    // Fallback: any authenticated user can read /api/chat/transcribe status,
    // which carries the same provider list (useful when admin gate / stale
    // process makes /api/stt/providers unavailable).
    try {
      const status = await client.get<SttProvidersResponse & { provider?: string }>(
        '/api/chat/transcribe',
      )
      return {
        providers: status.providers ?? [],
        active: status.active ?? status.provider ?? 'none',
        explicit: status.explicit ?? null,
      }
    } catch {
      throw err
    }
  }
}

function useSttProviders() {
  return useQuery<SttProvidersResponse>({
    queryKey: ['settings', 'stt', 'providers'],
    queryFn: fetchSttProviders,
    retry: 1,
    // Poll while the model is downloading so the card flips to "ready".
    refetchInterval: (q) => {
      const m = q.state.data?.whisperModel
      return m?.downloading || m?.binDownloading ? 2000 : false
    },
  })
}

export default function SettingsSttRoute(): JSX.Element {
  const { i18n } = useTranslation(['settings', 'common'])
  const zh = i18n.language?.startsWith('zh')
  const envQuery = useEnv({ reveal: false })
  const providersQuery = useSttProviders()
  const updateEnv = useUpdateEnv()

  const envData = envQuery.data?.env ?? {}
  const active = providersQuery.data?.active ?? 'none'
  const providers = useMemo(
    () => mergeProviders(providersQuery.data?.providers, active, envData),
    [providersQuery.data?.providers, active, envData],
  )
  const loadError = providersQuery.isError
    ? ((providersQuery.error as Error)?.message || (zh ? '加载失败' : 'Load failed'))
    : null

  const initial = useMemo<Draft>(() => ({
    provider: (envData.AGIM_STT_PROVIDER ?? '').trim(),
    keys: {},
    keysTouched: {},
  }), [envData.AGIM_STT_PROVIDER])

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
      updates.AGIM_STT_PROVIDER = draft.provider.trim() === '' ? null : draft.provider.trim()
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
          ? 'Portal 按住说话与 IM 语音共用。可配置 讯飞 / 腾讯 / 百度 / 阶跃 / 小米 MiMo / 智谱 GLM / OpenAI / whisper.cpp，并指定默认服务。密钥写入 ~/.agim/env。'
          : 'Shared by Portal hold-to-talk and IM voice. Configure iFlytek, Tencent, Baidu, StepFun, MiMo, Zhipu GLM, OpenAI, or whisper.cpp. Secrets go to ~/.agim/env.'}
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
            ? '由「默认转写服务」决定。选「自动」时：只要配置了任一云厂商，就优先用云服务（讯飞 → 腾讯 → 百度 → 阶跃 → 小米 MiMo → 智谱 GLM → OpenAI）；都没有才用本地 whisper.cpp 兜底。'
            : 'Set by the default below. Auto prefers any configured cloud STT (iFlytek → Tencent → Baidu → StepFun → MiMo → Zhipu GLM → OpenAI) over local whisper.cpp.'}
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
                  : info.id === 'whispercpp'
                    ? (zh ? ' · 内置本地（PATH / ~/.agim/whisper）' : ' · built-in local')
                    : (zh ? ' · 未配置' : ' · not configured')}
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

      {loadError && (
        <section className="rounded-md border border-warning/40 bg-warning-bg/40 px-4 py-3 text-sm text-warning">
          {zh
            ? `无法从服务器刷新转写状态（${loadError}）。仍可编辑下方配置；保存后请点「刷新」或重启 agim。`
            : `Could not refresh STT status (${loadError}). You can still edit keys below; save, then Refresh or restart agim.`}
        </section>
      )}

      {envQuery.isLoading && providersQuery.isLoading ? (
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
              whisperModel={info.id === 'whispercpp' ? providersQuery.data?.whisperModel : undefined}
              onWhisperModelChanged={() => { void providersQuery.refetch() }}
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
  whisperModel?: WhisperModelStatus
  onWhisperModelChanged?: () => void
}): JSX.Element {
  const {
    info, active, zh, draftKeys, keysTouched, onSetKey, onClearKey,
    whisperModel, onWhisperModelChanged,
  } = props
  const fieldMeta = zh ? FIELD_META_ZH : FIELD_META_EN
  const initModel = useMutation({
    // Keep this call in the lazy STT chunk (not endpoints.ts) so the SPA
    // entry bundle stays under the 350 KiB budget.
    mutationFn: () => client.post<SttWhisperModelInitResponse>('/api/stt/whispercpp/model'),
    onSuccess: (r) => {
      onWhisperModelChanged?.()
      if (r.alreadyReady) {
        toast.success(zh ? '本地引擎已就绪' : 'Local engine already ready')
      } else if (r.alreadyRunning || r.started || r.downloading || r.binDownloading) {
        toast.message(zh ? '正在安装本地引擎…' : 'Installing local engine…')
      }
    },
    onError: (e) => toast.error((e as Error).message),
  })

  // Toast once when a download we were watching finishes (or fails).
  const [wasDownloading, setWasDownloading] = useState(false)
  useEffect(() => {
    const busy = !!(whisperModel?.downloading || whisperModel?.binDownloading)
    if (busy) {
      setWasDownloading(true)
      return
    }
    if (!wasDownloading || !whisperModel) return
    setWasDownloading(false)
    if (whisperModel.ready && whisperModel.bin) {
      toast.success(zh ? '本地引擎就绪' : 'Local engine ready')
    } else if (whisperModel.binLastError || whisperModel.lastError) {
      toast.error(
        zh
          ? `安装失败：${whisperModel.binLastError || whisperModel.lastError}`
          : `Install failed: ${whisperModel.binLastError || whisperModel.lastError}`,
      )
    }
  }, [whisperModel, wasDownloading, zh])

  const runtimeBusy = !!(
    initModel.isPending
    || whisperModel?.downloading
    || whisperModel?.binDownloading
  )
  const runtimeReady = !!(whisperModel?.ready && whisperModel?.bin)

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
            ? '内置开源本地转写（whisper.cpp）。Linux/Windows 可在 agim start 或点下方「初始化本地引擎」自动安装官方 CLI + 模型到 ~/.agim/whisper/；macOS 请 brew install whisper-cpp。也可设 AGIM_STT_WHISPERCPP_BIN / MODEL。'
            : 'Built-in open-source local STT (whisper.cpp). On Linux/Windows, agim start or Initialize below auto-installs the official CLI + model under ~/.agim/whisper/; macOS: brew install whisper-cpp. Optional AGIM_STT_WHISPERCPP_BIN / MODEL.'}
        </p>
      )}
      {info.id === 'whispercpp' && (
        <div className="space-y-2 rounded-md border border-border/60 bg-background/40 px-3 py-2.5">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="text-text-dim">{zh ? 'CLI：' : 'CLI:'}</span>
              {whisperModel?.binDownloading ? (
                <Badge variant="info" className="gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {zh ? '安装中' : 'Installing'}
                </Badge>
              ) : whisperModel?.bin ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  {zh ? '已安装' : 'Installed'}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-warning">
                  <XCircle className="h-3 w-3" />
                  {whisperModel?.canAutoInstallBin
                    ? (zh ? '未安装（可自动安装）' : 'Missing (auto-install)')
                    : (zh ? '未安装（需手动）' : 'Missing (manual)')}
                </Badge>
              )}
            </div>
            <p
              className="truncate font-mono text-[10px] text-text-dim"
              title={whisperModel?.bin || whisperModel?.defaultBinPath}
            >
              {whisperModel?.bin
                || whisperModel?.defaultBinPath
                || '~/.agim/whisper/bin/whisper-cli'}
            </p>
            {!whisperModel?.bin && (
              <p className="text-[11px] text-warning">
                {whisperModel?.canAutoInstallBin
                  ? (zh
                    ? '可点下方按钮或等 agim start 静默安装官方预编译包。'
                    : 'Use the button below or wait for silent install on agim start.')
                  : (zh
                    ? '当前平台无预编译包：请 brew install whisper-cpp 或自备 whisper-cli。'
                    : 'No prebuild for this platform — brew install whisper-cpp or provide whisper-cli.')}
              </p>
            )}
            {whisperModel?.binLastError && !whisperModel.bin && !whisperModel.binDownloading && (
              <p className="text-[11px] text-warning break-all">{whisperModel.binLastError}</p>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-border/50 pt-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="text-text-dim">{zh ? '模型：' : 'Model:'}</span>
                {whisperModel?.downloading ? (
                  <Badge variant="info" className="gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {zh ? '下载中' : 'Downloading'}
                  </Badge>
                ) : whisperModel?.ready ? (
                  <Badge variant="success" className="gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    {zh ? '已就绪' : 'Ready'}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-text-dim">
                    <XCircle className="h-3 w-3" />
                    {zh ? '未下载' : 'Not downloaded'}
                  </Badge>
                )}
              </div>
              <p className="truncate font-mono text-[10px] text-text-dim" title={whisperModel?.path || whisperModel?.defaultPath}>
                {whisperModel?.path || whisperModel?.defaultPath || '~/.agim/whisper/models/ggml-base.bin'}
              </p>
              {whisperModel?.lastError && !whisperModel.ready && !whisperModel.downloading && (
                <p className="text-[11px] text-warning break-all">{whisperModel.lastError}</p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={runtimeBusy || runtimeReady}
              onClick={() => initModel.mutate()}
            >
              {runtimeBusy
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Download className="h-4 w-4" />}
              {runtimeReady
                ? (zh ? '本地引擎已就绪' : 'Engine ready')
                : runtimeBusy
                  ? (zh ? '安装中…' : 'Installing…')
                  : (zh ? '初始化本地引擎' : 'Initialize local engine')}
            </Button>
          </div>
        </div>
      )}
      {(info.envKeys?.length ?? 0) > 0 && (
      <div className="grid gap-3 sm:grid-cols-2">
        {(info.envKeys ?? []).map((envKey) => {
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
