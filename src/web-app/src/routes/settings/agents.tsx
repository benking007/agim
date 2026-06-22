/**
 * /settings/agents — built-in adapters + remote (ACP) agents.
 *
 * Two cards on one page:
 *   1. Built-in adapters (claude-code / codex / opencode):
 *      enable/disable + default-agent picker. Mirrors v1's "Agents".
 *   2. Remote (ACP) agents: name/endpoint/auth-type table + manual
 *      add form. Mirrors v1's "Remote Agents (ACP)" card. Discover
 *      via `<baseUrl>/.well-known/acp` is available as a secondary
 *      bulk-import form.
 *
 * Both cards share one save bar — PUT /api/config writes `agents[]`,
 * `defaultAgent`, and `acpAgents[]` atomically so the default never
 * goes out of sync with the enabled list, and partial ACP edits
 * don't ship without the user's intent.
 *
 * Masked tokens: GET returns `ab****yz` for ACP auth.token; PUT
 * detects this pattern and preserves the on-disk value so we never
 * overwrite a real token with its mask. New tokens (typed into the
 * add form or "edit" inline) flow through verbatim.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Bot, Loader2, Network, Plus, RefreshCcw, Save, Search, Trash2, X,
} from 'lucide-react'

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
import { EmptyState } from '@/components/common/empty-state'
import { useAgentsStatus } from '@/hooks/use-workspace'
import {
  useConfig,
  useDiscoverAcp,
  useTestAcp,
  useUpdateConfig,
} from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import { agentDisplayName } from '@/lib/agent-label'
import { cn } from '@/lib/utils'
import type { ACPAgentConfig, ACPAuthConfig, ACPAuthType } from '@/types/api'

/** Mirror of v1 settings.html:BUILTIN_AGENTS. Hardcoded because
 *  backend doesn't expose this metadata yet; the table changes
 *  rarely enough that copying it here is fine.
 *
 *  `kind` distinguishes spawn flavor:
 *    - 'cli'        → external CLI subprocess, needs `npm install -g <pkg>`
 *    - 'in-process' → runs inside agim, no install needed; `pkg` carries
 *                     a one-liner hint instead of an install command. The
 *                     runtime always exposes it via `isAgentEnabled`
 *                     regardless of config.agents, so default-picker
 *                     eligibility ignores the enabled-list constraint. */
const BUILTIN_AGENTS: Record<string, {
  aliases: string[]
  pkg: string
  kind: 'cli' | 'in-process'
  scope: 'bridged' | 'agim'
}> = {
  'claude-code': { aliases: ['cc', 'claude'],    pkg: '@anthropic-ai/claude-code', kind: 'cli', scope: 'bridged' },
  'codex':       { aliases: ['cx'],              pkg: '@openai/codex',             kind: 'cli', scope: 'bridged' },
  'opencode':    { aliases: ['oc'],              pkg: 'opencode-ai',               kind: 'cli', scope: 'bridged' },
  'cursor':      { aliases: ['cs', 'cur'],       pkg: 'cursor-agent (curl https://cursor.com/install)', kind: 'cli', scope: 'bridged' },
  // v1.2.140 — surface the in-process `native` agent in the admin list.
  // Previously the agent was registered + always-enabled at runtime but
  // hidden from this page, so operators could only reach it via the CLI.
  'native':      { aliases: ['agim', 'na', 'llm', 'native-llm'], pkg: 'in-process', kind: 'in-process', scope: 'agim' },
}

const AGENT_NAMES = Object.keys(BUILTIN_AGENTS)
const BRIDGED_AGENT_NAMES = AGENT_NAMES.filter((name) => BUILTIN_AGENTS[name]?.scope === 'bridged')

export default function SettingsAgentsRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const cfgQuery = useConfig()
  const statusQuery = useAgentsStatus()
  const updateCfg = useUpdateConfig()

  const cfg = cfgQuery.data
  const status = statusQuery.data ?? {}

  /** Local draft so toggles + default-picker + ACP edits can stage
   *  changes before a single Save. `null` means "sync from cfg on
   *  next paint". */
  const [draftEnabled, setDraftEnabled] = useState<string[] | null>(null)
  const [draftDefault, setDraftDefault] = useState<string | null>(null)
  const [draftAcp, setDraftAcp] = useState<ACPAgentConfig[] | null>(null)

  useEffect(() => {
    if (cfg && draftEnabled == null) setDraftEnabled(cfg.agents ?? [])
    if (cfg && draftDefault == null) setDraftDefault(cfg.defaultAgent ?? '')
    if (cfg && draftAcp == null) setDraftAcp(cfg.acpAgents ?? [])
  }, [cfg, draftEnabled, draftDefault, draftAcp])

  const enabled = draftEnabled ?? cfg?.agents ?? []
  const defaultAgent = draftDefault ?? cfg?.defaultAgent ?? ''
  const acpAgents = draftAcp ?? cfg?.acpAgents ?? []

  const isDirty = useMemo(() => {
    if (!cfg) return false
    const enabledSame =
      enabled.length === (cfg.agents?.length ?? 0)
      && enabled.every((a) => cfg.agents?.includes(a))
    const defaultSame = defaultAgent === (cfg.defaultAgent ?? '')
    const acpSame = acpEqual(acpAgents, cfg.acpAgents ?? [])
    return !enabledSame || !defaultSame || !acpSame
  }, [cfg, enabled, defaultAgent, acpAgents])

  /** Eligible defaults = installed + enabled. Picker disables when
   *  empty (no agent is both).
   *
   *  v1.2.140 — in-process agents (e.g. `native`) are exempt from the
   *  enabled-list check. Runtime `isAgentEnabled('native')` always
   *  returns true regardless of config.agents (see live-config.ts), so
   *  the picker should mirror that and not require the user to flip the
   *  toggle on first. */
  const eligibleDefaults = useMemo(
    () => AGENT_NAMES.filter((a) => {
      const info = BUILTIN_AGENTS[a]!
      const enabledOrInProcess = info.kind === 'in-process' ? true : enabled.includes(a)
      return enabledOrInProcess && status[a]
    }),
    [enabled, status],
  )

  function toggleAgent(name: string, on: boolean): void {
    const next = on
      ? Array.from(new Set([...enabled, name]))
      : enabled.filter((a) => a !== name)
    setDraftEnabled(next)
    // If the default just got disabled, clear it so save doesn't
    // ship an inconsistent pair.
    if (!on && name === defaultAgent) setDraftDefault('')
  }

  async function onSave(): Promise<void> {
    if (!cfg) return
    try {
      await updateCfg.mutateAsync({
        ...cfg,
        agents: enabled,
        defaultAgent: defaultAgent || cfg.defaultAgent,
        acpAgents,
      })
      toast.success(t('agents.toast.saved'))
      // Reset drafts so the next paint reads from refreshed cfg.
      setDraftEnabled(null)
      setDraftDefault(null)
      setDraftAcp(null)
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  function onDiscard(): void {
    setDraftEnabled(null)
    setDraftDefault(null)
    setDraftAcp(null)
  }

  function updateAcp(next: ACPAgentConfig[]): void {
    setDraftAcp(next)
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('agents.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              void cfgQuery.refetch()
              void statusQuery.refetch()
            }}
            disabled={cfgQuery.isFetching || statusQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {(cfgQuery.isFetching || statusQuery.isFetching)
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('agents.subtitle')}</p>
      </header>

      {cfgQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          {/* Agent rows */}
          <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
            {BRIDGED_AGENT_NAMES.map((name) => {
              const info = BUILTIN_AGENTS[name]!
              const installed = !!status[name]
              const isEnabled = enabled.includes(name)
              return (
                <AgentRow
                  key={name}
                  displayName={agentDisplayName(name)}
                  aliases={info.aliases}
                  pkg={info.pkg}
                  kind={info.kind}
                  installed={installed}
                  enabled={isEnabled}
                  onToggle={(on) => toggleAgent(name, on)}
                />
              )
            })}
          </div>

          <section className="rounded-md border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold">{t('agents.agimAgentCardTitle')}</h3>
            <p className="mt-1 text-xs text-text-dim">{t('agents.agimAgentCardDesc')}</p>
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              onClick={() => { window.location.assign('/settings/llm') }}
            >
              {t('agents.agimAgentCardAction')}
            </Button>
          </section>

          {/* Default agent picker */}
          <section className="rounded-md border border-border bg-surface p-4">
            <Label htmlFor="default-agent" className="text-sm font-medium">
              {t('agents.defaultAgent')}
            </Label>
            <p className="mt-1 text-xs text-text-dim">{t('agents.defaultAgentHint')}</p>
            <Select
              value={defaultAgent || '__none__'}
              onValueChange={(v) => setDraftDefault(v === '__none__' ? '' : v)}
              disabled={eligibleDefaults.length === 0}
            >
              <SelectTrigger id="default-agent" className="mt-2 w-64">
                <SelectValue placeholder={t('agents.noEligible')} />
              </SelectTrigger>
              <SelectContent>
                {eligibleDefaults.length === 0 ? (
                  <SelectItem value="__none__" disabled>{t('agents.noEligible')}</SelectItem>
                ) : (
                  eligibleDefaults.map((a) => (
                    <SelectItem key={a} value={a}>{agentDisplayName(a)}</SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </section>

          {/* Remote (ACP) agents — gated by features.remoteAgent
              (IMHUB_ENABLE_REMOTE_AGENT on server). Card is omitted
              entirely; no breadcrumb hint shown. */}
          {cfg?.features?.remoteAgent ? (
            <AcpCard
              agents={acpAgents}
              onChange={updateAcp}
            />
          ) : null}

          {/* Save bar */}
          {isDirty && (
            <div className="sticky bottom-0 flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-2 shadow-md">
              <Badge variant="info">{t('agents.dirtyHint')}</Badge>
              <Button
                variant="secondary"
                size="sm"
                onClick={onDiscard}
                disabled={updateCfg.isPending}
              >
                <X className="h-4 w-4" />
                {t('agents.discard')}
              </Button>
              <Button
                size="sm"
                onClick={() => void onSave()}
                disabled={updateCfg.isPending}
              >
                {updateCfg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {updateCfg.isPending ? t('agents.saving') : t('agents.saveBtn')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ─────────────── Row ─────────────── */

interface AgentRowProps {
  displayName: string
  aliases: string[]
  pkg: string
  /** v1.2.140 — 'in-process' agents show a different "not installed"
   *  hint (point at LLM-backend config rather than `npm install -g`)
   *  and surface a small "内置" badge so operators understand they
   *  don't need to install anything. */
  kind: 'cli' | 'in-process'
  installed: boolean
  enabled: boolean
  onToggle: (on: boolean) => void
}

function AgentRow({
  displayName, aliases, pkg, kind, installed, enabled, onToggle,
}: AgentRowProps): JSX.Element {
  const { t } = useTranslation('settings')
  const inProcess = kind === 'in-process'
  return (
    <div className="flex items-start gap-3 px-3 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-dim">
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text">{displayName}</span>
          <Badge variant={installed ? 'success' : 'outline'} className="text-[10px]">
            <span className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              installed ? 'bg-success' : 'bg-text-muted',
            )} />
            {installed ? t('agents.online') : t('agents.offline')}
          </Badge>
          {inProcess && (
            <Badge variant="outline" className="text-[10px]" title={t('agents.inProcessHint')}>
              {t('agents.inProcessBadge')}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-text-dim">
          <span className="text-text-muted">{t('agents.aliasesLabel')}: </span>
          <span className="font-mono">{aliases.map((a) => `/${a}`).join(', ')}</span>
        </p>
        {!installed && (
          <p className="mt-1 text-xs text-warning">
            {inProcess
              ? t('agents.nativeInstallHint')
              : t('agents.installHint', { pkg })}
          </p>
        )}
      </div>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4 mt-2 accent-accent cursor-pointer"
      />
    </div>
  )
}

/* ─────────────── Remote (ACP) ─────────────── */

const AUTH_TYPES: ACPAuthType[] = ['none', 'apikey', 'bearer']
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Compare two ACP lists by value. Order matters because the backend
 *  preserves index identity (`existing.acpAgents[i]`) when merging
 *  masked tokens — reordering = mask drift risk. */
function acpEqual(a: ACPAgentConfig[], b: ACPAgentConfig[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.name !== y.name) return false
    if (x.endpoint !== y.endpoint) return false
    if ((x.enabled ?? true) !== (y.enabled ?? true)) return false
    const xa = (x.aliases ?? []).join(',')
    const ya = (y.aliases ?? []).join(',')
    if (xa !== ya) return false
    const xat = x.auth?.type ?? 'none'
    const yat = y.auth?.type ?? 'none'
    if (xat !== yat) return false
    if ((x.auth?.token ?? '') !== (y.auth?.token ?? '')) return false
  }
  return true
}

interface AcpCardProps {
  agents: ACPAgentConfig[]
  onChange: (next: ACPAgentConfig[]) => void
}

function AcpCard({ agents, onChange }: AcpCardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const testMut = useTestAcp()
  const discoverMut = useDiscoverAcp()

  // Add-form state. We keep the typed token in plain state so the
  // user can paste before save; the masked round-trip from backend
  // only matters for existing rows.
  const [name, setName] = useState('')
  const [aliasesText, setAliasesText] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [authType, setAuthType] = useState<ACPAuthType>('none')
  const [token, setToken] = useState('')

  // Bulk-discover sub-form state. Hidden behind a toggle so the
  // primary path (manual add) stays uncluttered.
  const [showDiscover, setShowDiscover] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')

  const trimmedName = name.trim()
  const nameValid = trimmedName.length > 0 && NAME_RE.test(trimmedName)
  const dup = agents.some((a) => a.name === trimmedName)
  const tokenRequired = authType !== 'none'
  const tokenOk = !tokenRequired || token.trim().length > 0
  const canAdd = nameValid && endpoint.trim().length > 0 && tokenOk && !dup
  const canTestNew = endpoint.trim().length > 0 && tokenOk

  function clearForm(): void {
    setName('')
    setAliasesText('')
    setEndpoint('')
    setAuthType('none')
    setToken('')
  }

  function parseAliases(text: string): string[] {
    return text.split(',').map((s) => s.trim()).filter(Boolean)
  }

  function buildAuth(type: ACPAuthType, tok: string): ACPAuthConfig | undefined {
    if (type === 'none') return { type: 'none' }
    const trimmed = tok.trim()
    if (!trimmed) return { type } // no token yet; save will reject
    return { type, token: trimmed }
  }

  async function onAdd(): Promise<void> {
    if (!canAdd) return
    const next: ACPAgentConfig = {
      name: trimmedName,
      endpoint: endpoint.trim(),
      aliases: parseAliases(aliasesText),
      auth: buildAuth(authType, token),
      enabled: true,
    }
    onChange([...agents, next])
    clearForm()
    toast.success(t('agents.acp.toast.staged'))
  }

  async function onTestNew(): Promise<void> {
    if (!canTestNew) return
    try {
      const res = await testMut.mutateAsync({
        endpoint: endpoint.trim(),
        auth: buildAuth(authType, token),
      })
      toast.success(t('agents.acp.toast.testOk', { name: res.name }))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  async function onTestRow(idx: number): Promise<void> {
    const a = agents[idx]
    if (!a) return
    // Masked tokens stay masked on the wire — backend's PUT mask-detect
    // is symmetric, but the test endpoint reads what we send. We can't
    // unmask client-side; warn the operator.
    if (a.auth?.type !== 'none' && a.auth?.token && isMaskedToken(a.auth.token)) {
      toast.error(t('agents.acp.toast.testMasked'))
      return
    }
    try {
      const res = await testMut.mutateAsync({
        endpoint: a.endpoint,
        auth: a.auth,
      })
      toast.success(t('agents.acp.toast.testOk', { name: res.name }))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  function onToggleRow(idx: number, on: boolean): void {
    const next = agents.map((a, i) => (i === idx ? { ...a, enabled: on } : a))
    onChange(next)
  }

  function onRemoveRow(idx: number): void {
    onChange(agents.filter((_, i) => i !== idx))
  }

  async function onDiscoverRun(): Promise<void> {
    const url = baseUrl.trim()
    if (!url) return
    try {
      const res = await discoverMut.mutateAsync({ baseUrl: url, register: false })
      // Stage new agents that aren't already in the list (by name).
      const existing = new Set(agents.map((a) => a.name))
      const incoming = res.agents.filter((a) => !existing.has(a.name))
      if (incoming.length === 0) {
        toast.info(t('agents.acp.toast.discoverEmpty'))
        return
      }
      onChange([...agents, ...incoming.map((a) => ({ ...a, enabled: true }))])
      toast.success(t('agents.acp.toast.discoverAdded', { count: incoming.length }))
      setBaseUrl('')
      setShowDiscover(false)
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Network className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('agents.acp.title')}</h2>
        <Badge variant="outline" className="text-[10px]">{agents.length}</Badge>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setShowDiscover((v) => !v)}
        >
          <Search className="h-4 w-4" />
          <span className="hidden sm:inline">{t('agents.acp.discoverBtn')}</span>
        </Button>
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('agents.acp.subtitle')}</p>

      {/* Discover form (collapsed by default) */}
      {showDiscover && (
        <div className="border-t border-border bg-surface-2 px-4 py-3">
          <Label htmlFor="acp-baseurl" className="text-xs font-medium">
            {t('agents.acp.baseUrl')}
          </Label>
          <p className="mt-1 text-[11px] text-text-dim">{t('agents.acp.baseUrlHint')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Input
              id="acp-baseurl"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://agents.example.com"
              className="flex-1 min-w-[200px] font-mono text-xs"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onDiscoverRun()}
              disabled={!baseUrl.trim() || discoverMut.isPending}
            >
              {discoverMut.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Search className="h-4 w-4" />}
              {t('agents.acp.runDiscover')}
            </Button>
          </div>
        </div>
      )}

      {/* Registered ACP agents */}
      {agents.length === 0 ? (
        <div className="px-4 py-6">
          <EmptyState
            icon={<Network />}
            title={t('agents.acp.empty.title')}
            description={t('agents.acp.empty.description')}
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {agents.map((a, i) => (
            <AcpRow
              key={`${a.name}-${i}`}
              agent={a}
              onToggle={(on) => onToggleRow(i, on)}
              onTest={() => void onTestRow(i)}
              onRemove={() => onRemoveRow(i)}
              testing={testMut.isPending}
            />
          ))}
        </ul>
      )}

      {/* Add-agent form */}
      <div className="border-t border-border px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-dim">
          {t('agents.acp.addTitle')}
        </h3>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label={t('agents.acp.name')} hint={t('agents.acp.nameHint')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-agent"
              aria-invalid={name.length > 0 && !nameValid}
            />
          </Field>
          <Field label={t('agents.acp.aliases')} hint={t('agents.acp.aliasesHint')}>
            <Input
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="ma, agent1"
            />
          </Field>
          <Field label={t('agents.acp.endpoint')} hint={t('agents.acp.endpointHint')}>
            <Input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://example.com/agents/weather"
              className="font-mono text-xs"
            />
          </Field>
          <Field label={t('agents.acp.authType')}>
            <Select value={authType} onValueChange={(v) => setAuthType(v as ACPAuthType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {AUTH_TYPES.map((a) => (
                  <SelectItem key={a} value={a}>{t(`agents.acp.auth.${a}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {authType !== 'none' && (
            <Field label={t('agents.acp.token')} className="sm:col-span-2">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t('agents.acp.tokenPlaceholder')}
                autoComplete="new-password"
              />
            </Field>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onTestNew()}
            disabled={!canTestNew || testMut.isPending}
          >
            {testMut.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Search className="h-4 w-4" />}
            {t('agents.acp.testBtn')}
          </Button>
          <Button
            size="sm"
            onClick={() => void onAdd()}
            disabled={!canAdd}
          >
            <Plus className="h-4 w-4" />
            {t('agents.acp.addBtn')}
          </Button>
          {dup && (
            <span className="self-center text-xs text-warning">
              {t('agents.acp.dupName')}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

interface AcpRowProps {
  agent: ACPAgentConfig
  onToggle: (on: boolean) => void
  onTest: () => void
  onRemove: () => void
  testing: boolean
}

function AcpRow({ agent, onToggle, onTest, onRemove, testing }: AcpRowProps): JSX.Element {
  const { t } = useTranslation('settings')
  const isOn = agent.enabled !== false
  const authType = agent.auth?.type ?? 'none'
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text">{agent.name}</span>
          <Badge variant="outline" className="text-[10px] uppercase">
            {t(`agents.acp.auth.${authType}`)}
          </Badge>
          {agent.aliases && agent.aliases.length > 0 && (
            <span className="text-xs text-text-muted font-mono">
              {agent.aliases.map((a) => `/${a}`).join(', ')}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-text-dim" title={agent.endpoint}>
          {agent.endpoint}
        </p>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-text-dim">
        <input
          type="checkbox"
          checked={isOn}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 accent-accent cursor-pointer"
        />
        {isOn ? t('agents.acp.on') : t('agents.acp.off')}
      </label>
      <Button
        variant="ghost"
        size="sm"
        onClick={onTest}
        disabled={testing}
        aria-label={t('agents.acp.testBtn')}
      >
        {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        aria-label={t('agents.acp.removeBtn')}
        className="text-danger hover:text-danger"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  )
}

interface FieldProps {
  label: string
  hint?: string
  className?: string
  children: React.ReactNode
}

function Field({ label, hint, className, children }: FieldProps): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-text-dim">{hint}</p>}
    </div>
  )
}

/** Tokens look like `ab****yz` from the masked GET response. We
 *  shouldn't send them back unchanged for test (the backend would
 *  fail auth), and we shouldn't include them in the test mutation
 *  body either. Treat any string with 3+ consecutive `*` as masked. */
function isMaskedToken(s: string): boolean {
  return /\*{3,}/.test(s)
}
