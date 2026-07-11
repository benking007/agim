/**
 * /observability/audit — recent invocations timeline. URL state for
 * the four filter slots (agent / platform / user / intent) so deep-
 * linking works; layout's ?days= window applies too.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, Loader2, RefreshCcw } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAudit } from '@/hooks/use-observability'
import type { InvocationRow, ListAuditQuery } from '@/types/api'
import { cn } from '@/lib/utils'

const SEARCH_DEBOUNCE_MS = 300

export default function ObservabilityAuditRoute(): JSX.Element {
  const { t } = useTranslation(['observability', 'common'])
  const [params, setParams] = useSearchParams()
  const days = Math.max(1, Number(params.get('days')) || 7)

  const agent    = params.get('agent') ?? ''
  const platform = params.get('platform') ?? ''
  const user     = params.get('user') ?? ''
  const intent   = params.get('intent') ?? ''

  const patchParams = useCallback((patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }, [params, setParams])

  // Local drafts for the four free-text filter inputs — debounce so
  // typing doesn't fire one /api/audit per keystroke.
  const [agentDraft, setAgentDraft]       = useState(agent)
  const [platformDraft, setPlatformDraft] = useState(platform)
  const [userDraft, setUserDraft]         = useState(user)
  const [intentDraft, setIntentDraft]     = useState(intent)

  useEffect(() => { setAgentDraft(agent) },       [agent])
  useEffect(() => { setPlatformDraft(platform) }, [platform])
  useEffect(() => { setUserDraft(user) },         [user])
  useEffect(() => { setIntentDraft(intent) },     [intent])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      patchParams({
        agent:    agentDraft    || null,
        platform: platformDraft || null,
        user:     userDraft     || null,
        intent:   intentDraft   || null,
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [agentDraft, intentDraft, patchParams, platformDraft, userDraft])

  const query: ListAuditQuery = useMemo(
    () => ({
      days,
      limit: 200,
      ...(agent ? { agent } : {}),
      ...(platform ? { platform } : {}),
      ...(user ? { user } : {}),
      ...(intent ? { intent } : {}),
    }),
    [days, agent, platform, user, intent],
  )

  const { data, isLoading, isFetching, refetch } = useAudit(query)
  const rows = data?.invocations ?? []
  const stats = data?.stats

  const columns: DataTableColumn<InvocationRow>[] = useMemo(
    () => [
      {
        id: 'ts',
        header: t('audit.col.ts'),
        cell: (r) => <span className="text-text-dim text-xs tabular-nums">{formatTime(r.ts)}</span>,
        headClassName: 'w-32',
      },
      {
        id: 'agent',
        header: t('audit.col.agent'),
        cell: (r) => <span className="font-medium">{r.agent}</span>,
        headClassName: 'w-32',
      },
      {
        id: 'platform',
        header: t('audit.col.platform'),
        cell: (r) => <span className="text-text-dim">{r.platform}</span>,
        headClassName: 'w-24',
        hideOnMobile: true,
      },
      {
        id: 'user',
        header: t('audit.col.user'),
        cell: (r) => <span className="font-mono text-xs text-text-dim line-clamp-1">{r.user_id}</span>,
        headClassName: 'w-32',
        hideOnMobile: true,
      },
      {
        id: 'intent',
        header: t('audit.col.intent'),
        cell: (r) => <span className="text-text-dim line-clamp-1">{r.intent || '—'}</span>,
        asCardTitle: true,
      },
      {
        id: 'duration',
        header: t('audit.col.duration'),
        cell: (r) => <span className="tabular-nums text-text-dim">{Math.round(r.duration_ms)}ms</span>,
        headClassName: 'w-20',
      },
      {
        id: 'cost',
        header: t('audit.col.cost'),
        cell: (r) => <span className="tabular-nums text-text-dim">${r.cost.toFixed(4)}</span>,
        headClassName: 'w-24',
        hideOnMobile: true,
      },
      {
        id: 'outcome',
        header: t('audit.col.outcome'),
        cell: (r) => (
          <Badge variant={r.success ? 'success' : 'danger'} title={r.error ?? ''}>
            {r.success ? t('audit.outcome.ok') : t('audit.outcome.fail')}
          </Badge>
        ),
        headClassName: 'w-20',
      },
    ],
    [t],
  )

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
      </header>

      {stats && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-text-dim">{t('audit.stats.total')}: <span className="tabular-nums font-medium text-text">{stats.total}</span></span>
          <span className="text-text-dim">{t('audit.stats.totalCost')}: <span className="tabular-nums font-medium text-text">${stats.totalCost.toFixed(4)}</span></span>
        </div>
      )}

      {/* Filter row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <FilterInput id="agent"    label={t('audit.filter.agent')}    value={agentDraft}    onChange={setAgentDraft} />
        <FilterInput id="platform" label={t('audit.filter.platform')} value={platformDraft} onChange={setPlatformDraft} />
        <FilterInput id="user"     label={t('audit.filter.user')}     value={userDraft}     onChange={setUserDraft} />
        <FilterInput id="intent"   label={t('audit.filter.intent')}   value={intentDraft}   onChange={setIntentDraft} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={isLoading}
        emptyState={
          <EmptyState
            icon={<Activity />}
            title={t('audit.empty.title')}
            description={t('audit.empty.description')}
          />
        }
      />
    </div>
  )
}

interface FilterInputProps {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
}

function FilterInput({ id, label, value, onChange }: FilterInputProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-text-dim">{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('h-9')}
      />
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return iso
  }
}
