/**
 * /reminders — queued-reminder list with cancel + snooze.
 *
 * Composition: Topbar + filter row + DataTable + ConfirmDialog
 * (cancel) + a custom <SnoozeDialog> with duration presets that
 * map to the backend's parseDuration vocabulary.
 *
 * Mutations only enabled on `pending` rows; firing/fired/cancelled/
 * failed stay read-only. The DataTable's last column is per-row
 * action buttons.
 *
 * No SSE channel for reminders — 5s react-query poll covers the
 * common case (reminders fire on minute boundaries; latency to
 * surface a firing transition is rarely UX-critical).
 */

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell, BellOff, Clock, Loader2, RefreshCcw } from 'lucide-react'

import { Topbar } from '@/components/shell/topbar'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { StatusBadge } from '@/components/common/status-badge'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useReminders,
  useCancelReminder,
  useSnoozeReminder,
} from '@/hooks/use-reminders'
import { describeError } from '@/lib/api/errors'
import type { Reminder, ReminderStatus } from '@/types/api'

const STATUS_OPTIONS: ReminderStatus[] = ['pending', 'firing', 'fired', 'cancelled', 'failed']

interface SnoozePreset {
  /** Backend parseDuration string. */
  duration: string
  /** i18n key (inside the `snooze` section). */
  i18nKey: string
}

const SNOOZE_PRESETS: SnoozePreset[] = [
  { duration: '5m', i18nKey: 'snooze.preset5m' },
  { duration: '30m', i18nKey: 'snooze.preset30m' },
  { duration: '1h', i18nKey: 'snooze.preset1h' },
  { duration: '1d', i18nKey: 'snooze.preset1d' },
]

export default function RemindersRoute(): JSX.Element {
  const { t } = useTranslation(['reminders', 'common'])
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as ReminderStatus | null) ?? 'pending'

  const query = useMemo(
    () => ({ status, limit: 200 }),
    [status],
  )
  const { data, isLoading, isFetching, refetch } = useReminders(query)
  const reminders = data?.reminders ?? []

  const cancel = useCancelReminder()
  const snooze = useSnoozeReminder()

  const [confirmCancelId, setConfirmCancelId] = useState<number | null>(null)
  const [snoozeTargetId, setSnoozeTargetId] = useState<number | null>(null)

  function patchParams(patch: Record<string, string | null>): void {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  async function onConfirmCancel(): Promise<void> {
    if (confirmCancelId == null) return
    try {
      await cancel.mutateAsync(confirmCancelId)
      toast.success(t('toast.cancelled'))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
      throw err
    }
  }

  async function onConfirmSnooze(duration: string): Promise<void> {
    if (snoozeTargetId == null) return
    try {
      await snooze.mutateAsync({ id: snoozeTargetId, body: { duration } })
      toast.success(t('snooze.toastOk', { duration }))
      setSnoozeTargetId(null)
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  const columns: DataTableColumn<Reminder>[] = useMemo(
    () => [
      {
        id: 'id',
        header: t('col.id'),
        cell: (r) => <span className="tabular-nums text-text-dim">#{r.id}</span>,
        headClassName: 'w-16',
      },
      {
        id: 'fireAt',
        header: t('col.fireAt'),
        cell: (r) => <span className="font-medium tabular-nums">{formatTime(r.fire_at)}</span>,
        headClassName: 'w-40',
      },
      {
        id: 'text',
        header: t('col.text'),
        cell: (r) => <span className="line-clamp-2 text-text-dim">{r.text}</span>,
        asCardTitle: true,
      },
      {
        id: 'status',
        header: t('col.status'),
        cell: (r) => (
          <StatusBadge status={r.status}>
            {t(`status.${r.status}`, { defaultValue: r.status })}
          </StatusBadge>
        ),
        headClassName: 'w-28',
      },
      {
        id: 'platform',
        header: t('col.platform'),
        cell: (r) => <span className="text-text-dim">{r.platform}</span>,
        headClassName: 'w-24',
        hideOnMobile: true,
      },
      {
        id: 'recurrence',
        header: t('col.recurrence'),
        cell: (r) =>
          r.recurrence_label ? (
            <Badge variant="info">{r.recurrence_label}</Badge>
          ) : (
            <span className="text-text-muted">—</span>
          ),
        headClassName: 'w-36',
        hideOnMobile: true,
      },
      {
        id: 'source',
        header: t('col.source'),
        cell: (r) => (
          <span className="text-text-dim">{t(`source.${r.source}`, { defaultValue: r.source })}</span>
        ),
        headClassName: 'w-24',
        hideOnMobile: true,
      },
      {
        id: 'actions',
        header: '',
        cell: (r) =>
          r.status === 'pending' ? (
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  setSnoozeTargetId(r.id)
                }}
                disabled={snooze.isPending || cancel.isPending}
              >
                <Clock className="h-3 w-3" />
                {t('action.snooze')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmCancelId(r.id)
                }}
                disabled={cancel.isPending || snooze.isPending}
              >
                <BellOff className="h-3 w-3" />
                {t('action.cancel')}
              </Button>
            </div>
          ) : null,
        headClassName: 'w-48',
      },
    ],
    [t, cancel.isPending, snooze.isPending],
  )

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-3 py-4 sm:px-4 pb-safe">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
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

        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-text-dim" htmlFor="status-filter">
            {t('filter.status')}
          </label>
          <Select
            value={status}
            onValueChange={(v) => patchParams({ status: v })}
          >
            <SelectTrigger id="status-filter" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`status.${s}`, { defaultValue: s })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DataTable
          columns={columns}
          rows={reminders}
          getRowId={(r) => String(r.id)}
          loading={isLoading}
          emptyState={
            <EmptyState
              icon={<Bell />}
              title={t('empty.title')}
              description={t('empty.description')}
            />
          }
        />

        <ConfirmDialog
          open={confirmCancelId != null}
          onOpenChange={(open) => {
            if (!open) setConfirmCancelId(null)
          }}
          title={t('action.confirmCancel')}
          description={t('action.confirmCancelDesc')}
          intent="danger"
          confirmLabel={t('action.cancel')}
          onConfirm={onConfirmCancel}
        />

        <SnoozeDialog
          open={snoozeTargetId != null}
          busy={snooze.isPending}
          onOpenChange={(open) => {
            if (!open) setSnoozeTargetId(null)
          }}
          onPick={onConfirmSnooze}
        />
      </main>
    </div>
  )
}

interface SnoozeDialogProps {
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onPick: (duration: string) => void | Promise<void>
}

function SnoozeDialog({ open, busy, onOpenChange, onPick }: SnoozeDialogProps): JSX.Element {
  const { t } = useTranslation(['reminders', 'common'])
  return (
    <Dialog open={open} onOpenChange={busy ? () => {} : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('snooze.title')}</DialogTitle>
          <DialogDescription>{t('snooze.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {SNOOZE_PRESETS.map((p) => (
            <Button
              key={p.duration}
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void onPick(p.duration)}
            >
              {t(p.i18nKey)}
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('actions.cancel', { ns: 'common' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
