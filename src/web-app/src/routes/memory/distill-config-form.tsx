/**
 * DistillConfigForm — inline editor for the "dream distillation"
 * scheduler (memory-distiller.ts + memory-distill.ts).
 *
 * Two things the operator configures here:
 *
 *  1. SOURCE — which LLM extracts facts from buffered turns:
 *       auto  → the turn's own agent (zero-config default; nothing else
 *               to set). Recommended for most installs.
 *       agent → a specific, already-enabled agent CLI
 *               (IMHUB_MEMORY_DISTILL_AGENT).
 *       llm   → a standalone LLM backend bound to the `distill` role,
 *               configured exactly like the native agent's LLM
 *               (PUT /api/llm/roles { distill }). No CLI spawn.
 *
 *  2. SCHEDULE — the cadence knobs (enabled / interval / staleness
 *     floor / batch size / per-user buffer cap), all IMHUB_MEMORY_DISTILL_*
 *     env keys behind the server allowlist.
 *
 * Save flow mirrors vector-backend-form: diff against the last-loaded
 * values, PUT /api/env for the env keys, and — only when source=llm and
 * the chosen backend changed — PUT /api/llm/roles to (re)bind the
 * distill role. Empty agent / backend selections are validated before
 * save so we never persist a half-configured source.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Save } from 'lucide-react'

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
import { useEnv, useUpdateEnv, useConfig } from '@/hooks/use-settings'
import { useLlmList, useLlmPutRoles } from '@/hooks/use-llm-admin'
import { describeError } from '@/lib/api/errors'
import { agentDisplayName } from '@/lib/agent-label'

type DistillSource = 'auto' | 'agent' | 'llm'

interface FormState {
  source: DistillSource
  agent: string          // IMHUB_MEMORY_DISTILL_AGENT (source=agent)
  llmBackend: string     // llmRoles.distill backend name (source=llm)
  enabled: boolean       // IMHUB_MEMORY_DISTILL_ENABLED
  intervalMs: string     // IMHUB_MEMORY_DISTILL_INTERVAL_MS
  floorMin: string       // IMHUB_MEMORY_DISTILL_FLOOR_MIN
  batchMax: string       // IMHUB_MEMORY_DISTILL_BATCH_MAX
  maxPending: string     // IMHUB_MEMORY_DISTILL_MAX_PENDING
}

// Mirror of the memory-distiller.ts defaults so placeholders match the
// runtime fallbacks when a key is unset.
const DEFAULTS = {
  intervalMs: '300000',
  floorMin: '30',
  batchMax: '20',
  maxPending: '200',
} as const

function readEnabled(raw: string | undefined): boolean {
  const v = (raw ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
}

function readSource(raw: string | undefined): DistillSource {
  const v = (raw || 'auto').toLowerCase()
  return v === 'agent' || v === 'llm' ? v : 'auto'
}

export interface DistillConfigFormProps {
  /** Called after a successful save so the parent can refresh status. */
  onSaved?: () => void
}

export function DistillConfigForm({ onSaved }: DistillConfigFormProps): JSX.Element {
  const { t } = useTranslation(['memory', 'common'])

  const envQuery = useEnv({ reveal: false })
  const env = useMemo(() => envQuery.data?.env ?? {}, [envQuery.data?.env])
  const cfgQuery = useConfig()
  const llmQuery = useLlmList()

  const enabledAgents = cfgQuery.data?.agents ?? []
  const llmBackends = llmQuery.data?.backends ?? []
  const currentDistillRole = llmQuery.data?.roles?.distill ?? ''

  const readForm = useMemo<() => FormState>(() => () => ({
    source:     readSource(env.IMHUB_MEMORY_DISTILL_SOURCE),
    agent:      env.IMHUB_MEMORY_DISTILL_AGENT || '',
    llmBackend: currentDistillRole,
    enabled:    readEnabled(env.IMHUB_MEMORY_DISTILL_ENABLED),
    intervalMs: env.IMHUB_MEMORY_DISTILL_INTERVAL_MS || '',
    floorMin:   env.IMHUB_MEMORY_DISTILL_FLOOR_MIN   || '',
    batchMax:   env.IMHUB_MEMORY_DISTILL_BATCH_MAX   || '',
    maxPending: env.IMHUB_MEMORY_DISTILL_MAX_PENDING || '',
  }), [env, currentDistillRole])

  const [form, setForm] = useState<FormState>(readForm)
  const initialRef = useRef<FormState>(form)

  // Re-seed from server once the env + llm roles have both loaded (and on
  // any later refetch). useEffect so we don't stomp mid-edit on every render.
  useEffect(() => {
    if (!envQuery.data) return
    const next = readForm()
    setForm(next)
    initialRef.current = next
  }, [envQuery.data, readForm])

  const updateEnv = useUpdateEnv()
  const putRoles = useLlmPutRoles()

  const dirty = useMemo(() => {
    const initial = initialRef.current
    return (Object.keys(form) as Array<keyof FormState>).some((k) => form[k] !== initial[k])
  }, [form])

  function set<K extends keyof FormState>(k: K, v: FormState[K]): void {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  function numField(value: string, min: number, label: string): string | null {
    if (!value.trim()) return null
    const n = Number(value)
    if (!Number.isFinite(n) || n < min) return t('distill.form.errors.numRange', { field: label, min })
    return null
  }

  function validate(): string | null {
    if (form.source === 'agent' && !form.agent.trim()) {
      return t('distill.form.errors.agentRequired')
    }
    if (form.source === 'llm' && !form.llmBackend.trim()) {
      return t('distill.form.errors.llmRequired')
    }
    return (
      numField(form.intervalMs, 10000, t('distill.form.intervalMs'))
      ?? numField(form.floorMin, 0, t('distill.form.floorMin'))
      ?? numField(form.batchMax, 1, t('distill.form.batchMax'))
      ?? numField(form.maxPending, 1, t('distill.form.maxPending'))
    )
  }

  function buildEnvUpdates(): Record<string, string | null> {
    const initial = initialRef.current
    const out: Record<string, string | null> = {}
    const diffStr = (key: string, cur: string, prev: string): void => {
      if (cur === prev) return
      out[key] = cur.trim() === '' ? null : cur.trim()
    }
    if (form.source !== initial.source) {
      // 'auto' is the runtime default → store null to keep env tidy.
      out.IMHUB_MEMORY_DISTILL_SOURCE = form.source === 'auto' ? null : form.source
    }
    if (form.enabled !== initial.enabled) {
      out.IMHUB_MEMORY_DISTILL_ENABLED = form.enabled ? '1' : '0'
    }
    // Only persist the agent name when the chosen source actually uses it,
    // so flipping away from 'agent' doesn't leave a stale key behind.
    if (form.source === 'agent') {
      diffStr('IMHUB_MEMORY_DISTILL_AGENT', form.agent, initial.agent)
    } else if (initial.agent) {
      out.IMHUB_MEMORY_DISTILL_AGENT = null
    }
    diffStr('IMHUB_MEMORY_DISTILL_INTERVAL_MS', form.intervalMs, initial.intervalMs)
    diffStr('IMHUB_MEMORY_DISTILL_FLOOR_MIN',   form.floorMin,   initial.floorMin)
    diffStr('IMHUB_MEMORY_DISTILL_BATCH_MAX',   form.batchMax,   initial.batchMax)
    diffStr('IMHUB_MEMORY_DISTILL_MAX_PENDING', form.maxPending, initial.maxPending)
    return out
  }

  async function onSave(): Promise<void> {
    const err = validate()
    if (err) { toast.error(err); return }

    const envUpdates = buildEnvUpdates()
    const roleChanged = form.source === 'llm'
      && form.llmBackend.trim() !== ''
      && form.llmBackend !== initialRef.current.llmBackend

    if (Object.keys(envUpdates).length === 0 && !roleChanged) {
      toast.info(t('distill.form.nothingChanged'))
      return
    }

    try {
      if (Object.keys(envUpdates).length > 0) {
        await updateEnv.mutateAsync({ updates: envUpdates })
      }
      if (roleChanged) {
        await putRoles.mutateAsync({ distill: form.llmBackend.trim() })
      }
      toast.success(t('distill.form.savedToast'))
      onSaved?.()
    } catch (serr) {
      const { message } = describeError(serr, t)
      toast.error(message)
    }
  }

  function onDiscard(): void {
    setForm(initialRef.current)
  }

  const busy = updateEnv.isPending || putRoles.isPending
  const noBackends = llmBackends.length === 0
  const noAgents = enabledAgents.length === 0

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{t('distill.form.title')}</h2>
        {dirty && <Badge variant="info">{t('distill.form.dirty')}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <Button type="button" variant="secondary" size="sm" onClick={onDiscard} disabled={busy}>
              {t('distill.form.discard')}
            </Button>
          )}
          <Button type="button" size="sm" onClick={() => void onSave()} disabled={!dirty || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('distill.form.save')}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-text-dim">{t('distill.form.hint')}</p>

      {envQuery.isLoading ? (
        <div className="mt-3 h-32 w-full rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {/* ── Source ── */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('distill.form.source')} help={t('distill.form.sourceHelp')}>
              <Select value={form.source} onValueChange={(v) => set('source', v as DistillSource)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('distill.form.sourceAuto')}</SelectItem>
                  <SelectItem value="agent">{t('distill.form.sourceAgent')}</SelectItem>
                  <SelectItem value="llm">{t('distill.form.sourceLlm')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {form.source === 'auto' && (
              <div className="flex items-end">
                <p className="text-[11px] text-text-muted">{t('distill.form.autoNote')}</p>
              </div>
            )}

            {form.source === 'agent' && (
              <Field label={t('distill.form.agent')} help={t('distill.form.agentHelp')}>
                {noAgents ? (
                  <p className="text-[11px] text-warning">{t('distill.form.noAgents')}</p>
                ) : (
                  <Select value={form.agent} onValueChange={(v) => set('agent', v)}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('distill.form.agentPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledAgents.map((name) => (
                        <SelectItem key={name} value={name}>{agentDisplayName(name)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}

            {form.source === 'llm' && (
              <Field label={t('distill.form.llmBackend')} help={t('distill.form.llmBackendHelp')}>
                {noBackends ? (
                  <p className="text-[11px] text-warning">{t('distill.form.noBackends')}</p>
                ) : (
                  <Select value={form.llmBackend} onValueChange={(v) => set('llmBackend', v)}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('distill.form.llmPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {llmBackends.map((b) => (
                        <SelectItem key={b.name} value={b.name}>
                          {b.name} <span className="text-text-muted">· {b.model}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}
          </div>

          {/* ── Schedule ── */}
          <div>
            <div className="text-xs font-medium text-text-dim">{t('distill.form.scheduleTitle')}</div>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('distill.form.enabled')} help={t('distill.form.enabledHelp')}>
                <Select
                  value={form.enabled ? 'on' : 'off'}
                  onValueChange={(v) => set('enabled', v === 'on')}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="on">{t('distill.form.enabledOn')}</SelectItem>
                    <SelectItem value="off">{t('distill.form.enabledOff')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <NumberField
                label={t('distill.form.intervalMs')}
                help={t('distill.form.intervalMsHelp')}
                value={form.intervalMs}
                placeholder={DEFAULTS.intervalMs}
                min={10000}
                step={10000}
                onChange={(v) => set('intervalMs', v)}
              />
              <NumberField
                label={t('distill.form.floorMin')}
                help={t('distill.form.floorMinHelp')}
                value={form.floorMin}
                placeholder={DEFAULTS.floorMin}
                min={0}
                step={5}
                onChange={(v) => set('floorMin', v)}
              />
              <NumberField
                label={t('distill.form.batchMax')}
                help={t('distill.form.batchMaxHelp')}
                value={form.batchMax}
                placeholder={DEFAULTS.batchMax}
                min={1}
                step={1}
                onChange={(v) => set('batchMax', v)}
              />
              <NumberField
                label={t('distill.form.maxPending')}
                help={t('distill.form.maxPendingHelp')}
                value={form.maxPending}
                placeholder={DEFAULTS.maxPending}
                min={1}
                step={10}
                onChange={(v) => set('maxPending', v)}
              />
            </div>
          </div>
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

function NumberField({
  label,
  help,
  value,
  placeholder,
  min,
  step,
  onChange,
}: {
  label: string
  help?: string
  value: string
  placeholder: string
  min: number
  step: number
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <Field label={label} help={help}>
      <Input
        type="number"
        min={min}
        step={step}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
      />
    </Field>
  )
}
