/**
 * VectorBackendForm — inline, form-based editor for the seven
 * AGIM_MEMORY_VECTOR_* keys that drive the embedding backend.
 *
 * Replaces the older "Edit in env" link path: operators no longer
 * have to know which env var maps to which knob, and the on-the-wire
 * format (numbers, OpenAI URL shape) is enforced by the widget.
 *
 * Save flow: PUT /api/env (backend-side allowlist filters to just
 * these keys), then auto-trigger a single `vector/test` so the user
 * sees in toast whether the new config produces an embedding.
 *
 * API key: the GET /api/env response returns secrets masked (e.g.
 * "sk-1***...abcd"). The widget shows the mask as placeholder and
 * leaves the input empty by default — typing a value sends it as a
 * real update, leaving it empty sends nothing for that key (the
 * server already rejects masked echoes as "no change").
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Eye, EyeOff, Loader2, Save } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEnv, useUpdateEnv } from '@/hooks/use-settings'
import { useTriggerVectorTest } from '@/hooks/use-vector'
import { describeError } from '@/lib/api/errors'

type BackendName = 'off' | 'local' | 'openai'

interface FormState {
  backend: BackendName
  localModel: string
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKey: string        // empty = "keep existing"
  batchSize: string
  hybridWeight: string
}

const DEFAULTS: FormState = {
  backend: 'off',
  localModel: 'Xenova/bge-base-zh-v1.5',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'text-embedding-3-small',
  openaiApiKey: '',
  batchSize: '32',
  hybridWeight: '0.5',
}

function readFormFromEnv(env: Record<string, string>): FormState {
  const raw = (env.AGIM_MEMORY_VECTOR_BACKEND || '').toLowerCase()
  const backend: BackendName = raw === 'local' || raw === 'openai' ? raw : 'off'
  return {
    backend,
    localModel:     env.AGIM_MEMORY_VECTOR_LOCAL_MODEL      || '',
    openaiBaseUrl:  env.AGIM_MEMORY_VECTOR_OPENAI_BASE_URL  || '',
    openaiModel:    env.AGIM_MEMORY_VECTOR_OPENAI_MODEL     || '',
    openaiApiKey:   '',
    batchSize:      env.AGIM_MEMORY_VECTOR_BATCH_SIZE       || '',
    hybridWeight:   env.AGIM_MEMORY_VECTOR_HYBRID_WEIGHT    || '',
  }
}

export interface VectorBackendFormProps {
  /** Called after a successful save + test cycle so the parent page can
   *  refresh status + coverage. */
  onSaved?: () => void
}

export function VectorBackendForm({ onSaved }: VectorBackendFormProps): JSX.Element {
  const { t } = useTranslation(['memory', 'common'])

  // Pull masked env (we never need real key on the client; the masked
  // value is shown as placeholder so the operator can tell a value is
  // configured without revealing it).
  const envQuery = useEnv({ reveal: false })
  const env = useMemo(() => envQuery.data?.env ?? {}, [envQuery.data?.env])

  const [form, setForm] = useState<FormState>(DEFAULTS)
  const [showApiKey, setShowApiKey] = useState(false)
  const initialRef = useRef<FormState>(DEFAULTS)

  // Reset from server only when the underlying env object identity
  // changes (after refetch). useEffect avoids stomping on local edits
  // mid-typing.
  useEffect(() => {
    if (!envQuery.data) return
    const next = readFormFromEnv(env)
    setForm(next)
    initialRef.current = next
  }, [env, envQuery.data])

  const updateEnv = useUpdateEnv()
  const test = useTriggerVectorTest()

  const dirty = useMemo(() => {
    const initial = initialRef.current
    return (Object.keys(form) as Array<keyof FormState>).some((k) => form[k] !== initial[k])
  }, [form])

  function set<K extends keyof FormState>(k: K, v: FormState[K]): void {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  // v1.2.75 — when the operator switches backend off→local / off→openai
  // and the per-backend fields are still empty, auto-prefill defaults so
  // they don't have to look up the BGE model id by hand. They can still
  // edit afterwards. Also fills shared numeric knobs (batch / weight)
  // since those have well-known sensible defaults too.
  function selectBackend(next: BackendName): void {
    setForm((prev) => {
      const out = { ...prev, backend: next }
      if (next === 'local' && !out.localModel.trim()) {
        out.localModel = DEFAULTS.localModel
      }
      if (next === 'openai') {
        if (!out.openaiBaseUrl.trim()) out.openaiBaseUrl = DEFAULTS.openaiBaseUrl
        if (!out.openaiModel.trim())   out.openaiModel   = DEFAULTS.openaiModel
      }
      if (next !== 'off') {
        if (!out.batchSize.trim())    out.batchSize    = DEFAULTS.batchSize
        if (!out.hybridWeight.trim()) out.hybridWeight = DEFAULTS.hybridWeight
      }
      return out
    })
  }

  function validate(): string | null {
    if (form.backend === 'openai') {
      if (!form.openaiBaseUrl.trim()) return t('vector.form.errors.baseUrlRequired')
      try { new URL(form.openaiBaseUrl.trim()) } catch { return t('vector.form.errors.baseUrlInvalid') }
      if (!form.openaiModel.trim()) return t('vector.form.errors.openaiModelRequired')
      const hasExistingKey = !!env.AGIM_MEMORY_VECTOR_OPENAI_API_KEY
      if (!hasExistingKey && !form.openaiApiKey.trim()) {
        return t('vector.form.errors.apiKeyRequired')
      }
    }
    if (form.backend === 'local' && !form.localModel.trim()) {
      return t('vector.form.errors.localModelRequired')
    }
    if (form.batchSize.trim()) {
      const n = Number(form.batchSize)
      if (!Number.isFinite(n) || n < 1 || n > 1024) return t('vector.form.errors.batchSizeRange')
    }
    if (form.hybridWeight.trim()) {
      const n = Number(form.hybridWeight)
      if (!Number.isFinite(n) || n < 0 || n > 1) return t('vector.form.errors.hybridWeightRange')
    }
    return null
  }

  function buildUpdates(): Record<string, string | null> {
    const initial = initialRef.current
    const out: Record<string, string | null> = {}
    const diff = (key: string, current: string, prev: string): void => {
      if (current === prev) return
      out[key] = current.trim() === '' ? null : current.trim()
    }
    diff('AGIM_MEMORY_VECTOR_BACKEND',         form.backend,        initial.backend)
    diff('AGIM_MEMORY_VECTOR_LOCAL_MODEL',     form.localModel,     initial.localModel)
    diff('AGIM_MEMORY_VECTOR_OPENAI_BASE_URL', form.openaiBaseUrl,  initial.openaiBaseUrl)
    diff('AGIM_MEMORY_VECTOR_OPENAI_MODEL',    form.openaiModel,    initial.openaiModel)
    diff('AGIM_MEMORY_VECTOR_BATCH_SIZE',      form.batchSize,      initial.batchSize)
    diff('AGIM_MEMORY_VECTOR_HYBRID_WEIGHT',   form.hybridWeight,   initial.hybridWeight)
    // API key: only send if the user actually typed a non-empty new value.
    // Empty input = keep current (which is the whole point of the placeholder UX).
    if (form.openaiApiKey.trim()) {
      out.AGIM_MEMORY_VECTOR_OPENAI_API_KEY = form.openaiApiKey.trim()
    }
    return out
  }

  async function onSave(): Promise<void> {
    const err = validate()
    if (err) {
      toast.error(err)
      return
    }
    const updates = buildUpdates()
    if (Object.keys(updates).length === 0) {
      toast.info(t('vector.form.nothingChanged'))
      return
    }
    try {
      await updateEnv.mutateAsync({ updates })
      toast.success(t('vector.form.savedToast'))
      // Auto-test against the freshly applied config. We don't await
      // the parent's refresh — the toast is the source of truth for the
      // operator; the status card behind it picks up dims / lastError
      // on its next 3s poll anyway.
      try {
        const r = await test.mutateAsync()
        if (r.ok) toast.success(t('vector.actions.testOk'))
        else toast.error(t('vector.actions.testFail', { detail: r.error ?? '' }))
      } catch (terr) {
        const { message } = describeError(terr, t)
        toast.error(t('vector.actions.testFail', { detail: message }))
      }
      onSaved?.()
    } catch (serr) {
      const { message } = describeError(serr, t)
      toast.error(message)
    }
  }

  function onDiscard(): void {
    setForm(initialRef.current)
  }

  const busy = updateEnv.isPending || test.isPending
  const hasExistingKey = !!env.AGIM_MEMORY_VECTOR_OPENAI_API_KEY

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{t('vector.form.title')}</h2>
        {dirty && <Badge variant="info">{t('vector.form.dirty')}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onDiscard}
              disabled={busy}
            >
              {t('vector.form.discard')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void onSave()}
            disabled={!dirty || busy}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('vector.form.saveAndTest')}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-text-dim">{t('vector.form.hint')}</p>

      {envQuery.isLoading ? (
        <div className="mt-3 h-32 w-full rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Backend selector — full row on mobile, half on desktop */}
          <Field label={t('vector.form.backend')} help={t('vector.form.backendHelp')}>
            <Select value={form.backend} onValueChange={(v) => selectBackend(v as BackendName)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{t('vector.form.backendOff')}</SelectItem>
                <SelectItem value="local">{t('vector.form.backendLocal')}</SelectItem>
                <SelectItem value="openai">{t('vector.form.backendOpenai')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {/* Local-only field */}
          {form.backend === 'local' && (
            <Field label={t('vector.form.localModel')} help={t('vector.form.localModelHelp')}>
              <Input
                value={form.localModel}
                placeholder={DEFAULTS.localModel}
                onChange={(e) => set('localModel', e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
          )}

          {/* OpenAI-only fields */}
          {form.backend === 'openai' && (
            <>
              <Field label={t('vector.form.openaiBaseUrl')} help={t('vector.form.openaiBaseUrlHelp')}>
                <Input
                  value={form.openaiBaseUrl}
                  placeholder={DEFAULTS.openaiBaseUrl}
                  onChange={(e) => set('openaiBaseUrl', e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
              <Field label={t('vector.form.openaiModel')} help={t('vector.form.openaiModelHelp')}>
                <Input
                  value={form.openaiModel}
                  placeholder={DEFAULTS.openaiModel}
                  onChange={(e) => set('openaiModel', e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
              <Field
                label={t('vector.form.openaiApiKey')}
                help={hasExistingKey ? t('vector.form.apiKeyKeepHint') : t('vector.form.apiKeyNewHint')}
              >
                <div className="flex items-center gap-1">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={form.openaiApiKey}
                    placeholder={hasExistingKey
                      ? (env.AGIM_MEMORY_VECTOR_OPENAI_API_KEY || '••••')
                      : 'sk-…'}
                    onChange={(e) => set('openaiApiKey', e.target.value)}
                    className="font-mono text-xs"
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowApiKey((v) => !v)}
                    aria-label={t('vector.form.toggleApiKey')}
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </Field>
            </>
          )}

          {/* Shared numeric knobs (hidden when off so they don't visually
              suggest the operator can tune anything without picking a
              backend first). */}
          {form.backend !== 'off' && (
            <>
              <Field label={t('vector.form.batchSize')} help={t('vector.form.batchSizeHelp')}>
                <Input
                  type="number"
                  min={1}
                  max={1024}
                  step={1}
                  value={form.batchSize}
                  placeholder={DEFAULTS.batchSize}
                  onChange={(e) => set('batchSize', e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
              <Field label={t('vector.form.hybridWeight')} help={t('vector.form.hybridWeightHelp')}>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={form.hybridWeight}
                  placeholder={DEFAULTS.hybridWeight}
                  onChange={(e) => set('hybridWeight', e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-text-dim">{label}</Label>
      {children}
      {help && <p className="text-[11px] text-text-muted">{help}</p>}
    </div>
  )
}
