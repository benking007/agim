/**
 * /settings/agents — built-in adapters + specialty profiles.
 *
 * PUT /api/config writes `agents[]`, `defaultAgent`, and `agentProfiles`
 * atomically so dispatch metadata stays consistent with the enabled list.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Bot, ChevronDown, Loader2, RefreshCcw, RotateCcw, Save, X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAgentsStatus } from '@/hooks/use-workspace'
import {
  useConfig,
  useUpdateConfig,
} from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import { agentDisplayName } from '@/lib/agent-label'
import { cn } from '@/lib/utils'
import type { AgentProfile } from '@/types/api'

/** Mirror of v1 settings.html:BUILTIN_AGENTS. Hardcoded because
 *  backend doesn't expose this metadata yet; the table changes
 *  rarely enough that copying it here is fine.
 *
 *  `kind` distinguishes spawn flavor:
 *    - 'cli'        → external CLI subprocess, needs `npm install -g <pkg>`
 *    - 'in-process' → runs inside agim, no install needed; `pkg` carries
 *                     a one-liner hint instead of an install command.
 *                     Honours `config.agents` like CLI agents (boot
 *                     migrates legacy lists that omitted `native`). */
interface BuiltinAgentInfo {
  aliases: string[]
  pkg: string
  kind: 'cli' | 'in-process'
  scope: 'bridged' | 'agim'
}

const BUILTIN_AGENTS = {
  'claude-code': { aliases: ['cc', 'claude'],    pkg: '@anthropic-ai/claude-code', kind: 'cli', scope: 'bridged' },
  'codex':       { aliases: ['cx'],              pkg: '@openai/codex',             kind: 'cli', scope: 'bridged' },
  'copilot':     { aliases: ['co', 'gh-copilot', 'github-copilot'], pkg: '@github/copilot', kind: 'cli', scope: 'bridged' },
  'opencode':    { aliases: ['oc'],              pkg: 'opencode-ai',               kind: 'cli', scope: 'bridged' },
  'antigravity': { aliases: ['agy', 'gemini', 'ag'], pkg: 'agy (curl https://antigravity.google/cli/install.sh)', kind: 'cli', scope: 'bridged' },
  'cursor':      { aliases: ['cs', 'cur'],       pkg: 'cursor-agent (curl https://cursor.com/install)', kind: 'cli', scope: 'bridged' },
  'kimi-code':   { aliases: ['kimi', 'km'],      pkg: '@moonshot-ai/kimi-code',    kind: 'cli', scope: 'bridged' },
  'qoder':       { aliases: ['qd', 'qodercli'],  pkg: 'qodercli (curl https://qoder.com/install)', kind: 'cli', scope: 'bridged' },
  'pi':          { aliases: ['pi-agent'],        pkg: '@earendil-works/pi-coding-agent', kind: 'cli', scope: 'bridged' },
  'mimo':        { aliases: ['mo', 'mimo-code'], pkg: '@mimo-ai/cli',              kind: 'cli', scope: 'bridged' },
  // v1.2.140 — surface the in-process `native` agent in the admin list.
  // Previously the agent was registered + always-enabled at runtime but
  // hidden from this page, so operators could only reach it via the CLI.
  'agim':        { aliases: ['native', 'na', 'llm', 'native-llm', 'agim-agent'], pkg: 'in-process', kind: 'in-process', scope: 'agim' },
} satisfies Record<string, BuiltinAgentInfo>

type BuiltinAgentName = keyof typeof BUILTIN_AGENTS
const AGENT_NAMES = Object.keys(BUILTIN_AGENTS) as BuiltinAgentName[]
const BRIDGED_AGENT_NAMES = AGENT_NAMES.filter((name) => BUILTIN_AGENTS[name]?.scope === 'bridged')

export default function SettingsAgentsRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const cfgQuery = useConfig()
  const statusQuery = useAgentsStatus()
  const updateCfg = useUpdateConfig()

  const cfg = cfgQuery.data
  const status = statusQuery.data ?? {}

  /** Local draft so toggles + default-picker can stage
   *  changes before a single Save. `null` means "sync from cfg on
   *  next paint". */
  const [draftEnabled, setDraftEnabled] = useState<string[] | null>(null)
  const [draftDefault, setDraftDefault] = useState<string | null>(null)
  const [draftProfiles, setDraftProfiles] = useState<Record<string, AgentProfile> | null>(null)
  const [openProfile, setOpenProfile] = useState<string | null>(null)

  useEffect(() => {
    if (cfg && draftEnabled == null) setDraftEnabled(cfg.agents ?? [])
    if (cfg && draftDefault == null) setDraftDefault(cfg.defaultAgent ?? '')
    if (cfg && draftProfiles == null) {
      setDraftProfiles({ ...(cfg.agentProfiles ?? {}) })
    }
  }, [cfg, draftEnabled, draftDefault, draftProfiles])

  const enabled = draftEnabled ?? cfg?.agents ?? []
  const defaultAgent = draftDefault ?? cfg?.defaultAgent ?? ''
  const profiles = draftProfiles ?? cfg?.agentProfiles ?? {}
  const defaults = cfg?.agentProfileDefaults ?? {}

  const isDirty = useMemo(() => {
    if (!cfg) return false
    const enabledSame =
      enabled.length === (cfg.agents?.length ?? 0)
      && enabled.every((a) => cfg.agents?.includes(a))
    const defaultSame = defaultAgent === (cfg.defaultAgent ?? '')
    const profilesSame = JSON.stringify(profiles) === JSON.stringify(cfg.agentProfiles ?? {})
    return !enabledSame || !defaultSame || !profilesSame
  }, [cfg, enabled, defaultAgent, profiles])

  /** Eligible defaults = installed + enabled. Picker disables when
   *  empty (no agent is both). In-process `native` follows the same
   *  enabled-list rule as CLI agents. */
  const eligibleDefaults = useMemo(
    () => AGENT_NAMES.filter((a) => enabled.includes(a) && status[a]),
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

  function updateProfile(name: string, next: AgentProfile): void {
    setDraftProfiles((prev) => ({
      ...(prev ?? cfg?.agentProfiles ?? {}),
      [name]: next,
    }))
  }

  function resetProfile(name: string): void {
    const def = defaults[name]
    if (!def) return
    updateProfile(name, {
      summary: def.summary,
      strengths: [...def.strengths],
      avoid: [...def.avoid],
      tags: [...def.tags],
    })
  }

  async function onSave(): Promise<void> {
    if (!cfg) return
    try {
      await updateCfg.mutateAsync({
        ...cfg,
        agents: enabled,
        defaultAgent: defaultAgent || cfg.defaultAgent,
        agentProfiles: profiles,
      })
      toast.success(t('agents.toast.saved'))
      // Reset drafts so the next paint reads from refreshed cfg.
      setDraftEnabled(null)
      setDraftDefault(null)
      setDraftProfiles(null)
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  function onDiscard(): void {
    setDraftEnabled(null)
    setDraftDefault(null)
    setDraftProfiles(null)
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
              const info = BUILTIN_AGENTS[name]
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
            <DefaultAgentPicker
              value={defaultAgent}
              options={eligibleDefaults}
              placeholder={t('agents.noEligible')}
              onChange={setDraftDefault}
            />
          </section>

          {/* Specialty profiles for call_agents / Loop */}
          <section className="rounded-md border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold">{t('agents.profiles.title')}</h3>
            <p className="mt-1 text-xs text-text-dim">{t('agents.profiles.subtitle')}</p>
            <div className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
              {BRIDGED_AGENT_NAMES.map((name) => {
                const profile = profiles[name] ?? defaults[name] ?? {
                  summary: '', strengths: [], avoid: [], tags: [],
                }
                const def = defaults[name]
                const customized = def
                  ? JSON.stringify(profile) !== JSON.stringify(def)
                  : false
                const open = openProfile === name
                return (
                  <div key={`profile-${name}`} className="bg-surface">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-2/60"
                      onClick={() => setOpenProfile(open ? null : name)}
                      aria-expanded={open}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {agentDisplayName(name)}
                      </span>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {customized
                          ? t('agents.profiles.customized')
                          : t('agents.profiles.defaultBadge')}
                      </Badge>
                      <ChevronDown className={cn(
                        'h-4 w-4 shrink-0 text-text-dim transition-transform',
                        open && 'rotate-180',
                      )} />
                    </button>
                    {open ? (
                      <ProfileEditor
                        profile={profile}
                        onChange={(next) => updateProfile(name, next)}
                        onReset={def ? () => resetProfile(name) : undefined}
                      />
                    ) : (
                      <p className="px-3 pb-2.5 text-xs text-text-dim line-clamp-2">
                        {profile.summary || '—'}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

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

interface DefaultAgentPickerProps {
  value: string
  options: string[]
  placeholder: string
  onChange: (value: string) => void
}

function DefaultAgentPicker({
  value,
  options,
  placeholder,
  onChange,
}: DefaultAgentPickerProps): JSX.Element {
  const disabled = options.length === 0
  const selectedValue = value && options.includes(value) ? value : undefined

  return (
    <Select
      value={selectedValue ?? ''}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger id="default-agent" className="mt-2 h-10 w-64 max-w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((agent) => (
          <SelectItem key={agent} value={agent}>
            {agentDisplayName(agent)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

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

function linesToList(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function listToLines(list: string[]): string {
  return list.join('\n')
}

function ProfileEditor({
  profile,
  onChange,
  onReset,
}: {
  profile: AgentProfile
  onChange: (next: AgentProfile) => void
  onReset?: () => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  const fieldClass = cn(
    'mt-1 w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm',
    'text-text outline-none focus:border-accent',
  )
  return (
    <div className="space-y-2.5 border-t border-border px-3 py-3">
      <label className="block">
        <span className="text-[11px] font-medium text-text-dim">{t('agents.profiles.summary')}</span>
        <textarea
          className={cn(fieldClass, 'min-h-[3.5rem] resize-y')}
          value={profile.summary}
          onChange={(e) => onChange({ ...profile, summary: e.target.value })}
          rows={2}
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-medium text-text-dim">{t('agents.profiles.strengths')}</span>
        <textarea
          className={cn(fieldClass, 'min-h-[5rem] resize-y font-mono text-xs')}
          value={listToLines(profile.strengths)}
          onChange={(e) => onChange({ ...profile, strengths: linesToList(e.target.value) })}
          rows={4}
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-medium text-text-dim">{t('agents.profiles.avoid')}</span>
        <textarea
          className={cn(fieldClass, 'min-h-[4rem] resize-y font-mono text-xs')}
          value={listToLines(profile.avoid)}
          onChange={(e) => onChange({ ...profile, avoid: linesToList(e.target.value) })}
          rows={3}
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-medium text-text-dim">{t('agents.profiles.tags')}</span>
        <input
          className={cn(fieldClass, 'font-mono text-xs')}
          value={profile.tags.join(', ')}
          onChange={(e) => onChange({
            ...profile,
            tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          })}
        />
      </label>
      {onReset ? (
        <div className="flex justify-end pt-0.5">
          <Button type="button" size="sm" variant="ghost" onClick={onReset} className="gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" />
            {t('agents.profiles.reset')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

