/**
 * /tasks/asks — admin view of pending ask_user (P1).
 */

import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Hourglass, Loader2, RefreshCcw, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  useAsksList, useAskCancel,
} from '@/hooks/use-background-tasks'

export default function TasksAsksRoute(): JSX.Element {
  const { t } = useTranslation(['tasks', 'common'])
  const listQuery = useAsksList()
  const cancel = useAskCancel()

  async function onCancel(reqId: string): Promise<void> {
    if (!confirm(t('asks.cancelConfirm', { id: reqId.slice(0, 8) }))) return
    try {
      await cancel.mutateAsync(reqId)
      toast.success(t('asks.cancelledToast'))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  const rows = listQuery.data?.pending ?? []
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <Hourglass className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">{t('asks.title')}</h1>
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
          <span className="hidden sm:inline">{t('asks.refresh')}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">{t('asks.subtitle')}</p>

      {listQuery.isLoading ? (
        <div className="h-32 rounded-md bg-surface-2 animate-pulse" />
      ) : rows.length === 0 ? (
        <section className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-dim">
          {t('asks.empty')}
        </section>
      ) : (
        <section className="rounded-md border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('asks.col.reqId')}</TableHead>
                <TableHead>{t('asks.col.thread')}</TableHead>
                <TableHead>{t('asks.col.question')}</TableHead>
                <TableHead>{t('asks.col.choices')}</TableHead>
                <TableHead>{t('asks.col.age')}</TableHead>
                <TableHead>{t('asks.col.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.reqId}>
                  <TableCell className="font-mono text-[11px]">{r.reqId.slice(0, 8)}…</TableCell>
                  <TableCell className="font-mono text-[11px]">{r.platform}:{r.threadId}</TableCell>
                  <TableCell className="max-w-md break-words">{r.question}</TableCell>
                  <TableCell><Badge variant="outline">{r.choices}</Badge></TableCell>
                  <TableCell className="text-xs text-text-dim">{fmtAge(r.ageMs, t)}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => void onCancel(r.reqId)}
                      disabled={cancel.isPending}
                      className="text-danger hover:text-danger"
                    >
                      <XCircle className="h-4 w-4" />
                      {t('asks.cancel')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  )
}

function fmtAge(ms: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (ms < 1_000) return t('asks.justNow')
  if (ms < 60_000) return t('asks.seconds', { count: Math.floor(ms / 1_000) })
  if (ms < 3_600_000) return t('asks.minutes', { count: Math.floor(ms / 60_000) })
  return t('asks.hours', { count: Math.floor(ms / 3_600_000) })
}
