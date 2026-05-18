/**
 * /settings/agents — built-in agent adapter enable/disable + default
 * agent picker. Mirrors the v1 settings.html "Agents" card.
 *
 * Data sources:
 *   * BUILTIN_AGENTS const (alias + install package, hardcoded here
 *     as a 4-entry table that mirrors v1's same const; agim doesn't
 *     expose this metadata via an endpoint yet)
 *   * useAgentsStatus → `{ <agent>: online }` for the green dot
 *   * useConfig → `agents[]` (enabled list) + `defaultAgent`
 *
 * Save batches both `agents[]` and `defaultAgent` into one PUT
 * /api/config so the default doesn't get out of sync with the
 * enabled list (e.g. saving with a disabled agent as default would
 * break routing on the next message).
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bot, Loader2, RefreshCcw, Save, X } from 'lucide-react'

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
import { useConfig, useUpdateConfig } from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

/** Mirror of v1 settings.html:BUILTIN_AGENTS. Hardcoded because
 *  backend doesn't expose this metadata yet; the table changes
 *  rarely enough that copying it here is fine. */
const BUILTIN_AGENTS: Record<string, { aliases: string[]; pkg: string }> = {
  'claude-code': { aliases: ['cc', 'claude'], pkg: '@anthropic-ai/claude-code' },
  'codex':       { aliases: ['cx'],           pkg: '@openai/codex' },
  'copilot':     { aliases: ['co'],           pkg: '@github/copilot' },
  'opencode':    { aliases: ['oc'],           pkg: 'opencode-ai' },
}

const AGENT_NAMES = Object.keys(BUILTIN_AGENTS)

export default function SettingsAgentsRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const cfgQuery = useConfig()
  const statusQuery = useAgentsStatus()
  const updateCfg = useUpdateConfig()

  const cfg = cfgQuery.data
  const status = statusQuery.data ?? {}

  /** Local draft so toggles + default-picker can stage changes
   *  before a single Save. `null` means "sync from cfg on next paint". */
  const [draftEnabled, setDraftEnabled] = useState<string[] | null>(null)
  const [draftDefault, setDraftDefault] = useState<string | null>(null)

  useEffect(() => {
    if (cfg && draftEnabled == null) setDraftEnabled(cfg.agents ?? [])
    if (cfg && draftDefault == null) setDraftDefault(cfg.defaultAgent ?? '')
  }, [cfg, draftEnabled, draftDefault])

  const enabled = draftEnabled ?? cfg?.agents ?? []
  const defaultAgent = draftDefault ?? cfg?.defaultAgent ?? ''

  const isDirty = useMemo(() => {
    if (!cfg) return false
    const enabledSame =
      enabled.length === (cfg.agents?.length ?? 0)
      && enabled.every((a) => cfg.agents?.includes(a))
    const defaultSame = defaultAgent === (cfg.defaultAgent ?? '')
    return !enabledSame || !defaultSame
  }, [cfg, enabled, defaultAgent])

  /** Eligible defaults = installed + enabled. Picker disables when
   *  empty (no agent is both). */
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

  async function onSave(): Promise<void> {
    if (!cfg) return
    try {
      await updateCfg.mutateAsync({
        ...cfg,
        agents: enabled,
        defaultAgent: defaultAgent || cfg.defaultAgent,
      })
      toast.success(t('agents.toast.saved'))
      // Reset drafts so the next paint reads from refreshed cfg.
      setDraftEnabled(null)
      setDraftDefault(null)
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  function onDiscard(): void {
    setDraftEnabled(null)
    setDraftDefault(null)
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
            {AGENT_NAMES.map((name) => {
              const info = BUILTIN_AGENTS[name]!
              const installed = !!status[name]
              const isEnabled = enabled.includes(name)
              return (
                <AgentRow
                  key={name}
                  name={name}
                  aliases={info.aliases}
                  pkg={info.pkg}
                  installed={installed}
                  enabled={isEnabled}
                  onToggle={(on) => toggleAgent(name, on)}
                />
              )
            })}
          </div>

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
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
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

interface AgentRowProps {
  name: string
  aliases: string[]
  pkg: string
  installed: boolean
  enabled: boolean
  onToggle: (on: boolean) => void
}

function AgentRow({
  name, aliases, pkg, installed, enabled, onToggle,
}: AgentRowProps): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="flex items-start gap-3 px-3 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-dim">
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text">{name}</span>
          <Badge variant={installed ? 'success' : 'outline'} className="text-[10px]">
            <span className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              installed ? 'bg-success' : 'bg-text-muted',
            )} />
            {installed ? t('agents.online') : t('agents.offline')}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-text-dim">
          <span className="text-text-muted">{t('agents.aliasesLabel')}: </span>
          <span className="font-mono">{aliases.map((a) => `/${a}`).join(', ')}</span>
        </p>
        {!installed && (
          <p className="mt-1 text-xs text-warning">
            {t('agents.installHint', { pkg })}
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
