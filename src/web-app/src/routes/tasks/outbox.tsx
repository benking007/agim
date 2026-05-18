/**
 * /tasks/outbox — IM-platform delivery queue. Read-mostly; the one
 * mutation is "retry" on rows stuck in `giving_up`. Per-row action
 * routes through ConfirmDialog so an accidental click doesn't re-
 * fire a possibly-flaky delivery against the user's IM channel.
 */

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Inbox, Loader2, RefreshCcw, RotateCcw } from 'lucide-react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { StatusBadge } from '@/components/common/status-badge'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
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
import {
  useOutbox,
  useOutboxStats,
  useRetryOutbox,
} from '@/hooks/use-outbox'
import type { OutboxRow, OutboxStatus } from '@/types/api'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

const STATUS_OPTIONS: OutboxStatus[] = ['pending', 'delivered', 'giving_up']

export default function OutboxRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as OutboxStatus | null) ?? null
  const thread = params.get('thread') ?? ''

  const { data, isLoading, isFetching, refetch } = useOutbox({
    ...(status ? { status } : {}),
    ...(thread ? { thread } : {}),
    limit: 200,
  })
  const rows = data?.rows ?? []
  const statsQuery = useOutboxStats()
  const stats = statsQuery.data

  const retryMut = useRetryOutbox()
  const [confirmRetryId, setConfirmRetryId] = useState<number | null>(null)

  function patchParams(patch: Record<string, string | null>): void {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  async function onConfirmRetry(): Promise<void> {
    if (confirmRetryId == null) return
    try {
      await retryMut.mutateAsync(confirmRetryId)
      toast.success(t('states.saved', { ns: 'common' }))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
      throw err
    }
  }

  const columns: DataTableColumn<OutboxRow>[] = useMemo(
    () => [
      {
        id: 'id',
        header: t('outbox.col.id'),
        cell: (r) => <span className="tabular-nums text-text-dim">#{r.id}</span>,
        headClassName: 'w-20',
      },
      {
        id: 'status',
        header: t('outbox.col.status'),
        cell: (r) => (
          <StatusBadge status={r.status}>
            {t(`outbox.status.${r.status}`, { defaultValue: r.status })}
          </StatusBadge>
        ),
        headClassName: 'w-28',
      },
      {
        id: 'platform',
        header: t('outbox.col.platform'),
        cell: (r) => <span className="font-medium">{r.platform}</span>,
        headClassName: 'w-28',
      },
      {
        id: 'thread',
        header: t('outbox.col.thread'),
        cell: (r) => (
          <span
            className="font-mono text-xs text-text-dim line-clamp-1"
            title={r.thread_key}
          >
            {r.thread_key}
          </span>
        ),
        asCardTitle: true,
      },
      {
        id: 'kind',
        header: t('outbox.col.kind'),
        cell: (r) => <span className="text-text-dim">{r.kind}</span>,
        headClassName: 'w-20',
        hideOnMobile: true,
      },
      {
        id: 'attempts',
        header: t('outbox.col.attempts'),
        cell: (r) => <span className="tabular-nums">{r.attempts}</span>,
        headClassName: 'w-20',
      },
      {
        id: 'createdAt',
        header: t('outbox.col.createdAt'),
        cell: (r) => <span className="text-text-dim">{formatTime(r.created_at)}</span>,
        headClassName: 'w-32',
        hideOnMobile: true,
      },
      {
        id: 'lastError',
        header: t('outbox.col.lastError'),
        cell: (r) =>
          r.last_error ? (
            <span className="line-clamp-1 text-danger text-xs" title={r.last_error}>
              {r.last_error}
            </span>
          ) : (
            <span className="text-text-muted">—</span>
          ),
        hideOnMobile: false,
      },
      {
        id: 'actions',
        header: '',
        cell: (r) =>
          r.status === 'giving_up' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                setConfirmRetryId(r.id)
              }}
              disabled={retryMut.isPending}
            >
              <RotateCcw className="h-3 w-3" />
              {t('outbox.action.retry')}
            </Button>
          ) : null,
        headClassName: 'w-28',
      },
    ],
    [t, retryMut.isPending],
  )

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('outbox.title')}</h1>
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
        <p className="text-sm text-text-dim">{t('outbox.subtitle')}</p>
      </header>

      {/* Stats strip */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard label={t('outbox.stats.pending')}   value={stats.pending}   tone="info" />
          <StatCard label={t('outbox.stats.giving_up')} value={stats.giving_up} tone="danger" />
          <StatCard label={t('outbox.stats.delivered')} value={stats.delivered} tone="success" />
          <div className="rounded-md border border-border bg-surface px-3 py-2">
            <div className="text-xs uppercase tracking-wide text-text-dim">
              {t('outbox.stats.lastDelivered')}
            </div>
            <div className="text-sm font-medium tabular-nums">
              {stats.lastDeliveredAt ? formatTime(stats.lastDeliveredAt) : '—'}
            </div>
          </div>
        </div>
      )}

      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="status-filter" className="text-xs text-text-dim">
            {t('outbox.filter.status')}
          </Label>
          <Select
            value={status ?? '__any__'}
            onValueChange={(v) => patchParams({ status: v === '__any__' ? null : v })}
          >
            <SelectTrigger id="status-filter" className="h-9 w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">{t('outbox.filter.statusAny')}</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`outbox.status.${s}`, { defaultValue: s })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="thread-filter" className="text-xs text-text-dim">
            {t('outbox.filter.thread')}
          </Label>
          <Input
            id="thread-filter"
            value={thread}
            onChange={(e) => patchParams({ thread: e.target.value })}
            placeholder="wechat:room:..."
            className="h-9 w-72 font-mono text-xs"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={isLoading}
        emptyState={
          <EmptyState
            icon={<Inbox />}
            title={t('outbox.empty.title')}
            description={t('outbox.empty.description')}
          />
        }
      />

      <ConfirmDialog
        open={confirmRetryId != null}
        onOpenChange={(open) => {
          if (!open) setConfirmRetryId(null)
        }}
        title={t('outbox.action.confirmRetry')}
        description={t('outbox.action.confirmRetryDesc')}
        confirmLabel={t('outbox.action.retry')}
        onConfirm={onConfirmRetry}
      />
    </div>
  )
}

interface StatCardProps {
  label: string
  value: number
  tone: 'info' | 'success' | 'warning' | 'danger'
}

const TONE_STYLES: Record<StatCardProps['tone'], string> = {
  info:    'border-info/30    text-info',
  success: 'border-success/30 text-success',
  warning: 'border-warning/30 text-warning',
  danger:  'border-danger/30  text-danger',
}

function StatCard({ label, value, tone }: StatCardProps): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border bg-surface px-3 py-2',
        TONE_STYLES[tone],
      )}
    >
      <div className="text-xs uppercase tracking-wide text-text-dim">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function formatTime(iso: string | null): string {
  if (iso == null) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
