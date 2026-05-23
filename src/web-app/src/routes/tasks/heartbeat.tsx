/**
 * /tasks/heartbeat — admin overview of every heartbeat binding (P1).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { HeartPulse, Loader2, Pause, Play, RefreshCcw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  useHeartbeatList, useHeartbeatToggle, type HeartbeatRow,
} from '@/hooks/use-background-tasks'

export default function TasksHeartbeatRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const listQuery = useHeartbeatList()
  const toggle = useHeartbeatToggle()
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  async function onToggle(row: HeartbeatRow, op: 'enable' | 'disable'): Promise<void> {
    try {
      await toggle.mutateAsync({ row, op })
      toast.success(op === 'enable' ? t('heartbeat.enabledToast') : t('heartbeat.disabledToast'))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  const rows = listQuery.data?.bindings ?? []
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <HeartPulse className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">{t('heartbeat.title')}</h1>
        <Badge variant="info">{rows.length}</Badge>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
          aria-label={t('actions.refresh', { ns: 'common' })}
        >
          {listQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">{t('heartbeat.refresh')}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">{t('heartbeat.subtitle')}</p>

      {listQuery.isLoading ? (
        <div className="h-48 rounded-md bg-surface-2 animate-pulse" />
      ) : rows.length === 0 ? (
        <EmptySection />
      ) : (
        <section className="rounded-md border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('heartbeat.col.thread')}</TableHead>
                <TableHead>{t('heartbeat.col.owner')}</TableHead>
                <TableHead>{t('heartbeat.col.interval')}</TableHead>
                <TableHead>{t('heartbeat.col.lastTick')}</TableHead>
                <TableHead>{t('heartbeat.col.enabled')}</TableHead>
                <TableHead>{t('heartbeat.col.body')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const key = `${r.platform}:${r.channelId}:${r.threadId}`
                const isExpanded = expandedKey === key
                const tickBadge = !r.lastTickAt
                  ? <Badge variant="outline">{t('heartbeat.never')}</Badge>
                  : r.lastStatus === 'delivered'
                    ? <Badge variant="success">{shortAge(r.lastTickAt, t)}</Badge>
                    : r.lastStatus === 'error'
                      ? <Badge variant="danger" title={r.lastReason}>{r.lastStatus} · {shortAge(r.lastTickAt, t)}</Badge>
                      : <Badge variant="outline" title={r.lastReason}>{r.lastStatus} · {shortAge(r.lastTickAt, t)}</Badge>
                return (
                  <TableRow key={key}>
                    <TableCell className="font-mono text-[11px]">{r.platform}:{r.threadId}</TableCell>
                    <TableCell className="font-mono text-[11px]">{r.userId || '—'}</TableCell>
                    <TableCell className="text-xs">{t('heartbeat.intervalMin', { count: r.intervalMinutes })}</TableCell>
                    <TableCell>{tickBadge}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => void onToggle(r, r.enabled ? 'disable' : 'enable')}
                        disabled={toggle.isPending}
                      >
                        {r.enabled
                          ? <><Pause className="h-4 w-4" /><span>{t('heartbeat.pause')}</span></>
                          : <><Play className="h-4 w-4" /><span>{t('heartbeat.enable')}</span></>}
                      </Button>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => setExpandedKey(isExpanded ? null : key)}
                        className="-ml-2"
                      >
                        {isExpanded ? t('heartbeat.hide') : t('heartbeat.show')}
                      </Button>
                      {isExpanded && (
                        <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-surface-2 p-2 text-[11px] text-text-dim">
                          {r.body}
                        </pre>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  )
}

function EmptySection(): JSX.Element {
  const { t } = useTranslation('tasks')
  return (
    <section className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-dim">
      {t('heartbeat.empty')}
    </section>
  )
}

function shortAge(iso: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!iso) return t('heartbeat.never')
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return t('heartbeat.justNow')
  if (ms < 60_000) return t('heartbeat.justNow')
  if (ms < 3_600_000) return t('heartbeat.minutesAgo', { count: Math.floor(ms / 60_000) })
  if (ms < 86_400_000) return t('heartbeat.hoursAgo', { count: Math.floor(ms / 3_600_000) })
  return t('heartbeat.daysAgo', { count: Math.floor(ms / 86_400_000) })
}
