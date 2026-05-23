/**
 * /settings/native-agent — focused env editor for native agent +
 * notification evaluator + heartbeat (Stage 6).
 *
 * All three subsystems are env-driven; their env keys are already in
 * ENV_EDITABLE_KEYS so the generic /api/env GET+PUT pair works. This
 * page just gives them a curated form so operators don't have to dig
 * through the 200+-key generic env editor.
 *
 * The actual native agent backend selection (which LLM, which role)
 * lives on /settings/llm; this page only covers the BEHAVIORAL knobs.
 */

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Bell, Cpu, HeartPulse, Loader2, RefreshCcw, Save, X,
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
  // Native agent
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
}

function draftFromEnv(env: Record<string, string>): Draft {
  return {
    role:      env.IMHUB_NATIVE_AGENT_ROLE      ?? '',
    mode:      (env.IMHUB_NATIVE_AGENT_MODE as ApprovalMode | undefined) || 'read-only',
    autoAllow: env.IMHUB_NATIVE_AGENT_AUTOALLOW ?? '',
    denyList:  env.IMHUB_NATIVE_AGENT_DENYLIST  ?? '',
    evalEnabled: isTruthy(env.IMHUB_NOTIFICATION_EVALUATOR),
    evalSources: env.IMHUB_NOTIFICATION_EVALUATOR_SOURCES ?? '',
    hbEnabled:   isTruthy(env.IMHUB_HEARTBEAT_ENABLED),
    hbTickMs:    env.IMHUB_HEARTBEAT_TICK_INTERVAL_MS ?? '',
    hbDefaultMin: env.IMHUB_HEARTBEAT_DEFAULT_INTERVAL_MIN ?? '',
  }
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export default function SettingsNativeAgentRoute(): JSX.Element {
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
      updates.IMHUB_NATIVE_AGENT_ROLE = draft.role.trim() || null
    }
    if (draft.mode !== current.mode) {
      updates.IMHUB_NATIVE_AGENT_MODE = draft.mode
    }
    if (draft.autoAllow !== current.autoAllow) {
      updates.IMHUB_NATIVE_AGENT_AUTOALLOW = draft.autoAllow.trim() || null
    }
    if (draft.denyList !== current.denyList) {
      updates.IMHUB_NATIVE_AGENT_DENYLIST = draft.denyList.trim() || null
    }
    if (draft.evalEnabled !== current.evalEnabled) {
      updates.IMHUB_NOTIFICATION_EVALUATOR = draft.evalEnabled ? 'on' : null
    }
    if (draft.evalSources !== current.evalSources) {
      updates.IMHUB_NOTIFICATION_EVALUATOR_SOURCES = draft.evalSources.trim() || null
    }
    if (draft.hbEnabled !== current.hbEnabled) {
      updates.IMHUB_HEARTBEAT_ENABLED = draft.hbEnabled ? 'on' : null
    }
    if (draft.hbTickMs !== current.hbTickMs) {
      updates.IMHUB_HEARTBEAT_TICK_INTERVAL_MS = draft.hbTickMs.trim() || null
    }
    if (draft.hbDefaultMin !== current.hbDefaultMin) {
      updates.IMHUB_HEARTBEAT_DEFAULT_INTERVAL_MIN = draft.hbDefaultMin.trim() || null
    }
    if (Object.keys(updates).length === 0) return
    try {
      await updateEnv.mutateAsync({ updates })
      toast.success('Saved.')
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  function onDiscard(): void {
    setDraft(current)
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Native Agent · Evaluator · Heartbeat</h1>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void envQuery.refetch()}
          disabled={envQuery.isFetching}
          aria-label="Refresh"
        >
          {envQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">
        Behavior knobs for the in-process <code>native</code> agent and the two LLM-driven
        gates (<strong>notification evaluator</strong>, <strong>heartbeat</strong>). LLM backend
        + role wiring lives on <a className="underline" href="/settings/llm">/settings/llm</a>;
        this page covers what the agent + gates actually do at runtime.
      </p>

      {envQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          <NativeAgentCard draft={draft} setField={setField} />
          <EvaluatorCard draft={draft} setField={setField} />
          <HeartbeatCard draft={draft} setField={setField} />
        </>
      )}

      {isDirty && (
        <div className="sticky bottom-2 flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-3 shadow">
          <Badge variant="info">unsaved changes</Badge>
          <Button
            variant="ghost" size="sm" className="ml-auto"
            onClick={onDiscard}
            disabled={updateEnv.isPending}
          >
            <X className="h-4 w-4" /> Discard
          </Button>
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={updateEnv.isPending}
          >
            {updateEnv.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Save className="h-4 w-4" />}
            Save
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
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Cpu className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">Native Agent (in-process)</h2>
      </header>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field
          label="Role override"
          hint="LLM role the native loop resolves. Default: native-chat (falls back to cheap). Match a key from /settings/llm role bindings."
        >
          <Input
            value={draft.role}
            onChange={(e) => setField('role', e.target.value)}
            placeholder="native-chat"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label="Approval mode"
          hint="How tool calls from the native loop are gated."
        >
          <Select
            value={draft.mode}
            onValueChange={(v) => setField('mode', v as ApprovalMode)}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="read-only">read-only (safe default; built-ins only)</SelectItem>
              <SelectItem value="allow-list">allow-list (only autoAllow entries)</SelectItem>
              <SelectItem value="allow-all">allow-all (every tool, no gate)</SelectItem>
              <SelectItem value="deny-all">deny-all (no tools)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Auto-allow tool prefixes"
          hint="Comma-separated. Tool names starting with any entry bypass the gate (e.g. native_,mcp_filesystem_)."
        >
          <Input
            value={draft.autoAllow}
            onChange={(e) => setField('autoAllow', e.target.value)}
            placeholder="native_,mcp_filesystem_"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label="Deny-list tool prefixes"
          hint="Comma-separated. Always rejected regardless of mode (e.g. mcp_shell_)."
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
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bell className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">Notification Evaluator</h2>
        {draft.evalEnabled
          ? <Badge variant="success">on</Badge>
          : <Badge variant="outline">off</Badge>}
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">
        LLM gate that filters routine / empty agent-initiated push messages. Uses the
        <code> evaluator</code> role. Fail-open: LLM error or missing backend → message is delivered.
      </p>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field label="Enable gate">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.evalEnabled}
              onChange={(e) => setField('evalEnabled', e.target.checked)}
              className="h-4 w-4 accent-accent cursor-pointer"
            />
            <span>Filter via LLM</span>
          </label>
        </Field>
        <Field
          label="Sources to gate"
          hint="Comma-separated subset of: push, notify, reminder, heartbeat. Empty = default push,heartbeat."
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
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <HeartPulse className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">Heartbeat Scheduler</h2>
        {draft.hbEnabled
          ? <Badge variant="success">on</Badge>
          : <Badge variant="outline">off</Badge>}
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">
        Periodic proactive wake-up loop. With this off, <code>/heartbeat bind</code> still works
        (saves the binding) but no scans run. Three-phase tick: DECIDE → EXECUTE → EVALUATE.
      </p>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <Field label="Enable scheduler">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.hbEnabled}
              onChange={(e) => setField('hbEnabled', e.target.checked)}
              className="h-4 w-4 accent-accent cursor-pointer"
            />
            <span>Start scan loop</span>
          </label>
        </Field>
        <Field
          label="Tick interval (ms)"
          hint="How often the scan loop checks due bindings. Default 60000."
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
          label="Default binding interval (min)"
          hint="Minutes between ticks when a binding didn't specify one. Default 15."
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
