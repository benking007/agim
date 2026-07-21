/**
 * /settings/llm — Agim Agent model APIs + runtime settings.
 *
 * Front-end for the `/api/llm/*` REST surface that landed in Stage 4.
 * Operators add an OpenAI-compatible or Anthropic API, paste an API
 * key, optionally bind roles (cheap / evaluator / native-chat), and
 * tune built-in Agim Agent runtime behavior without hand-editing
 * ~/.agim/config.json.
 *
 * Intentionally minimal styling — focused on doing the job; matches
 * the existing settings pages' shadcn look without bespoke chrome.
 */

import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  KeyRound,
  Loader2,
  MessageSquare,
  Plug,
  Plus,
  RefreshCcw,
  SlidersHorizontal,
  Trash2,
  Zap,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  useLlmList, useLlmAddBackend, useLlmQuickEnable, useLlmRemoveBackend, useLlmPutRoles, useLlmPing,
  type LlmBackendRow,
  type LlmMaxTokensField,
  type LlmThinkingFormat,
} from '@/hooks/use-llm-admin'
import { useConfig, useUpdateConfig } from '@/hooks/use-settings'
import {
  DEFAULT_LLM_PRESET,
  firstAvailablePreset,
  installedBuiltinPresetKeys,
  LLM_PRESETS,
  suggestLlmBackendName,
  type LlmPresetKey,
} from '@/lib/llm-presets'
import { NativeAgentSettingsPanel } from '@/routes/settings/native-agent'
import { cn } from '@/lib/utils'

const KNOWN_ROLES = ['cheap', 'evaluator', 'native-chat'] as const
const UNBIND_SENTINEL = '__unbind__'

interface ProbeErrorState {
  backend: string
  message: string
}

export interface SettingsLlmPanelProps {
  /** Hide the page-level title (used inside modals). */
  embedded?: boolean
  className?: string
}

/** Shared LLM settings body — full page and modal both render this. */
export function SettingsLlmPanel({
  embedded = false,
  className,
}: SettingsLlmPanelProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const listQuery = useLlmList()
  return (
    <div className={cn('flex flex-col gap-6', !embedded && 'mx-auto max-w-5xl', className)}>
      {!embedded && (
        <>
          <header className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{t('llm.title')}</h1>
            <Button
              variant="ghost" size="sm" className="ml-auto"
              onClick={() => void listQuery.refetch()}
              disabled={listQuery.isFetching}
              aria-label={t('actions.refresh', { ns: 'common' })}
            >
              {listQuery.isFetching
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCcw className="h-4 w-4" />}
              <span className="hidden sm:inline">{t('llm.refresh')}</span>
            </Button>
          </header>
          <p className="text-sm text-text-dim">{t('llm.subtitle')}</p>
        </>
      )}

      {embedded && (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm text-text-dim">{t('llm.subtitle')}</p>
          <Button
            variant="ghost" size="sm"
            onClick={() => void listQuery.refetch()}
            disabled={listQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {listQuery.isFetching
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCcw className="h-4 w-4" />}
          </Button>
        </div>
      )}

      {listQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          <QuickAgentSetupCard
            data={listQuery.data}
            onRefresh={() => { void listQuery.refetch() }}
          />
          {!embedded && <LlmNextStepCard data={listQuery.data} />}
          <AdvancedLlmSection data={listQuery.data} />
        </>
      )}
    </div>
  )
}

export default function SettingsLlmRoute(): JSX.Element {
  return <SettingsLlmPanel />
}

function AdvancedLlmSection({
  data,
}: {
  data: ReturnType<typeof useLlmList>['data']
}): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  return (
    <>
      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-dim">
          <SlidersHorizontal className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{t('llm.advanced.title')}</h2>
            <Badge variant="outline">{t('llm.advanced.badge')}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-dim">{t('llm.advanced.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full sm:w-auto"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span>{open ? t('llm.advanced.hide') : t('llm.advanced.show')}</span>
        </Button>
      </section>

      {open && (
        <>
          <BackendsCard data={data} />
          <AddBackendCard />
          <RolesCard data={data} />
          <section id="agim-agent" className="rounded-md border border-border bg-surface px-4 py-3">
            <h2 className="text-sm font-semibold">{t('llm.agimAgentRuntimeTitle')}</h2>
            <p className="mt-1 text-xs text-text-dim">{t('llm.agimAgentRuntimeHint')}</p>
          </section>
          <NativeAgentSettingsPanel embedded />
        </>
      )}
    </>
  )
}

function LlmNextStepCard({
  data,
}: {
  data: ReturnType<typeof useLlmList>['data']
}): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const usableBackends = (data?.backends ?? []).filter((b) => b.secret.source !== 'none')
  const nativeRole = data?.roles?.['native-chat']
  const activeBackend = usableBackends.find((b) => b.name === nativeRole) ?? usableBackends[0]

  if (!activeBackend) {
    return (
      <section className="rounded-md border border-dashed border-border bg-surface px-4 py-3">
        <h2 className="text-sm font-semibold">{t('llm.next.emptyTitle')}</h2>
        <p className="mt-1 text-sm text-text-dim">{t('llm.next.emptyDetail')}</p>
      </section>
    )
  }

  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success-bg text-success">
          <MessageSquare className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{t('llm.next.title')}</h2>
            <Badge variant="success">{t('llm.next.backendBadge', { backend: activeBackend.name })}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-dim">{t('llm.next.detail')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <code className="rounded-md bg-surface-2 px-2 py-1 text-xs text-text">/models</code>
            <code className="rounded-md bg-surface-2 px-2 py-1 text-xs text-text">
              /model {activeBackend.name}
            </code>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to="/?welcome=1">
              <span>{t('llm.next.chat')}</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="sm" variant="secondary">
            <Link to="/settings/messengers">
              <Plug className="h-4 w-4" />
              <span>{t('llm.next.im')}</span>
            </Link>
          </Button>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── First-run quick setup ─────────────── */

function QuickAgentSetupCard({
  data,
  onRefresh,
}: {
  data: ReturnType<typeof useLlmList>['data']
  onRefresh: () => void
}): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const cfgQuery = useConfig()
  const updateConfig = useUpdateConfig()
  const addBackend = useLlmAddBackend()
  const quickEnable = useLlmQuickEnable()
  const putRoles = useLlmPutRoles()
  const ping = useLlmPing()
  const existingNames = useMemo(
    () => (data?.backends ?? []).map((b) => b.name),
    [data],
  )
  const usableBackends = (data?.backends ?? []).filter((b) => b.secret.source !== 'none')
  const nativeRole = data?.roles?.['native-chat']
  const activeBackend = usableBackends.find((b) => b.name === nativeRole) ?? usableBackends[0]
  const defaultIsNative = cfgQuery.data?.defaultAgent === 'agim' || cfgQuery.data?.defaultAgent === 'native'
  const alreadyReady = Boolean(activeBackend && nativeRole && defaultIsNative)

  const installedPresets = useMemo(
    () => installedBuiltinPresetKeys(data?.backends ?? []),
    [data?.backends],
  )
  const [presetKey, setPresetKey] = useState<LlmPresetKey>(() =>
    firstAvailablePreset(installedBuiltinPresetKeys([])),
  )
  const [name, setName] = useState(() => suggestLlmBackendName(DEFAULT_LLM_PRESET.baseName, existingNames))
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LLM_PRESET.baseUrl)
  const [model, setModel] = useState(DEFAULT_LLM_PRESET.model)
  const [apiKey, setApiKey] = useState('')
  const [setupResult, setSetupResult] = useState<{ tone: 'success' | 'warning'; message: string } | null>(null)
  const [probeError, setProbeError] = useState<ProbeErrorState | null>(null)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'testing'>('idle')

  const busy = phase !== 'idle' || addBackend.isPending || quickEnable.isPending || putRoles.isPending || updateConfig.isPending || ping.isPending

  function applyPreset(next: LlmPresetKey): void {
    if (next !== 'custom' && installedPresets.has(next)) return
    const p = LLM_PRESETS.find((item) => item.key === next) ?? DEFAULT_LLM_PRESET
    setPresetKey(next)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setName(suggestLlmBackendName(p.baseName, existingNames))
  }

  useEffect(() => {
    if (presetKey === 'custom' || !installedPresets.has(presetKey)) return
    const next = firstAvailablePreset(installedPresets)
    if (next === presetKey) return
    const p = LLM_PRESETS.find((item) => item.key === next) ?? DEFAULT_LLM_PRESET
    setPresetKey(next)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setName(suggestLlmBackendName(p.baseName, existingNames))
  }, [installedPresets, presetKey, existingNames])

  async function enableExistingBackend(backendName: string): Promise<void> {
    try {
      await putRoles.mutateAsync({ 'native-chat': backendName })
      await updateConfig.mutateAsync({ defaultAgent: 'agim' })
      await cfgQuery.refetch()
      onRefresh()
      toast.success(t('llm.quick.enabledToast'))
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err))
    }
  }

  const isCustom = presetKey === 'custom'
  const selectedPreset = LLM_PRESETS.find((p) => p.key === presetKey) ?? DEFAULT_LLM_PRESET

  async function onQuickSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!apiKey.trim()) { toast.error(t('llm.apiKeyRequired')); return }
    if (!isCustom && installedPresets.has(presetKey)) {
      toast.error(t('llm.presetAlreadyAddedError', { preset: t(`llm.presets.${presetKey}`) }))
      return
    }
    if (isCustom) {
      if (!name.trim()) { toast.error(t('llm.nameRequired')); return }
      if (!baseUrl.trim() || !/^https?:\/\//i.test(baseUrl.trim())) {
        toast.error(t('llm.baseUrlRequired'))
        return
      }
      if (!model.trim()) { toast.error(t('llm.modelRequired')); return }
    }
    setSetupResult(null)
    try {
      setPhase('saving')
      const enabled = await quickEnable.mutateAsync({
        preset: presetKey,
        apiKey: apiKey.trim(),
        // Presets fill name/model/baseUrl server-side; custom supplies them.
        ...(isCustom
          ? {
              name: name.trim(),
              baseUrl: baseUrl.trim(),
              model: model.trim(),
            }
          : {}),
      })
      await cfgQuery.refetch()
      onRefresh()

      setPhase('testing')
      try {
        const probe = await ping.mutateAsync(enabled.name)
        if (probe.ok) {
          const message = t('llm.quick.testOk', { ms: probe.durationMs ?? 0 })
          setSetupResult({ tone: 'success', message })
          toast.success(t('llm.quick.setupDone'))
        } else {
          const message = probe.error || t('llm.quick.testFailed')
          setSetupResult({ tone: 'warning', message })
          setProbeError({ backend: enabled.name, message })
        }
      } catch (err) {
        const message = (err as Error)?.message ?? String(err)
        setSetupResult({ tone: 'warning', message })
        setProbeError({ backend: enabled.name, message })
      }
      setApiKey('')
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err))
    } finally {
      setPhase('idle')
    }
  }

  const probeDialog = (
    <LlmProbeErrorDialog
      error={probeError}
      onOpenChange={(open) => { if (!open) setProbeError(null) }}
    />
  )

  if (activeBackend) {
    return (
      <>
        {probeDialog}
        <section className="rounded-md border border-border bg-surface p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success-bg text-success">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">{t('llm.quick.readyTitle')}</h2>
                <Badge variant={alreadyReady ? 'success' : 'warning'}>
                  {alreadyReady ? t('llm.quick.readyBadge') : t('llm.quick.enableBadge')}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-text-dim">
                {alreadyReady
                  ? t('llm.quick.readyDetail', { backend: activeBackend.name })
                  : t('llm.quick.enableDetail', { backend: activeBackend.name })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!alreadyReady && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void enableExistingBackend(activeBackend.name)}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                  <span>{t('llm.quick.enableAction')}</span>
                </Button>
              )}
              <Button asChild variant={alreadyReady ? 'default' : 'secondary'} size="sm">
                <Link to="/?welcome=1">
                  <span>{t('llm.quick.chatAction')}</span>
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </>
    )
  }

  return (
    <>
      {probeDialog}
      <section className="rounded-md border border-border bg-surface p-4">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-bg text-accent">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t('llm.quick.title')}</h2>
          <p className="mt-1 text-sm text-text-dim">{t('llm.quick.subtitle')}</p>
        </div>
      </div>

      <form className="space-y-3" onSubmit={(e) => void onQuickSubmit(e)}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs font-medium">{t('llm.preset')}</Label>
            <Select value={presetKey} onValueChange={(v) => applyPreset(v as LlmPresetKey)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LLM_PRESETS.map((p) => {
                  const added = p.key !== 'custom' && installedPresets.has(p.key)
                  return (
                    <SelectItem key={p.key} value={p.key} disabled={added}>
                      {added
                        ? t('llm.presetAlreadyAdded', { preset: t(`llm.presets.${p.key}`) })
                        : t(`llm.presets.${p.key}`)}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs font-medium">{t('llm.apiKey')}</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('llm.apiKeyPlaceholder')}
              className="font-mono text-xs"
              autoComplete="off"
              autoFocus
            />
            {!isCustom && (
              <p className="mt-1 text-xs text-text-dim">
                {t('llm.quick.presetHint', {
                  model: (selectedPreset.models
                    ?? [selectedPreset.model, selectedPreset.cheapModel].filter(Boolean)).join(', '),
                })}
              </p>
            )}
          </div>
        </div>

        {isCustom && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs font-medium">{t('llm.name')}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('llm.namePlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs font-medium">{t('llm.model')}</Label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t('llm.modelPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs font-medium">{t('llm.baseUrl')}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={t('llm.baseUrlPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {setupResult && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-text-dim">
              {setupResult.tone === 'success'
                ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                : <AlertCircle className="h-4 w-4 shrink-0 text-warning" />}
              <span className="break-words">{setupResult.message}</span>
            </div>
          )}
          <Button type="submit" disabled={busy} className="sm:ml-auto">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {phase === 'testing'
              ? t('llm.quick.testing')
              : phase === 'saving'
                ? t('llm.quick.saving')
                : t('llm.quick.saveAndTest')}
          </Button>
        </div>
      </form>
      </section>
    </>
  )
}

/* ─────────────── Backends list (grouped by provider) ─────────────── */

interface BackendGroup {
  key: string
  title: string
  provider: string
  baseUrl: string
  backends: LlmBackendRow[]
}

function backendGroupKey(b: LlmBackendRow): string {
  if (b.label?.trim()) return `label:${b.label.trim().toLowerCase()}`
  if (b.baseUrl?.trim()) return `url:${b.provider}|${b.baseUrl.trim()}`
  return `solo:${b.name}`
}

/** Resolve a human brand title (DeepSeek / OpenAI / …), never a bare hostname. */
function resolveGroupBrandTitle(
  b: LlmBackendRow,
  key: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const fromLabel = (key.startsWith('label:') ? key.slice('label:'.length) : b.label?.trim().toLowerCase()) || ''
  if (fromLabel) {
    return t(`llm.presets.${fromLabel}`, { defaultValue: fromLabel })
  }
  const matched = LLM_PRESETS.find((p) => {
    if (p.key === 'custom' || !p.baseUrl || !b.baseUrl) return false
    try {
      return new URL(p.baseUrl).hostname === new URL(b.baseUrl).hostname
    } catch {
      return b.baseUrl.includes(p.baseUrl) || p.baseUrl.includes(b.baseUrl)
    }
  })
  if (matched) return t(`llm.presets.${matched.key}`)
  if (b.baseUrl) {
    try {
      const host = new URL(b.baseUrl).hostname.replace(/^api\./, '')
      const brand = host.split('.')[0] || host
      return brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : host
    } catch {
      return b.baseUrl
    }
  }
  return b.name
}

function groupBackends(
  rows: LlmBackendRow[],
  titleFor: (b: LlmBackendRow, key: string) => string,
): BackendGroup[] {
  const map = new Map<string, LlmBackendRow[]>()
  for (const b of rows) {
    const key = backendGroupKey(b)
    const list = map.get(key)
    if (list) list.push(b)
    else map.set(key, [b])
  }
  return [...map.entries()].flatMap(([key, backends]) => {
    const head = backends[0]
    if (!head) return []
    return [{
      key,
      title: titleFor(head, key),
      provider: head.provider,
      baseUrl: head.baseUrl ?? '',
      backends,
    }]
  })
}

function BackendsCard({ data }: { data: ReturnType<typeof useLlmList>['data'] }): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const removeBackend = useLlmRemoveBackend()
  const ping = useLlmPing()
  const [pingResults, setPingResults] = useState<Record<string, string>>({})
  const [probeError, setProbeError] = useState<ProbeErrorState | null>(null)
  /** Provider groups start collapsed; expand to see models. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  async function onRemoveGroup(group: BackendGroup): Promise<void> {
    if (!confirm(t('llm.removeGroupConfirm', {
      title: group.title,
      count: group.backends.length,
    }))) return
    try {
      let removedRoles = 0
      for (const b of group.backends) {
        const r = await removeBackend.mutateAsync(b.name)
        removedRoles += r.removedRoles
      }
      toast.success(t('llm.removedGroupToast', {
        title: group.title,
        count: group.backends.length,
        roles: removedRoles,
      }))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  async function onPing(name: string): Promise<void> {
    setPingResults((m) => ({ ...m, [name]: t('llm.pinging') }))
    try {
      const r = await ping.mutateAsync(name)
      const msg = r.ok
        ? `✓ ${r.durationMs}ms · tokens ${r.tokensIn}→${r.tokensOut}`
        : `✗ ${r.error}`
      setPingResults((m) => ({ ...m, [name]: msg }))
      if (!r.ok) setProbeError({ backend: name, message: r.error || t('llm.quick.testFailed') })
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      setPingResults((m) => ({ ...m, [name]: `✗ ${message}` }))
      setProbeError({ backend: name, message })
    }
  }

  const rows = data?.backends ?? []
  const groups = useMemo(
    () => groupBackends(data?.backends ?? [], (b, key) => resolveGroupBrandTitle(b, key, t)),
    [data?.backends, t],
  )

  if (rows.length === 0) {
    return (
      <section className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-dim">
        {t('llm.backendsEmpty')}
      </section>
    )
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <LlmProbeErrorDialog
        error={probeError}
        onOpenChange={(open) => { if (!open) setProbeError(null) }}
      />
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          {t('llm.backendsTitle', { count: rows.length })}
        </h2>
        <p className="mt-1 text-xs text-text-dim">
          {t('llm.backendsGroupedHint', {
            groups: groups.length,
            defaultValue: 'Grouped by provider ({{groups}} groups).',
          })}
        </p>
      </header>
      <div className="divide-y divide-border">
        {groups.map((group) => {
          const secretSources = new Set(group.backends.map((b) => b.secret.source))
          const allMissing = [...secretSources].every((s) => s === 'none')
          const keyBadge = allMissing
            ? <Badge variant="outline">{t('llm.secretMissing')}</Badge>
            : <Badge variant="success">{[...secretSources].filter((s) => s !== 'none').join(' / ') || 'file'}</Badge>
          const open = expanded[group.key] === true
          return (
            <div key={group.key} className="px-4 py-3">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  aria-expanded={open}
                  onClick={() => setExpanded((m) => ({ ...m, [group.key]: !open }))}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{group.title}</h3>
                      <Badge variant="outline">
                        {t('llm.groupModelCount', {
                          count: group.backends.length,
                          defaultValue: '{{count}} models',
                        })}
                      </Badge>
                      <span className="font-mono text-[11px] text-text-dim">{group.provider}</span>
                      {keyBadge}
                    </div>
                    {group.baseUrl && (
                      <p className="mt-1 break-all font-mono text-[11px] text-text-dim">{group.baseUrl}</p>
                    )}
                  </div>
                  <span
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-dim hover:bg-surface-2"
                    aria-hidden
                  >
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-0.5 shrink-0 text-danger hover:text-danger"
                  disabled={removeBackend.isPending}
                  aria-label={t('llm.removeGroup', { title: group.title })}
                  title={t('llm.removeGroup', { title: group.title })}
                  onClick={(e) => {
                    e.stopPropagation()
                    void onRemoveGroup(group)
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="hidden sm:inline">{t('llm.remove')}</span>
                </Button>
              </div>
              {open && (
                <div className="mt-3">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('llm.col.model')}</TableHead>
                        <TableHead>{t('llm.col.name')}</TableHead>
                        <TableHead>{t('llm.col.apiKey')}</TableHead>
                        <TableHead>{t('llm.col.actions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.backends.map((b) => {
                        const rowKey = b.secret.source === 'none'
                          ? <Badge variant="outline">{t('llm.secretMissing')}</Badge>
                          : <Badge variant="success">{b.secret.source}</Badge>
                        // Show model id as the human “name” so operators aren’t
                        // confused by internal stems like deepseek-agim.
                        const displayName = b.model || b.name
                        return (
                          <TableRow key={b.name}>
                            <TableCell className="font-mono text-xs font-medium">{b.model}</TableCell>
                            <TableCell className="font-mono text-[11px] text-text-dim" title={b.name}>
                              {displayName}
                            </TableCell>
                            <TableCell>{rowKey}</TableCell>
                            <TableCell className="flex flex-col gap-1 sm:flex-row sm:items-center">
                              <Button
                                variant="ghost" size="sm"
                                onClick={() => void onPing(b.name)}
                                disabled={ping.isPending || b.secret.source === 'none'}
                                title={b.secret.source === 'none' ? t('llm.setKeyFirst') : t('llm.pingHint')}
                              >
                                <Zap className="h-4 w-4" />
                                <span>{t('llm.ping')}</span>
                              </Button>
                              {pingResults[b.name] && (
                                <span className="ml-2 text-[11px] text-text-dim">{pingResults[b.name]}</span>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function isTemperatureDeprecatedError(message: string): boolean {
  return /temperature/i.test(message) && /deprecated|not supported|unsupported|invalid_params/i.test(message)
}

function LlmProbeErrorDialog({
  error,
  onOpenChange,
}: {
  error: ProbeErrorState | null
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const hint = error && isTemperatureDeprecatedError(error.message)
    ? t('llm.errorDialog.temperatureHint')
    : t('llm.errorDialog.defaultHint')
  return (
    <Dialog open={error != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('llm.errorDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('llm.errorDialog.description', { backend: error?.backend ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-text-dim">{hint}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2 p-3 text-xs text-text">
            {error?.message ?? ''}
          </pre>
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t('actions.close', { ns: 'common' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─────────────── Role bindings ─────────────── */

function RolesCard({ data }: { data: ReturnType<typeof useLlmList>['data'] }): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const putRoles = useLlmPutRoles()
  const backendNames = (data?.backends ?? []).map((b) => b.name)
  const current = data?.roles ?? {}

  async function onChangeRole(role: string, value: string): Promise<void> {
    const next: Record<string, string | null> = {
      [role]: value === UNBIND_SENTINEL ? null : value,
    }
    try {
      await putRoles.mutateAsync(next)
      toast.success(t('llm.roleUpdated', { role }))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('llm.rolesTitle')}</h2>
        <p className="mt-1 text-xs text-text-dim">{t('llm.rolesOptionalHint')}</p>
      </header>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        {KNOWN_ROLES.map((role) => (
          <div key={role} className="flex flex-col gap-1">
            <Label className="text-xs font-medium">{role}</Label>
            <Select
              value={current[role] ?? UNBIND_SENTINEL}
              onValueChange={(v) => void onChangeRole(role, v)}
              disabled={backendNames.length === 0 || putRoles.isPending}
            >
              <SelectTrigger className="font-mono text-xs">
                <SelectValue placeholder={t('llm.unset')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNBIND_SENTINEL}>{t('llm.unbound')}</SelectItem>
                {backendNames.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-text-dim">
              {t(`llm.roleHint.${role}`)}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ─────────────── Add backend form ─────────────── */

type ThinkingFormatChoice = 'auto' | LlmThinkingFormat
type MaxTokensFieldChoice = 'auto' | LlmMaxTokensField
type CompatTemplate = 'none' | 'deepseek' | 'openai-effort' | 'mimo'

function parseOptionalPositiveInt(raw: string): number | undefined {
  const t = raw.trim()
  if (!t) return undefined
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

function parseOptionalTemperature(raw: string): number | undefined {
  const t = raw.trim()
  if (!t) return undefined
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > 2) return undefined
  return n
}

function AddBackendCard(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const addBackend = useLlmAddBackend()
  const quickEnable = useLlmQuickEnable()
  const listQuery = useLlmList()
  const installedPresets = useMemo(
    () => installedBuiltinPresetKeys(listQuery.data?.backends ?? []),
    [listQuery.data?.backends],
  )
  const [presetKey, setPresetKey] = useState<LlmPresetKey>(() =>
    firstAvailablePreset(installedBuiltinPresetKeys([])),
  )
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [provider, setProvider] = useState<'openai-compat' | 'anthropic'>('openai-compat')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [compatTemplate, setCompatTemplate] = useState<CompatTemplate>('none')
  const [temperature, setTemperature] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [thinkingFormat, setThinkingFormat] = useState<ThinkingFormatChoice>('auto')
  const [maxTokensField, setMaxTokensField] = useState<MaxTokensFieldChoice>('auto')
  const [extraHeaders, setExtraHeaders] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const isCustom = presetKey === 'custom'
  const selected = LLM_PRESETS.find((p) => p.key === presetKey) ?? DEFAULT_LLM_PRESET
  const busy = addBackend.isPending || quickEnable.isPending
  const presetAlreadyAdded = !isCustom && installedPresets.has(presetKey)

  function fail(message: string): void {
    setFormError(message)
    toast.error(message)
  }

  function resetAdvanced(): void {
    setCompatTemplate('none')
    setTemperature('')
    setMaxTokens('')
    setContextWindow('')
    setThinkingFormat('auto')
    setMaxTokensField('auto')
    setExtraHeaders('')
    setProvider('openai-compat')
    setAdvancedOpen(false)
  }

  function applyCompatTemplate(next: CompatTemplate): void {
    setCompatTemplate(next)
    if (next === 'none') {
      setThinkingFormat('auto')
      setMaxTokensField('auto')
      setContextWindow('')
      return
    }
    if (next === 'deepseek') {
      setThinkingFormat('deepseek')
      setMaxTokensField('auto')
      setContextWindow('128000')
      return
    }
    if (next === 'openai-effort') {
      setThinkingFormat('openai')
      setMaxTokensField('max_completion_tokens')
      setContextWindow('1000000')
      return
    }
    // mimo-like
    setThinkingFormat('deepseek')
    setMaxTokensField('max_completion_tokens')
    setContextWindow('1000000')
  }

  function onPickPreset(next: LlmPresetKey): void {
    if (next !== 'custom' && installedPresets.has(next)) return
    setPresetKey(next)
    const p = LLM_PRESETS.find((item) => item.key === next) ?? DEFAULT_LLM_PRESET
    if (next === 'custom') {
      setBaseUrl('')
      setModel('')
      setName(p.baseName)
      resetAdvanced()
    } else {
      setBaseUrl(p.baseUrl)
      setModel(p.model)
      setName('')
      resetAdvanced()
    }
  }

  // If the selected built-in is already installed (or becomes so), jump to
  // the next available option so the form never submits a duplicate.
  useEffect(() => {
    if (presetKey === 'custom' || !installedPresets.has(presetKey)) return
    const next = firstAvailablePreset(installedPresets)
    if (next === presetKey) return
    const p = LLM_PRESETS.find((item) => item.key === next) ?? DEFAULT_LLM_PRESET
    setPresetKey(next)
    setCompatTemplate('none')
    setTemperature('')
    setMaxTokens('')
    setContextWindow('')
    setThinkingFormat('auto')
    setMaxTokensField('auto')
    setExtraHeaders('')
    setProvider('openai-compat')
    setAdvancedOpen(false)
    if (next === 'custom') {
      setBaseUrl('')
      setModel('')
      setName(p.baseName)
    } else {
      setBaseUrl(p.baseUrl)
      setModel(p.model)
      setName('')
    }
  }, [installedPresets, presetKey])

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!apiKey.trim()) { fail(t('llm.apiKeyRequired')); return }
    if (presetAlreadyAdded) {
      fail(t('llm.presetAlreadyAddedError', { preset: t(`llm.presets.${presetKey}`) }))
      return
    }
    try {
      if (isCustom) {
        if (!name.trim()) { fail(t('llm.nameRequired')); return }
        if (!baseUrl.trim() || !/^https?:\/\//i.test(baseUrl.trim())) {
          fail(t('llm.baseUrlRequired'))
          return
        }
        if (!model.trim()) { fail(t('llm.modelRequired')); return }
        const temp = parseOptionalTemperature(temperature)
        if (temperature.trim() && temp === undefined) {
          fail(t('llm.temperatureInvalid')); return
        }
        const maxTok = parseOptionalPositiveInt(maxTokens)
        if (maxTokens.trim() && maxTok === undefined) {
          fail(t('llm.maxTokensInvalid')); return
        }
        const ctx = parseOptionalPositiveInt(contextWindow)
        if (contextWindow.trim() && (ctx === undefined || ctx < 4096)) {
          fail(t('llm.contextWindowInvalid')); return
        }
        await addBackend.mutateAsync({
          name: name.trim(),
          provider,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiKey: apiKey.trim(),
          ...(temp !== undefined ? { temperature: temp } : {}),
          ...(maxTok !== undefined ? { maxTokens: maxTok } : {}),
          ...(ctx !== undefined ? { contextWindow: ctx } : {}),
          ...(thinkingFormat !== 'auto' ? { thinkingFormat } : {}),
          ...(maxTokensField !== 'auto' ? { maxTokensField } : {}),
          ...(extraHeaders.trim() ? { extraHeaders: extraHeaders.trim() } : {}),
        })
        toast.success(t('llm.addedWithKey', { name: name.trim() }))
      } else {
        // Preset path: same as Quick-enable — API key only; register all models.
        const enabled = await quickEnable.mutateAsync({
          preset: presetKey,
          apiKey: apiKey.trim(),
          bindCheapRoles: true,
          setDefaultAgent: false,
        })
        const models = (enabled.backends ?? [{ name: enabled.name, model: enabled.model }])
          .map((b) => b.model)
          .join(', ')
        toast.success(t('llm.addedPresetModels', {
          preset: t(`llm.presets.${presetKey}`),
          models,
          defaultValue: 'Added {{preset}}: {{models}}',
        }))
      }
      setFormError(null)
      setApiKey('')
      if (isCustom) resetAdvanced()
      void listQuery.refetch()
    } catch (err) {
      fail((err as Error)?.message ?? String(err))
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('llm.addTitle')}</h2>
        <p className="mt-1 text-xs text-text-dim">{t('llm.addSubtitle')}</p>
      </header>
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-3 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs font-medium">{t('llm.preset')}</Label>
            <Select value={presetKey} onValueChange={(v) => onPickPreset(v as LlmPresetKey)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LLM_PRESETS.map((p) => {
                  const added = p.key !== 'custom' && installedPresets.has(p.key)
                  return (
                    <SelectItem key={p.key} value={p.key} disabled={added}>
                      {added
                        ? t('llm.presetAlreadyAdded', { preset: t(`llm.presets.${p.key}`) })
                        : t(`llm.presets.${p.key}`)}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs font-medium">{t('llm.apiKey')}</Label>
            <Input
              type="password"
              value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('llm.apiKeyPlaceholder')}
              className="font-mono text-xs"
              autoComplete="off"
            />
            {!isCustom && (
              <p className="mt-1 text-xs text-text-dim">
                {t('llm.addPresetHint', {
                  models: (selected.models ?? [selected.model, selected.cheapModel].filter(Boolean)).join(', '),
                  defaultValue: 'Will register: {{models}}',
                })}
              </p>
            )}
          </div>
        </div>

        {isCustom && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs font-medium">{t('llm.name')}</Label>
              <Input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder={t('llm.namePlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs font-medium">{t('llm.model')}</Label>
              <Input
                value={model} onChange={(e) => setModel(e.target.value)}
                placeholder={t('llm.modelPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs font-medium">{t('llm.baseUrl')}</Label>
              <Input
                value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={t('llm.baseUrlPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs font-medium">{t('llm.provider')}</Label>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as 'openai-compat' | 'anthropic')}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai-compat">{t('llm.providerOpenaiCompat')}</SelectItem>
                  <SelectItem value="anthropic">{t('llm.providerAnthropic')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="sm:col-span-2">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-2/40 px-3 py-2 text-left text-xs font-medium text-text"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <span>{t('llm.customAdvancedTitle')}</span>
                <span className="font-normal text-text-dim">{t('llm.customAdvancedHint')}</span>
              </button>
            </div>

            {advancedOpen && (
              <>
                <div className="sm:col-span-2">
                  <Label className="text-xs font-medium">{t('llm.compatTemplate')}</Label>
                  <Select
                    value={compatTemplate}
                    onValueChange={(v) => applyCompatTemplate(v as CompatTemplate)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('llm.compatTemplates.none')}</SelectItem>
                      <SelectItem value="deepseek">{t('llm.compatTemplates.deepseek')}</SelectItem>
                      <SelectItem value="openai-effort">{t('llm.compatTemplates.openaiEffort')}</SelectItem>
                      <SelectItem value="mimo">{t('llm.compatTemplates.mimo')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[11px] text-text-dim">{t('llm.compatTemplateHint')}</p>
                </div>
                <div>
                  <Label className="text-xs font-medium">{t('llm.temperature')}</Label>
                  <Input
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                    placeholder={t('llm.temperaturePlaceholder')}
                    className="font-mono text-xs"
                    inputMode="decimal"
                  />
                </div>
                <div>
                  <Label className="text-xs font-medium">{t('llm.maxTokens')}</Label>
                  <Input
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(e.target.value)}
                    placeholder={t('llm.maxTokensPlaceholder')}
                    className="font-mono text-xs"
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <Label className="text-xs font-medium">{t('llm.contextWindow')}</Label>
                  <Input
                    value={contextWindow}
                    onChange={(e) => setContextWindow(e.target.value)}
                    placeholder={t('llm.contextWindowPlaceholder')}
                    className="font-mono text-xs"
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <Label className="text-xs font-medium">{t('llm.thinkingFormat')}</Label>
                  <Select
                    value={thinkingFormat}
                    onValueChange={(v) => setThinkingFormat(v as ThinkingFormatChoice)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t('llm.thinkingFormats.auto')}</SelectItem>
                      <SelectItem value="off">{t('llm.thinkingFormats.off')}</SelectItem>
                      <SelectItem value="deepseek">{t('llm.thinkingFormats.deepseek')}</SelectItem>
                      <SelectItem value="openai">{t('llm.thinkingFormats.openai')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs font-medium">{t('llm.maxTokensField')}</Label>
                  <Select
                    value={maxTokensField}
                    onValueChange={(v) => setMaxTokensField(v as MaxTokensFieldChoice)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t('llm.maxTokensFields.auto')}</SelectItem>
                      <SelectItem value="max_tokens">{t('llm.maxTokensFields.maxTokens')}</SelectItem>
                      <SelectItem value="max_completion_tokens">{t('llm.maxTokensFields.maxCompletionTokens')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs font-medium">{t('llm.extraHeaders')}</Label>
                  <textarea
                    value={extraHeaders}
                    onChange={(e) => setExtraHeaders(e.target.value)}
                    placeholder={t('llm.extraHeadersPlaceholder')}
                    className="min-h-[72px] w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    spellCheck={false}
                  />
                  <p className="mt-1 text-[11px] text-text-dim">{t('llm.extraHeadersHint')}</p>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:items-end">
          {formError && (
            <p className="text-xs text-danger">{formError}</p>
          )}
          <Button type="submit" disabled={busy || presetAlreadyAdded} className="sm:ml-auto">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t('llm.addBackend')}
          </Button>
        </div>
      </form>
    </section>
  )
}
