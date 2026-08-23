/**
 * Shared "pick a preset → paste a key → save + ping" card.
 * Settings → LLM and /setup both render this so first-run and later
 * configuration stay on one code path.
 */

import { type FormEvent, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ClipboardPaste,
  KeyRound,
  Loader2,
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
  useLlmAddBackend, useLlmQuickEnable, useLlmPutRoles, useLlmPing,
  useLlmPresets,
  type LlmListResponse,
} from '@/hooks/use-llm-admin'
import { useConfig, useUpdateConfig } from '@/hooks/use-settings'
import {
  DEFAULT_LLM_PRESET,
  firstAvailablePreset,
  installedBuiltinPresetKeys,
  LLM_PRESETS,
  resolvePresetCatalog,
  suggestLlmBackendName,
  type LlmPresetKey,
} from '@/lib/llm-presets'
import { cn } from '@/lib/utils'

const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const OLLAMA_MODEL = 'llama3.2'
const OLLAMA_NAME = 'ollama-agim'

export interface ProbeErrorState {
  backend: string
  message: string
}

export interface QuickAgentSetupCardProps {
  data: LlmListResponse | undefined
  onRefresh: () => void
  variant?: 'card' | 'wizard'
  onComplete?: () => void
  onSkip?: () => void
}

function isTemperatureDeprecatedError(message: string): boolean {
  return /temperature/i.test(message) && /deprecated|not supported|unsupported|invalid_params/i.test(message)
}

export function LlmProbeErrorDialog({
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

export function QuickAgentSetupCard({
  data,
  onRefresh,
  variant = 'card',
  onComplete,
  onSkip,
}: QuickAgentSetupCardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'setup', 'common'])
  const cfgQuery = useConfig()
  const updateConfig = useUpdateConfig()
  const addBackend = useLlmAddBackend()
  const quickEnable = useLlmQuickEnable()
  const putRoles = useLlmPutRoles()
  const ping = useLlmPing()
  const presetsQuery = useLlmPresets()
  const { presets: catalog, defaultPreset } = useMemo(
    () => resolvePresetCatalog(presetsQuery.data),
    [presetsQuery.data],
  )
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
    () => installedBuiltinPresetKeys(data?.backends ?? [], catalog),
    [data?.backends, catalog],
  )
  const [presetKey, setPresetKey] = useState<LlmPresetKey>(() =>
    firstAvailablePreset(installedBuiltinPresetKeys([]), LLM_PRESETS),
  )
  const [name, setName] = useState(() => suggestLlmBackendName(DEFAULT_LLM_PRESET.baseName, existingNames))
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LLM_PRESET.baseUrl)
  const [model, setModel] = useState(DEFAULT_LLM_PRESET.model)
  const [apiKey, setApiKey] = useState('')
  const [deepseekDialect, setDeepseekDialect] = useState<'openai' | 'anthropic'>('openai')
  const [deepseekStrictTools, setDeepseekStrictTools] = useState(false)
  const [setupResult, setSetupResult] = useState<{ tone: 'success' | 'warning'; message: string } | null>(null)
  const [probeError, setProbeError] = useState<ProbeErrorState | null>(null)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'testing'>('idle')
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1)
  const [localOllama, setLocalOllama] = useState(false)

  const busy = phase !== 'idle' || addBackend.isPending || quickEnable.isPending || putRoles.isPending || updateConfig.isPending || ping.isPending
  const isWizard = variant === 'wizard'

  function applyPreset(next: LlmPresetKey): void {
    const p = catalog.find((item) => item.key === next) ?? defaultPreset
    setLocalOllama(false)
    setPresetKey(next)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setName(suggestLlmBackendName(p.baseName, existingNames))
    if (next !== 'deepseek') {
      setDeepseekDialect('openai')
      setDeepseekStrictTools(false)
    }
  }

  function applyOllama(): void {
    setLocalOllama(true)
    setPresetKey('custom')
    setBaseUrl(OLLAMA_BASE_URL)
    setModel(OLLAMA_MODEL)
    setName(suggestLlmBackendName(OLLAMA_NAME, existingNames))
    setDeepseekDialect('openai')
    setDeepseekStrictTools(false)
  }

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
  const selectedPreset = catalog.find((p) => p.key === presetKey) ?? defaultPreset
  const allowEmptyKey = localOllama

  async function onQuickSubmit(e?: FormEvent): Promise<void> {
    e?.preventDefault()
    const keyToSend = apiKey.trim() || (allowEmptyKey ? 'local' : '')
    if (!keyToSend) { toast.error(t('llm.apiKeyRequired')); return }
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
      if (isWizard) setWizardStep(3)
      const enabled = await quickEnable.mutateAsync({
        preset: presetKey,
        apiKey: keyToSend,
        ...(isCustom
          ? {
              name: name.trim(),
              baseUrl: baseUrl.trim(),
              model: model.trim(),
            }
          : {}),
        ...(presetKey === 'deepseek'
          ? {
              dialect: deepseekDialect,
              strictTools: deepseekStrictTools,
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
          setApiKey('')
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
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err))
      if (isWizard) setWizardStep(2)
    } finally {
      setPhase('idle')
    }
  }

  async function pasteKey(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText()
      if (text.trim()) setApiKey(text.trim())
    } catch {
      toast.error(t('setup:pasteFailed'))
    }
  }

  const probeDialog = (
    <LlmProbeErrorDialog
      error={probeError}
      onOpenChange={(open) => { if (!open) setProbeError(null) }}
    />
  )

  if (activeBackend && !isWizard) {
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

  const dialectFields = presetKey === 'deepseek' && (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
      <div>
        <Label className="text-xs font-medium">{t('llm.quick.dialectLabel')}</Label>
        <Select
          value={deepseekDialect}
          onValueChange={(v) => setDeepseekDialect(v as 'openai' | 'anthropic')}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">{t('llm.quick.dialectOpenai')}</SelectItem>
            <SelectItem value="anthropic">{t('llm.quick.dialectAnthropic')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {deepseekDialect === 'openai' && (
        <label className="flex items-start gap-2 text-xs text-text-dim">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={deepseekStrictTools}
            onChange={(e) => setDeepseekStrictTools(e.target.checked)}
          />
          <span>{t('llm.quick.strictTools')}</span>
        </label>
      )}
    </div>
  )

  const customFields = isCustom && (
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
  )

  if (isWizard) {
    return (
      <>
        {probeDialog}
        <div className="space-y-4">
          <p className="text-xs font-medium text-text-muted">
            {t('setup:step', { current: wizardStep, total: 3 })}
          </p>

          {wizardStep === 1 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">{t('setup:step1Title')}</h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {catalog.map((p) => {
                  const added = p.key !== 'custom' && installedPresets.has(p.key)
                  const selected = !localOllama && presetKey === p.key
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => applyPreset(p.key)}
                      className={cn(
                        'rounded-md border px-3 py-3 text-left text-sm transition-colors',
                        selected ? 'border-accent bg-accent-bg' : 'border-border bg-surface hover:bg-surface-2',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{t(`llm.presets.${p.key}`)}</span>
                        {p.key === 'deepseek' && (
                          <Badge variant="success">{t('setup:recommended')}</Badge>
                        )}
                      </div>
                      {added && (
                        <p className="mt-1 text-xs text-text-dim">{t('llm.presetAlreadyAdded', { preset: t(`llm.presets.${p.key}`) })}</p>
                      )}
                    </button>
                  )
                })}
                <button
                  type="button"
                  onClick={applyOllama}
                  className={cn(
                    'rounded-md border px-3 py-3 text-left text-sm transition-colors',
                    localOllama ? 'border-accent bg-accent-bg' : 'border-border bg-surface hover:bg-surface-2',
                  )}
                >
                  <span className="font-medium">{t('setup:ollama')}</span>
                  <p className="mt-1 text-xs text-text-dim">{t('setup:ollamaHint')}</p>
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => setWizardStep(2)}>
                  {t('setup:next')}
                </Button>
                {onSkip && (
                  <Button type="button" variant="ghost" onClick={onSkip}>
                    {t('setup:skip')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {wizardStep === 2 && (
            <form className="space-y-3" onSubmit={(e) => void onQuickSubmit(e)}>
              <h2 className="text-sm font-semibold">{t('setup:step2Title')}</h2>
              {!localOllama && (
                <div>
                  <Label className="text-xs font-medium">{t('llm.apiKey')}</Label>
                  <div className="mt-1 flex gap-2">
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={t('llm.apiKeyPlaceholder')}
                      className="font-mono text-xs"
                      autoComplete="off"
                      autoFocus
                    />
                    <Button type="button" variant="secondary" onClick={() => void pasteKey()}>
                      <ClipboardPaste className="h-4 w-4" />
                      <span>{t('setup:paste')}</span>
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-text-dim">{t('setup:secretHint')}</p>
                </div>
              )}
              {localOllama && (
                <p className="text-sm text-text-dim">{t('setup:ollamaHint')}</p>
              )}
              {dialectFields}
              {customFields}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => setWizardStep(1)}>
                  {t('setup:back')}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                  {t('setup:saveAndTest')}
                </Button>
                {onSkip && (
                  <Button type="button" variant="ghost" onClick={onSkip}>
                    {t('setup:skip')}
                  </Button>
                )}
              </div>
            </form>
          )}

          {wizardStep === 3 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">{t('setup:step3Title')}</h2>
              {phase !== 'idle' && (
                <p className="flex items-center gap-2 text-sm text-text-dim">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {phase === 'saving' ? t('llm.quick.saving') : t('llm.quick.testing')}
                </p>
              )}
              {setupResult && (
                <div className="flex items-start gap-2 text-sm">
                  {setupResult.tone === 'success'
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                  <span>{setupResult.message}</span>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {setupResult?.tone === 'success' && onComplete && (
                  <Button type="button" onClick={onComplete}>
                    {t('setup:startChat')}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                )}
                {setupResult?.tone === 'warning' && (
                  <>
                    <Button type="button" variant="secondary" onClick={() => setWizardStep(2)}>
                      {t('setup:back')}
                    </Button>
                    {onComplete && (
                      <Button type="button" variant="ghost" onClick={onComplete}>
                        {t('setup:saveAnyway')}
                      </Button>
                    )}
                  </>
                )}
                {onSkip && phase === 'idle' && setupResult?.tone !== 'success' && (
                  <Button type="button" variant="ghost" onClick={onSkip}>
                    {t('setup:skip')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
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
                {catalog.map((p) => {
                  const added = p.key !== 'custom' && installedPresets.has(p.key)
                  return (
                    <SelectItem key={p.key} value={p.key}>
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

        {dialectFields}
        {customFields}

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
