/**
 * /settings/native-agent — focused env editor for Agim Agent +
 * notification evaluator + heartbeat (Stage 6).
 *
 * All three subsystems are env-driven; their env keys are already in
 * ENV_EDITABLE_KEYS so the generic /api/env GET+PUT pair works. This
 * page just gives them a curated form so operators don't have to dig
 * through the 200+-key generic env editor.
 *
 * The actual model API selection (which LLM, which role) lives on
 * /settings/llm; this module covers behavioral knobs.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Bell, Cpu, Gauge, HeartPulse, Loader2, Network,
  RefreshCcw, Save, ShieldAlert, X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useEnv, useUpdateEnv } from '@/hooks/use-settings'

type ApprovalMode = 'allow-all' | 'read-only' | 'allow-list' | 'deny-all'

interface Draft {
  // Agim Agent
  role: string
  mode: ApprovalMode
  autoAllow: string
  denyList: string
  // Notification evaluator
  evalEnabled: boolean
  evalSources: string
  // Heartbeat
  hbEnabled: boolean
  hbTickMs: string
  hbDefaultMin: string
  // v1.2.126 — per-tool runtime caps (each optional / empty = use default).
  // Enforced in the pi tool bridge (agimToolToPi) for the native path.
  toolResultCap: string
  toolTimeoutMs: string
  // v1.2.127 — A2A 子 Agent 派生
  a2aMaxDepth: string
  a2aTimeoutMs: string
  callAgentInProcess: boolean
  callAgentMaxPerTurn: string
  // Plan mode (default + heuristic auto-enter on plan-intent keywords)
  planModeDefault: boolean
  planIntentAuto: boolean
  planIntentPhrases: string
  // Per-turn iteration cap (AGIM_NATIVE_AGENT_MAX_ITER)
  maxIter: string
}

function draftFromEnv(env: Record<string, string>): Draft {
  return {
    role:      env.AGIM_NATIVE_AGENT_ROLE      ?? '',
    mode:      (env.AGIM_NATIVE_AGENT_MODE as ApprovalMode | undefined) || 'read-only',
    autoAllow: env.AGIM_NATIVE_AGENT_AUTOALLOW ?? '',
    denyList:  env.AGIM_NATIVE_AGENT_DENYLIST  ?? '',
    evalEnabled: isTruthy(env.AGIM_NOTIFICATION_EVALUATOR),
    evalSources: env.AGIM_NOTIFICATION_EVALUATOR_SOURCES ?? '',
    hbEnabled:   isTruthy(env.AGIM_HEARTBEAT_ENABLED),
    hbTickMs:    env.AGIM_HEARTBEAT_TICK_INTERVAL_MS ?? '',
    hbDefaultMin: env.AGIM_HEARTBEAT_DEFAULT_INTERVAL_MIN ?? '',
    toolResultCap:     env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS ?? '',
    toolTimeoutMs:     env.AGIM_NATIVE_TOOL_TIMEOUT_MS ?? '',
    a2aMaxDepth:        env.AGIM_A2A_MAX_DEPTH ?? '',
    a2aTimeoutMs:       env.AGIM_A2A_TIMEOUT_DEFAULT_MS ?? '',
    // Default ON: only 'off' / '0' / 'no' / 'false' disable.
    callAgentInProcess: !isFalsy(env.AGIM_NATIVE_CALL_AGENT_IN_PROCESS),
    callAgentMaxPerTurn: env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN ?? '',
    planModeDefault:    isTruthy(env.AGIM_NATIVE_PLAN_MODE),
    planIntentAuto:     isTruthy(env.AGIM_PLAN_INTENT_AUTO),
    planIntentPhrases:  env.AGIM_PLAN_INTENT_PHRASES ?? '',
    maxIter:            env.AGIM_NATIVE_AGENT_MAX_ITER ?? '',
  }
}

/** Mirror of the native-side parser: 'off' / '0' / 'no' / 'false'
 *  (case-insensitive) disables a feature whose default is ON. Empty
 *  string means "not set" — caller decides whether that's ON or OFF
 *  depending on the variable's default. */
function isFalsy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.toLowerCase().trim()
  return s === 'off' || s === 'false' || s === '0' || s === 'no'
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function SubtitleWithLlmLink(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const subtitle = t('nativeAgent.subtitle')
  const link = t('nativeAgent.llmLink')
  const idx = subtitle.indexOf(link)
  if (idx === -1) {
    return <p className="text-sm text-text-dim">{subtitle}</p>
  }
  return (
    <p className="text-sm text-text-dim">
      {subtitle.slice(0, idx)}
      <a className="underline" href={link}>{link}</a>
      {subtitle.slice(idx + link.length)}
    </p>
  )
}

export default function SettingsNativeAgentRoute(): JSX.Element {
  return <NativeAgentSettingsPanel />
}

export interface NativeAgentSettingsPanelProps {
  embedded?: boolean
}

export function NativeAgentSettingsPanel({ embedded = false }: NativeAgentSettingsPanelProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const envQuery = useEnv({ reveal: false })
  const updateEnv = useUpdateEnv()

  const envData = envQuery.data?.env ?? {}
  const current = useMemo(() => draftFromEnv(envData), [envData])
  const [draft, setDraft] = useState<Draft>(current)
  const [syncedHash, setSyncedHash] = useState('')

  useEffect(() => {
    const hash = JSON.stringify(current)
    if (hash !== syncedHash) {
      setDraft(current)
      setSyncedHash(hash)
    }
  }, [current, syncedHash])

  const isDirty = JSON.stringify(draft) !== JSON.stringify(current)

  function setField<K extends keyof Draft>(k: K, v: Draft[K]): void {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  async function onSave(): Promise<void> {
    const updates: Record<string, string | null> = {}
    if (draft.role !== current.role) {
      updates.AGIM_NATIVE_AGENT_ROLE = draft.role.trim() || null
    }
    if (draft.mode !== current.mode) {
      updates.AGIM_NATIVE_AGENT_MODE = draft.mode
    }
    if (draft.autoAllow !== current.autoAllow) {
      updates.AGIM_NATIVE_AGENT_AUTOALLOW = draft.autoAllow.trim() || null
    }
    if (draft.denyList !== current.denyList) {
      updates.AGIM_NATIVE_AGENT_DENYLIST = draft.denyList.trim() || null
    }
    if (draft.evalEnabled !== current.evalEnabled) {
      updates.AGIM_NOTIFICATION_EVALUATOR = draft.evalEnabled ? 'on' : null
    }
    if (draft.evalSources !== current.evalSources) {
      updates.AGIM_NOTIFICATION_EVALUATOR_SOURCES = draft.evalSources.trim() || null
    }
    if (draft.hbEnabled !== current.hbEnabled) {
      updates.AGIM_HEARTBEAT_ENABLED = draft.hbEnabled ? 'on' : null
    }
    if (draft.hbTickMs !== current.hbTickMs) {
      updates.AGIM_HEARTBEAT_TICK_INTERVAL_MS = draft.hbTickMs.trim() || null
    }
    if (draft.hbDefaultMin !== current.hbDefaultMin) {
      updates.AGIM_HEARTBEAT_DEFAULT_INTERVAL_MIN = draft.hbDefaultMin.trim() || null
    }
    if (draft.toolResultCap !== current.toolResultCap) {
      updates.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS = draft.toolResultCap.trim() || null
    }
    if (draft.toolTimeoutMs !== current.toolTimeoutMs) {
      updates.AGIM_NATIVE_TOOL_TIMEOUT_MS = draft.toolTimeoutMs.trim() || null
    }
    // v1.2.127 — A2A
    if (draft.a2aMaxDepth !== current.a2aMaxDepth) {
      updates.AGIM_A2A_MAX_DEPTH = draft.a2aMaxDepth.trim() || null
    }
    if (draft.a2aTimeoutMs !== current.a2aTimeoutMs) {
      updates.AGIM_A2A_TIMEOUT_DEFAULT_MS = draft.a2aTimeoutMs.trim() || null
    }
    if (draft.callAgentInProcess !== current.callAgentInProcess) {
      // Default ON: write only when operator turned OFF; ON = delete the env.
      updates.AGIM_NATIVE_CALL_AGENT_IN_PROCESS = draft.callAgentInProcess ? null : 'off'
    }
    if (draft.callAgentMaxPerTurn !== current.callAgentMaxPerTurn) {
      updates.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = draft.callAgentMaxPerTurn.trim() || null
    }
    // Plan mode
    if (draft.planModeDefault !== current.planModeDefault) {
      updates.AGIM_NATIVE_PLAN_MODE = draft.planModeDefault ? '1' : null
    }
    if (draft.planIntentAuto !== current.planIntentAuto) {
      updates.AGIM_PLAN_INTENT_AUTO = draft.planIntentAuto ? 'on' : null
    }
    if (draft.planIntentPhrases !== current.planIntentPhrases) {
      updates.AGIM_PLAN_INTENT_PHRASES = draft.planIntentPhrases.trim() || null
    }
    // Per-turn iteration cap
    if (draft.maxIter !== current.maxIter) {
      updates.AGIM_NATIVE_AGENT_MAX_ITER = draft.maxIter.trim() || null
    }
    if (Object.keys(updates).length === 0) return
    try {
      await updateEnv.mutateAsync({ updates })
      toast.success(t('nativeAgent.savedToast'))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  function onDiscard(): void {
    setDraft(current)
  }

  return (
    <div className={embedded ? 'flex flex-col gap-6' : 'mx-auto flex max-w-4xl flex-col gap-6'}>
      {!embedded && (
        <>
          <header className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{t('nativeAgent.title')}</h1>
            <Button
              variant="ghost" size="sm" className="ml-auto"
              onClick={() => void envQuery.refetch()}
              disabled={envQuery.isFetching}
              aria-label={t('actions.refresh', { ns: 'common' })}
            >
              {envQuery.isFetching
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCcw className="h-4 w-4" />}
              <span className="hidden sm:inline">{t('nativeAgent.refresh')}</span>
            </Button>
          </header>
          <SubtitleWithLlmLink />
        </>
      )}

      {envQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          <NativeAgentCard draft={draft} setField={setField} />
          <RuntimeCapsCard draft={draft} setField={setField} />
          <A2ACard draft={draft} setField={setField} />
          <PlanModeCard draft={draft} setField={setField} />
          <IterationCard draft={draft} setField={setField} />
          <EvaluatorCard draft={draft} setField={setField} />
          <HeartbeatCard draft={draft} setField={setField} />
        </>
      )}

      {isDirty && (
        <div className={embedded
          ? 'flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-3 shadow'
          : 'sticky bottom-2 flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-3 shadow'}
        >
          <Badge variant="info">{t('nativeAgent.unsaved')}</Badge>
          <Button
            variant="ghost" size="sm" className="ml-auto"
            onClick={onDiscard}
            disabled={updateEnv.isPending}
          >
            <X className="h-4 w-4" /> {t('nativeAgent.discard')}
          </Button>
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={updateEnv.isPending}
          >
            {updateEnv.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Save className="h-4 w-4" />}
            {t('nativeAgent.save')}
          </Button>
        </div>
      )}
    </div>
  )
}

interface CardProps {
  draft: Draft
  setField: <K extends keyof Draft>(k: K, v: Draft[K]) => void
}

function NativeAgentCard({ draft, setField }: CardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Cpu className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('nativeAgent.agentCard')}</h2>
      </header>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field
          label={t('nativeAgent.roleOverride')}
          hint={t('nativeAgent.roleHint')}
        >
          <Input
            value={draft.role}
            onChange={(e) => setField('role', e.target.value)}
            placeholder="native-chat"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label={t('nativeAgent.approvalMode')}
          hint={t('nativeAgent.approvalHint')}
        >
          <Select
            value={draft.mode}
            onValueChange={(v) => setField('mode', v as ApprovalMode)}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="read-only">{t('nativeAgent.modeReadOnly')}</SelectItem>
              <SelectItem value="allow-list">{t('nativeAgent.modeAllowList')}</SelectItem>
              <SelectItem value="allow-all">{t('nativeAgent.modeAllowAll')}</SelectItem>
              <SelectItem value="deny-all">{t('nativeAgent.modeDenyAll')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={t('nativeAgent.autoAllow')}
          hint={t('nativeAgent.autoAllowHint')}
        >
          <Input
            value={draft.autoAllow}
            onChange={(e) => setField('autoAllow', e.target.value)}
            placeholder="native_,mcp_filesystem_"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label={t('nativeAgent.denyList')}
          hint={t('nativeAgent.denyListHint')}
        >
          <Input
            value={draft.denyList}
            onChange={(e) => setField('denyList', e.target.value)}
            placeholder="mcp_shell_,mcp_dangerous_"
            className="font-mono text-xs"
          />
        </Field>
      </div>
    </section>
  )
}

function EvaluatorCard({ draft, setField }: CardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bell className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('nativeAgent.evaluatorCard')}</h2>
        {draft.evalEnabled
          ? <Badge variant="success">{t('nativeAgent.on')}</Badge>
          : <Badge variant="outline">{t('nativeAgent.off')}</Badge>}
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('nativeAgent.evalDesc')}</p>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field label={t('nativeAgent.enableGate')}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.evalEnabled}
              onChange={(e) => setField('evalEnabled', e.target.checked)}
              className="h-4 w-4 accent-accent cursor-pointer"
            />
            <span>{t('nativeAgent.filterViaLlm')}</span>
          </label>
        </Field>
        <Field
          label={t('nativeAgent.evalSources')}
          hint={t('nativeAgent.evalSourcesHint')}
        >
          <Input
            value={draft.evalSources}
            onChange={(e) => setField('evalSources', e.target.value)}
            placeholder="push,heartbeat"
            className="font-mono text-xs"
            disabled={!draft.evalEnabled}
          />
        </Field>
      </div>
    </section>
  )
}

function HeartbeatCard({ draft, setField }: CardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <HeartPulse className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('nativeAgent.heartbeatCard')}</h2>
        {draft.hbEnabled
          ? <Badge variant="success">{t('nativeAgent.on')}</Badge>
          : <Badge variant="outline">{t('nativeAgent.off')}</Badge>}
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('nativeAgent.hbDesc')}</p>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <Field label={t('nativeAgent.enableScheduler')}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.hbEnabled}
              onChange={(e) => setField('hbEnabled', e.target.checked)}
              className="h-4 w-4 accent-accent cursor-pointer"
            />
            <span>{t('nativeAgent.startScanLoop')}</span>
          </label>
        </Field>
        <Field
          label={t('nativeAgent.tickInterval')}
          hint={t('nativeAgent.tickHint')}
        >
          <Input
            type="number"
            value={draft.hbTickMs}
            onChange={(e) => setField('hbTickMs', e.target.value)}
            placeholder="60000"
            className="font-mono text-xs"
            disabled={!draft.hbEnabled}
          />
        </Field>
        <Field
          label={t('nativeAgent.defaultInterval')}
          hint={t('nativeAgent.defaultIntervalHint')}
        >
          <Input
            type="number"
            value={draft.hbDefaultMin}
            onChange={(e) => setField('hbDefaultMin', e.target.value)}
            placeholder="15"
            className="font-mono text-xs"
            disabled={!draft.hbEnabled}
          />
        </Field>
      </div>
    </section>
  )
}

function RuntimeCapsCard({ draft, setField }: CardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Gauge className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('nativeAgent.runtimeCard')}</h2>
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('nativeAgent.runtimeDesc')}</p>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field
          label={t('nativeAgent.toolResultCap')}
          hint={t('nativeAgent.toolResultCapHint')}
        >
          <Input
            type="number"
            value={draft.toolResultCap}
            onChange={(e) => setField('toolResultCap', e.target.value)}
            placeholder="64000"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label={t('nativeAgent.toolTimeoutMs')}
          hint={t('nativeAgent.toolTimeoutHint')}
        >
          <Input
            type="number"
            value={draft.toolTimeoutMs}
            onChange={(e) => setField('toolTimeoutMs', e.target.value)}
            placeholder="60000"
            className="font-mono text-xs"
          />
        </Field>
      </div>
    </section>
  )
}

function A2ACard({ draft, setField }: CardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Network className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('nativeAgent.a2aCard')}</h2>
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('nativeAgent.a2aDesc')}</p>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field
          label={t('nativeAgent.a2aMaxDepth')}
          hint={t('nativeAgent.a2aMaxDepthHint')}
        >
          <Input
            type="number"
            value={draft.a2aMaxDepth}
            onChange={(e) => setField('a2aMaxDepth', e.target.value)}
            placeholder="1"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label={t('nativeAgent.a2aTimeoutMs')}
          hint={t('nativeAgent.a2aTimeoutMsHint')}
        >
          <Input
            type="number"
            value={draft.a2aTimeoutMs}
            onChange={(e) => setField('a2aTimeoutMs', e.target.value)}
            placeholder="1800000"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label={t('nativeAgent.callAgentInProcess')}
          hint={t('nativeAgent.callAgentInProcessHint')}
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.callAgentInProcess}
              onChange={(e) => setField('callAgentInProcess', e.target.checked)}
              className="h-4 w-4 accent-accent cursor-pointer"
            />
            <span>{draft.callAgentInProcess ? t('nativeAgent.on') : t('nativeAgent.off')}</span>
          </label>
        </Field>
        <Field
          label={t('nativeAgent.callAgentMaxPerTurn')}
          hint={t('nativeAgent.callAgentMaxPerTurnHint')}
        >
          <Input
            type="number"
            value={draft.callAgentMaxPerTurn}
            onChange={(e) => setField('callAgentMaxPerTurn', e.target.value)}
            placeholder="2"
            className="font-mono text-xs"
          />
        </Field>
      </div>
    </section>
  )
}

function PlanModeCard({ draft, setField }: CardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ShieldAlert className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('nativeAgent.planModeCard')}</h2>
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('nativeAgent.planModeDesc')}</p>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field
          label={t('nativeAgent.planModeDefault')}
          hint={t('nativeAgent.planModeDefaultHint')}
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.planModeDefault}
              onChange={(e) => setField('planModeDefault', e.target.checked)}
              className="h-4 w-4 accent-accent cursor-pointer"
            />
            <span>{draft.planModeDefault ? t('nativeAgent.on') : t('nativeAgent.off')}</span>
          </label>
        </Field>
        <Field
          label={t('nativeAgent.planIntentAuto')}
          hint={t('nativeAgent.planIntentAutoHint')}
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.planIntentAuto}
              onChange={(e) => setField('planIntentAuto', e.target.checked)}
              className="h-4 w-4 accent-accent cursor-pointer"
            />
            <span>{draft.planIntentAuto ? t('nativeAgent.on') : t('nativeAgent.off')}</span>
          </label>
        </Field>
        <Field
          label={t('nativeAgent.planIntentPhrases')}
          hint={t('nativeAgent.planIntentPhrasesHint')}
        >
          <Input
            value={draft.planIntentPhrases}
            onChange={(e) => setField('planIntentPhrases', e.target.value)}
            placeholder="先想想,plan only,don't act yet"
            className="font-mono text-xs"
            disabled={!draft.planIntentAuto}
          />
        </Field>
      </div>
    </section>
  )
}

function IterationCard({ draft, setField }: CardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Gauge className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('nativeAgent.iterationCard')}</h2>
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('nativeAgent.iterationDesc')}</p>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field
          label={t('nativeAgent.maxIter')}
          hint={t('nativeAgent.maxIterHint')}
        >
          <Input
            type="number"
            value={draft.maxIter}
            onChange={(e) => setField('maxIter', e.target.value)}
            placeholder="50"
            className="font-mono text-xs"
          />
        </Field>
      </div>
    </section>
  )
}

interface FieldProps {
  label: string
  hint?: string
  children: React.ReactNode
}
function Field({ label, hint, children }: FieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-text-dim">{hint}</p>}
    </div>
  )
}
