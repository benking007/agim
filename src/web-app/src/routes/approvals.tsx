/**
 * /approvals — Human-in-the-loop tool approval queue.
 *
 * Cards (one per pending request) instead of a DataTable: approvals
 * are short-lived, time-sensitive, and each one wants a JSON-preview
 * block that doesn't fit cleanly in a row. Allow / Deny are 1-click
 * decisions — no ConfirmDialog (the user already weighed the call
 * when they clicked).
 *
 * SSE: the `approval` event invalidates the list on every requested /
 * resolved transition, so a request from another tab (or a backend
 * resolve we didn't initiate) flips off the screen instantly.
 *
 * KPI strip:
 *   pending  | totalAllowed | totalDenied | totalTimedOut
 *
 * Empty state is the desired steady-state — the friendly empty card
 * matches "all caught up", not "broken".
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, RefreshCcw, ShieldCheck } from 'lucide-react'

import { WorkbenchFrame } from '@/components/shell/workbench-frame'
import { Button } from '@/components/ui/button'
import { ApprovalCard } from '@/components/approvals/approval-card'
import { EmptyState } from '@/components/common/empty-state'
import {
  useApprovals,
  useInvalidateApprovals,
  useResolveApproval,
} from '@/hooks/use-approvals'
import { useEventStream, type SseStatus } from '@/hooks/use-event-stream'
import { describeError } from '@/lib/api/errors'
import type { ApprovalBehavior } from '@/types/api'
import { cn } from '@/lib/utils'

const LIVE_STATUS_CLASS: Record<SseStatus, string> = {
  connected:    'text-success',
  connecting:   'text-text-dim',
  reconnecting: 'text-warning',
  closed:       'text-text-muted',
}

export default function ApprovalsRoute(): JSX.Element {
  const { t } = useTranslation(['approvals', 'common'])
  const invalidate = useInvalidateApprovals()

  const { data, isLoading, isFetching, refetch } = useApprovals()
  const pending = data?.pending ?? []
  const metrics = data?.metrics

  const live = useEventStream({
    approval: () => invalidate(),
  })

  const resolve = useResolveApproval()
  /** Tracks the reqId currently being resolved so the card can
   *  disable its buttons. Multiple cards in flight is fine (we
   *  bake one key per card), but each card stays inert until its
   *  own promise lands. */
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  async function onResolve(reqId: string, behavior: ApprovalBehavior): Promise<void> {
    setResolvingId(reqId)
    try {
      await resolve.mutateAsync({ reqId, body: { behavior } })
      toast.success(
        behavior === 'allow' ? t('toast.allowedShort') : t('toast.deniedShort'),
      )
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    } finally {
      setResolvingId((id) => (id === reqId ? null : id))
    }
  }

  return (
    <WorkbenchFrame contentClassName="pb-safe">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
            <span className={cn('text-xs font-medium tabular-nums', LIVE_STATUS_CLASS[live])}>
              {t(`live.${live}`)}
            </span>
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
          <p className="text-sm text-text-dim">{t('subtitle')}</p>
        </header>

        {/* Metrics strip */}
        {metrics && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label={t('stats.pending')}       value={metrics.pending}       tone="info" />
            <StatCard label={t('stats.totalAllowed')}  value={metrics.totalAllowed}  tone="success" />
            <StatCard label={t('stats.totalDenied')}   value={metrics.totalDenied}   tone="danger" />
            <StatCard label={t('stats.totalTimedOut')} value={metrics.totalTimedOut} tone="warning" />
          </div>
        )}

        {/* List */}
        {isLoading ? (
          <SkeletonList />
        ) : pending.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={t('empty.title')}
            description={t('empty.description')}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {pending.map((p) => (
              <ApprovalCard
                key={p.reqId}
                approval={p}
                busy={resolvingId === p.reqId}
                onResolve={(behavior) => onResolve(p.reqId, behavior)}
              />
            ))}
          </div>
        )}
      </div>
    </WorkbenchFrame>
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

function SkeletonList(): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 2 }).map((_, i) => (
        <div
          key={`skel-${i}`}
          className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
        >
          <div className="h-4 w-1/3 rounded bg-surface-2 animate-pulse" />
          <div className="h-3 w-1/2 rounded bg-surface-2 animate-pulse" />
          <div className="h-24 w-full rounded bg-surface-2 animate-pulse" />
          <div className="ml-auto flex gap-2">
            <div className="h-8 w-16 rounded bg-surface-2 animate-pulse" />
            <div className="h-8 w-16 rounded bg-surface-2 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}
