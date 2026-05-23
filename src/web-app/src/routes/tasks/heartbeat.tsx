/**
 * /tasks/heartbeat — admin overview of every heartbeat binding
 * (P1 follow-up).
 *
 * Per-binding row: thread coordinates, interval, last tick status,
 * enable/disable toggle. Adding new bindings is still IM-only
 * (`/heartbeat bind <body>` inside the thread you want to bind) —
 * the body needs the IM thread context which the web has no path
 * to fabricate cleanly. This panel is the cross-thread VIEW +
 * lifecycle controls.
 */

import { useState } from 'react'
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
  const listQuery = useHeartbeatList()
  const toggle = useHeartbeatToggle()
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  async function onToggle(row: HeartbeatRow, op: 'enable' | 'disable'): Promise<void> {
    try {
      await toggle.mutateAsync({ row, op })
      toast.success(`${op}d binding`)
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  const rows = listQuery.data?.bindings ?? []
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <HeartPulse className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">Heartbeat bindings</h1>
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
        Cross-thread view of every <code>/heartbeat bind</code>. Enable/disable a binding
        from here; create new ones from inside the IM thread itself
        (<code>/heartbeat bind &lt;body&gt;</code>).
      </p>

      {listQuery.isLoading ? (
        <div className="h-48 rounded-md bg-surface-2 animate-pulse" />
      ) : rows.length === 0 ? (
        <EmptySection />
      ) : (
        <section className="rounded-md border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Thread</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Interval</TableHead>
                <TableHead>Last tick</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Body</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const key = `${r.platform}:${r.channelId}:${r.threadId}`
                const isExpanded = expandedKey === key
                const tickBadge = !r.lastTickAt
                  ? <Badge variant="outline">never</Badge>
                  : r.lastStatus === 'delivered'
                    ? <Badge variant="success">{shortAge(r.lastTickAt)}</Badge>
                    : r.lastStatus === 'error'
                      ? <Badge variant="danger" title={r.lastReason}>{r.lastStatus} · {shortAge(r.lastTickAt)}</Badge>
                      : <Badge variant="outline" title={r.lastReason}>{r.lastStatus} · {shortAge(r.lastTickAt)}</Badge>
                return (
                  <TableRow key={key}>
                    <TableCell className="font-mono text-[11px]">{r.platform}:{r.threadId}</TableCell>
                    <TableCell className="font-mono text-[11px]">{r.userId || '—'}</TableCell>
                    <TableCell className="text-xs">{r.intervalMinutes}m</TableCell>
                    <TableCell>{tickBadge}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => void onToggle(r, r.enabled ? 'disable' : 'enable')}
                        disabled={toggle.isPending}
                      >
                        {r.enabled
                          ? <><Pause className="h-4 w-4" /><span>Pause</span></>
                          : <><Play className="h-4 w-4" /><span>Enable</span></>}
                      </Button>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => setExpandedKey(isExpanded ? null : key)}
                        className="-ml-2"
                      >
                        {isExpanded ? 'Hide' : 'Show'}
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
  return (
    <section className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-dim">
      No heartbeat bindings yet. Run <code>/heartbeat bind &lt;body&gt;</code> in any IM thread to create one.
    </section>
  )
}

function shortAge(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}
