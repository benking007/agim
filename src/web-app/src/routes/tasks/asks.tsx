/**
 * /tasks/asks — admin view of every pending `mcp__imhub__ask_user`
 * waiting on user input (P1 follow-up).
 *
 * Use case: an agent fired an ask, the user got distracted, you want
 * to see what's hanging + force-cancel the ones that look stale.
 * Cancellation surfaces to the agent as
 * `{ ok: false, reason: 'cancelled' }` — exact same shape as a
 * natural timeout, so the agent already knows what to do.
 */

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
  const listQuery = useAsksList()
  const cancel = useAskCancel()

  async function onCancel(reqId: string): Promise<void> {
    if (!confirm(`Cancel pending ask ${reqId.slice(0, 8)}…?`)) return
    try {
      await cancel.mutateAsync(reqId)
      toast.success('Cancelled')
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  const rows = listQuery.data?.pending ?? []
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <Hourglass className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">Pending ask_user</h1>
        <Badge variant="info">{rows.length}</Badge>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
          aria-label="Refresh"
        >
          {listQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">
        Live list of every <code>mcp__imhub__ask_user</code> waiting on a reply.
        Cancelling here gives the agent the same response shape as a natural
        timeout (<code>ok: false, reason: 'cancelled'</code>).
      </p>

      {listQuery.isLoading ? (
        <div className="h-32 rounded-md bg-surface-2 animate-pulse" />
      ) : rows.length === 0 ? (
        <section className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-dim">
          No pending asks. Auto-refreshes every 5s.
        </section>
      ) : (
        <section className="rounded-md border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Req ID</TableHead>
                <TableHead>Thread</TableHead>
                <TableHead>Question</TableHead>
                <TableHead>Choices</TableHead>
                <TableHead>Age</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.reqId}>
                  <TableCell className="font-mono text-[11px]">{r.reqId.slice(0, 8)}…</TableCell>
                  <TableCell className="font-mono text-[11px]">{r.platform}:{r.threadId}</TableCell>
                  <TableCell className="max-w-md break-words">{r.question}</TableCell>
                  <TableCell><Badge variant="outline">{r.choices}</Badge></TableCell>
                  <TableCell className="text-xs text-text-dim">{fmtAge(r.ageMs)}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => void onCancel(r.reqId)}
                      disabled={cancel.isPending}
                      className="text-danger hover:text-danger"
                    >
                      <XCircle className="h-4 w-4" />
                      Cancel
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

function fmtAge(ms: number): string {
  if (ms < 1_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}
