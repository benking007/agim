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

import { type FormEvent, useMemo, useState } from 'react'
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
  useLlmList, useLlmAddBackend, useLlmRemoveBackend, useLlmPutRoles, useLlmPing,
} from '@/hooks/use-llm-admin'
import { useConfig, useUpdateConfig } from '@/hooks/use-settings'
import {
  DEFAULT_LLM_PRESET,
  LLM_PRESETS,
  suggestLlmBackendName,
  type LlmPresetKey,
} from '@/lib/llm-presets'
import { NativeAgentSettingsPanel } from '@/routes/settings/native-agent'

const KNOWN_ROLES = ['cheap', 'evaluator', 'native-chat'] as const
const UNBIND_SENTINEL = '__unbind__'

interface ProbeErrorState {
  backend: string
  message: string
}

export default function SettingsLlmRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const listQuery = useLlmList()
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
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

      {listQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          <QuickAgentSetupCard
            data={listQuery.data}
            onRefresh={() => { void listQuery.refetch() }}
          />
          <LlmNextStepCard data={listQuery.data} />
          <AdvancedLlmSection data={listQuery.data} />
        </>
      )}
    </div>
  )
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
  const putRoles = useLlmPutRoles()
  const ping = useLlmPing()
  const existingNames = useMemo(
    () => (data?.backends ?? []).map((b) => b.name),
    [data],
  )
  const usableBackends = (data?.backends ?? []).filter((b) => b.secret.source !== 'none')
  const nativeRole = data?.roles?.['native-chat']
  const activeBackend = usableBackends.find((b) => b.name === nativeRole) ?? usableBackends[0]
  const defaultIsNative = cfgQuery.data?.defaultAgent === 'native'
  const alreadyReady = Boolean(activeBackend && nativeRole && defaultIsNative)

  const [presetKey, setPresetKey] = useState<LlmPresetKey>('deepseek')
  const preset = useMemo(
    () => LLM_PRESETS.find((p) => p.key === presetKey) ?? DEFAULT_LLM_PRESET,
    [presetKey],
  )
  const [name, setName] = useState(() => suggestLlmBackendName(DEFAULT_LLM_PRESET.baseName, existingNames))
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LLM_PRESET.baseUrl)
  const [model, setModel] = useState(DEFAULT_LLM_PRESET.model)
  const [apiKey, setApiKey] = useState('')
  const [setupResult, setSetupResult] = useState<{ tone: 'success' | 'warning'; message: string } | null>(null)
  const [probeError, setProbeError] = useState<ProbeErrorState | null>(null)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'testing'>('idle')

  const busy = phase !== 'idle' || addBackend.isPending || putRoles.isPending || updateConfig.isPending || ping.isPending

  function applyPreset(next: LlmPresetKey): void {
    const p = LLM_PRESETS.find((item) => item.key === next) ?? DEFAULT_LLM_PRESET
    setPresetKey(next)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setName(suggestLlmBackendName(p.baseName, existingNames))
  }

  async function enableExistingBackend(backendName: string): Promise<void> {
    try {
      await putRoles.mutateAsync({ 'native-chat': backendName })
      await updateConfig.mutateAsync({ defaultAgent: 'native' })
      await cfgQuery.refetch()
      onRefresh()
      toast.success(t('llm.quick.enabledToast'))
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err))
    }
  }

  async function onQuickSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const backendName = name.trim()
    const endpoint = baseUrl.trim()
    const modelId = model.trim()
    if (!backendName) { toast.error(t('llm.nameRequired')); return }
    if (!endpoint || !/^https?:\/\//i.test(endpoint)) { toast.error(t('llm.baseUrlRequired')); return }
    if (!modelId) { toast.error(t('llm.modelRequired')); return }
    if (!apiKey.trim()) { toast.error(t('llm.apiKeyRequired')); return }
    setSetupResult(null)
    try {
      setPhase('saving')
      await addBackend.mutateAsync({
        name: backendName,
        provider: preset.provider,
        baseUrl: endpoint,
        model: modelId,
        apiKey: apiKey.trim(),
      })
      await putRoles.mutateAsync({ 'native-chat': backendName })
      await updateConfig.mutateAsync({ defaultAgent: 'native' })
      await cfgQuery.refetch()
      onRefresh()

      setPhase('testing')
      try {
        const probe = await ping.mutateAsync(backendName)
        if (probe.ok) {
          const message = t('llm.quick.testOk', { ms: probe.durationMs ?? 0 })
          setSetupResult({ tone: 'success', message })
          toast.success(t('llm.quick.setupDone'))
        } else {
          const message = probe.error || t('llm.quick.testFailed')
          setSetupResult({ tone: 'warning', message })
          setProbeError({ backend: backendName, message })
        }
      } catch (err) {
        const message = (err as Error)?.message ?? String(err)
        setSetupResult({ tone: 'warning', message })
        setProbeError({ backend: backendName, message })
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

      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={(e) => void onQuickSubmit(e)}>
        <div>
          <Label className="text-xs font-medium">{t('llm.preset')}</Label>
          <Select value={presetKey} onValueChange={(v) => applyPreset(v as LlmPresetKey)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {LLM_PRESETS.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {t(`llm.presets.${p.key}`)}
                </SelectItem>
              ))}
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
          />
        </div>
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
        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center">
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

/* ─────────────── Backends list ─────────────── */

function BackendsCard({ data }: { data: ReturnType<typeof useLlmList>['data'] }): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const removeBackend = useLlmRemoveBackend()
  const ping = useLlmPing()
  const [pingResults, setPingResults] = useState<Record<string, string>>({})
  const [probeError, setProbeError] = useState<ProbeErrorState | null>(null)

  async function onRemove(name: string): Promise<void> {
    if (!confirm(t('llm.removeConfirm', { name }))) return
    try {
      const r = await removeBackend.mutateAsync(name)
      toast.success(t('llm.removedToast', { count: r.removedRoles }))
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
        <h2 className="text-sm font-semibold">{t('llm.backendsTitle', { count: rows.length })}</h2>
      </header>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('llm.col.name')}</TableHead>
            <TableHead>{t('llm.col.provider')}</TableHead>
            <TableHead>{t('llm.col.model')}</TableHead>
            <TableHead>{t('llm.col.baseUrl')}</TableHead>
            <TableHead>{t('llm.col.apiKey')}</TableHead>
            <TableHead>{t('llm.col.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((b) => {
            const keyBadge = b.secret.source === 'none'
              ? <Badge variant="outline">{t('llm.secretMissing')}</Badge>
              : <Badge variant="success">{b.secret.source}</Badge>
            return (
              <TableRow key={b.name}>
                <TableCell className="font-mono text-xs">{b.name}</TableCell>
                <TableCell>{b.provider}</TableCell>
                <TableCell className="font-mono text-xs">{b.model}</TableCell>
                <TableCell className="break-all font-mono text-[11px] text-text-dim">{b.baseUrl ?? '—'}</TableCell>
                <TableCell>{keyBadge}</TableCell>
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
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => void onRemove(b.name)}
                    disabled={removeBackend.isPending}
                    className="text-danger hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="hidden sm:inline">{t('llm.remove')}</span>
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

function AddBackendCard(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const addBackend = useLlmAddBackend()
  const [presetIdx, setPresetIdx] = useState(0)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LLM_PRESET.baseUrl)
  const [model, setModel] = useState(DEFAULT_LLM_PRESET.model)
  const [apiKey, setApiKey] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  function fail(message: string): void {
    setFormError(message)
    toast.error(message)
  }

  function onPickPreset(idx: number): void {
    setPresetIdx(idx)
    const p = LLM_PRESETS[idx]
    if (!p) return
    setBaseUrl(p.baseUrl)
    setModel(p.model)
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const p = LLM_PRESETS[presetIdx]
    if (!p) { fail(t('llm.invalidPreset')); return }
    if (!name.trim()) { fail(t('llm.nameRequired')); return }
    if (!baseUrl.trim()) { fail(t('llm.baseUrlRequired')); return }
    if (!model.trim()) { fail(t('llm.modelRequired')); return }
    if (!apiKey.trim()) { fail(t('llm.apiKeyRequired')); return }
    try {
      await addBackend.mutateAsync({
        name: name.trim(),
        provider: p.provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      })
      setFormError(null)
      toast.success(t('llm.addedWithKey', { name: name.trim() }))
      setName(''); setApiKey('')
    } catch (err) {
      const message = ((err as Error)?.message ?? String(err))
      fail(message)
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('llm.addTitle')}</h2>
      </header>
      <form onSubmit={(e) => void onSubmit(e)} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <div>
          <Label className="text-xs font-medium">{t('llm.preset')}</Label>
          <Select value={String(presetIdx)} onValueChange={(v) => onPickPreset(Number(v))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {LLM_PRESETS.map((p, i) => (
                <SelectItem key={p.key} value={String(i)}>
                  {t(`llm.presets.${p.key}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs font-medium">{t('llm.name')}</Label>
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t('llm.namePlaceholder')}
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
          <Label className="text-xs font-medium">{t('llm.model')}</Label>
          <Input
            value={model} onChange={(e) => setModel(e.target.value)}
            placeholder={t('llm.modelPlaceholder')}
            className="font-mono text-xs"
          />
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
        </div>
        <div className="sm:col-span-2 flex">
          <div className="flex w-full flex-col gap-2 sm:items-end">
            {formError && (
              <p className="text-xs text-danger">{formError}</p>
            )}
            <Button
              type="submit"
              disabled={addBackend.isPending}
              className="ml-auto"
            >
              {addBackend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t('llm.addBackend')}
            </Button>
          </div>
        </div>
      </form>
    </section>
  )
}
