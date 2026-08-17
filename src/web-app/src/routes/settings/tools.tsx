/**
 * /settings/tools — Tools & Plugins manager.
 *
 * Operators checkbox-enable optional Agim Agent tool packs and external
 * MCP plugins. Enabled packs are advertised + described in the system
 * prompt on the next turn (live config). MCP toggles update
 * mcpServers[].enabled then reload the registry.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, Puzzle, RefreshCcw, Wrench } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useConfig, useUpdateConfig } from '@/hooks/use-settings'
import { useMcpList, useMcpReload } from '@/hooks/use-llm-admin'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'
import type { AppConfig } from '@/types/api'

type PackId = 'git' | 'codingGate' | 'web'

const PACKS: Array<{ id: PackId; tools: string }> = [
  { id: 'git', tools: 'agim_git_status / diff / log / add / commit' },
  { id: 'codingGate', tools: 'agim_diagnostics / test_run / quality_gate' },
  { id: 'web', tools: 'agim_web_fetch / web_search' },
]

/** UI defaults when toolPacks exists but a key is missing. */
const PACK_DEFAULTS: Record<PackId, boolean> = {
  git: true,
  codingGate: false,
  web: true,
}

function resolvePack(cfg: AppConfig | undefined, id: PackId): boolean {
  const packs = cfg?.toolPacks
  if (!packs || typeof packs !== 'object') {
    // Legacy: no toolPacks object → all on (matches backend).
    return true
  }
  const v = packs[id]
  return typeof v === 'boolean' ? v : PACK_DEFAULTS[id]
}

export default function SettingsToolsRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const cfgQuery = useConfig()
  const updateConfig = useUpdateConfig()
  const mcpQuery = useMcpList()
  const mcpReload = useMcpReload()

  const cfg = cfgQuery.data
  const busy = updateConfig.isPending || mcpReload.isPending

  const coreTools = useMemo(
    () => [
      t('tools.core.fs'),
      t('tools.core.exec'),
      t('tools.core.agim'),
      t('tools.core.todo'),
    ],
    [t],
  )

  async function setPack(id: PackId, enabled: boolean): Promise<void> {
    const prev = cfg?.toolPacks && typeof cfg.toolPacks === 'object' ? { ...cfg.toolPacks } : {
      git: true,
      codingGate: true,
      web: true,
    }
    // First explicit edit: materialize all keys so defaults stick.
    const next = {
      git: typeof prev.git === 'boolean' ? prev.git : PACK_DEFAULTS.git,
      codingGate: typeof prev.codingGate === 'boolean' ? prev.codingGate : PACK_DEFAULTS.codingGate,
      web: typeof prev.web === 'boolean' ? prev.web : PACK_DEFAULTS.web,
      [id]: enabled,
    }
    try {
      await updateConfig.mutateAsync({ toolPacks: next })
      toast.success(t('tools.savedToast'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  async function setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    const servers = (cfg?.mcpServers ?? []).map((s) => {
      if (s.name !== name) return s
      return { ...s, enabled }
    })
    try {
      await updateConfig.mutateAsync({ mcpServers: servers })
      await mcpReload.mutateAsync()
      toast.success(t('tools.mcpSavedToast'))
      void mcpQuery.refetch()
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  if (cfgQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-text-dim p-6">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common:states.loading')}
      </div>
    )
  }

  const mcpServers = cfg?.mcpServers ?? []
  const runtimeByName = new Map(
    (mcpQuery.data?.runtime?.servers ?? []).map((s) => [s.name, s]),
  )

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex items-start gap-3">
        <Wrench className="h-5 w-5 mt-1 text-text-dim" />
        <div>
          <h1 className="text-xl font-semibold">{t('tools.title')}</h1>
          <p className="mt-1 text-sm text-text-dim">{t('tools.subtitle')}</p>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-text-muted uppercase tracking-wide">
          {t('tools.coreHeading')}
        </h2>
        <div className="rounded-lg border border-border bg-surface/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium">{t('tools.coreTitle')}</p>
              <p className="mt-1 text-xs text-text-dim">{t('tools.coreHint')}</p>
              <ul className="mt-2 text-xs text-text-muted space-y-0.5 font-mono">
                {coreTools.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
            </div>
            <Badge variant="secondary">{t('tools.alwaysOn')}</Badge>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-text-muted uppercase tracking-wide">
          {t('tools.packsHeading')}
        </h2>
        <p className="text-xs text-text-dim">{t('tools.packsHint')}</p>
        <div className="flex flex-col gap-2">
          {PACKS.map((pack) => {
            const on = resolvePack(cfg, pack.id)
            return (
              <label
                key={pack.id}
                className={cn(
                  'flex items-start gap-3 rounded-lg border border-border p-4 cursor-pointer',
                  'hover:bg-surface/60',
                  on && 'border-accent/40 bg-accent/5',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-accent cursor-pointer"
                  checked={on}
                  disabled={busy}
                  onChange={(e) => void setPack(pack.id, e.target.checked)}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t(`tools.packs.${pack.id}.label`)}</span>
                    {on ? (
                      <Badge className="bg-success/15 text-success border-0">
                        {t('tools.enabled')}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">{t('tools.disabled')}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-text-dim">
                    {t(`tools.packs.${pack.id}.desc`)}
                  </p>
                  <p className="mt-1 text-xs font-mono text-text-muted truncate">
                    {pack.tools}
                  </p>
                </div>
              </label>
            )
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-text-muted uppercase tracking-wide flex items-center gap-2">
            <Puzzle className="h-4 w-4" />
            {t('tools.mcpHeading')}
          </h2>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={mcpReload.isPending}
              onClick={() => {
                void mcpReload.mutateAsync()
                  .then(() => toast.success(t('tools.mcpReloaded')))
                  .catch((err) => toast.error(describeError(err, t).message))
              }}
            >
              <RefreshCcw className={cn('h-3.5 w-3.5 mr-1', mcpReload.isPending && 'animate-spin')} />
              {t('tools.reloadMcp')}
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/settings/mcp">{t('tools.manageMcp')}</Link>
            </Button>
          </div>
        </div>
        <p className="text-xs text-text-dim">{t('tools.mcpHint')}</p>
        {mcpServers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-text-dim">
            {t('tools.mcpEmpty')}{' '}
            <Link className="text-accent underline" to="/settings/mcp">
              {t('tools.manageMcp')}
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {mcpServers.map((s) => {
              const enabled = s.enabled !== false
              const rt = runtimeByName.get(s.name)
              return (
                <label
                  key={s.name}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border border-border p-4 cursor-pointer',
                    'hover:bg-surface/60',
                    enabled && 'border-accent/40 bg-accent/5',
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-accent cursor-pointer"
                    checked={enabled}
                    disabled={busy}
                    onChange={(e) => void setMcpEnabled(s.name, e.target.checked)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium font-mono">{s.name}</span>
                      {enabled && rt?.connected ? (
                        <Badge className="bg-success/15 text-success border-0">
                          {t('tools.mcpConnected', { count: rt.toolCount })}
                        </Badge>
                      ) : enabled ? (
                        <Badge variant="secondary">{t('tools.mcpRuntimeUnknown')}</Badge>
                      ) : (
                        <Badge variant="secondary">{t('tools.disabled')}</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs font-mono text-text-muted truncate">
                      {s.command
                        ? `${s.command} ${(s.args ?? []).join(' ')}`.trim()
                        : s.url}
                    </p>
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
