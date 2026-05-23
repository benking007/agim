/**
 * /tasks/goals — admin overview of every ACTIVE goal across threads
 * (P1 follow-up).
 *
 * Listed goals are sortable, expandable; status-change buttons live
 * inline (pause / complete / cancel — the same lifecycle the
 * `/goal` IM command exposes). Creating a new goal still needs the
 * IM thread context (`/goal set <title>`); this panel is the
 * cross-thread VIEW + lifecycle controls.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, CircleDashed, Loader2, PauseCircle, RefreshCcw, Target, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  useGoalsList, useGoalUpdateStatus, type GoalRow,
} from '@/hooks/use-background-tasks'

export default function TasksGoalsRoute(): JSX.Element {
  const listQuery = useGoalsList()
  const updateStatus = useGoalUpdateStatus()
  const [expandedId, setExpandedId] = useState<number | null>(null)

  async function onChangeStatus(g: GoalRow, status: GoalRow['status']): Promise<void> {
    try {
      await updateStatus.mutateAsync({ id: g.id, status })
      toast.success(`Goal #${g.id} → ${status}`)
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  const rows = listQuery.data?.goals ?? []
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <Target className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">Active goals</h1>
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
        Cross-thread view of every active <code>/goal</code>. Lifecycle controls
        (pause / complete / cancel) operate without the IM thread; creating a
        new goal still requires the thread context — <code>/goal set &lt;title&gt;</code>.
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
                <TableHead className="w-12">#</TableHead>
                <TableHead>Thread</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => {
                const isExpanded = expandedId === g.id
                return (
                  <>
                    <TableRow key={g.id}>
                      <TableCell className="font-mono text-xs">{g.id}</TableCell>
                      <TableCell className="font-mono text-[11px]">{g.platform}:{g.threadId}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost" size="sm" className="-ml-2 text-left"
                          onClick={() => setExpandedId(isExpanded ? null : g.id)}
                          title={isExpanded ? 'Hide body' : 'Show body'}
                        >
                          {g.title}
                        </Button>
                      </TableCell>
                      <TableCell><Badge variant="outline">{g.progressCount}</Badge></TableCell>
                      <TableCell className="text-[11px] text-text-dim">{g.updatedAt}</TableCell>
                      <TableCell className="flex flex-wrap gap-1">
                        <Button
                          variant="ghost" size="sm" title="Pause"
                          onClick={() => void onChangeStatus(g, 'paused')}
                          disabled={updateStatus.isPending}
                        >
                          <PauseCircle className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost" size="sm" title="Complete"
                          onClick={() => void onChangeStatus(g, 'completed')}
                          disabled={updateStatus.isPending}
                        >
                          <CheckCircle2 className="h-4 w-4 text-success" />
                        </Button>
                        <Button
                          variant="ghost" size="sm" title="Cancel"
                          onClick={() => void onChangeStatus(g, 'cancelled')}
                          disabled={updateStatus.isPending}
                          className="text-danger hover:text-danger"
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow key={`${g.id}-expanded`}>
                        <TableCell />
                        <TableCell colSpan={5}>
                          <div className="space-y-2 rounded bg-surface-2 p-3 text-xs">
                            {g.body && (
                              <div>
                                <div className="text-text-dim">Body</div>
                                <pre className="mt-1 whitespace-pre-wrap break-words">{g.body}</pre>
                              </div>
                            )}
                            {g.progressLog.length > 0 && (
                              <div>
                                <div className="text-text-dim">Recent progress (latest {g.progressLog.length})</div>
                                <ul className="mt-1 space-y-1">
                                  {g.progressLog.slice().reverse().map((n, i) => (
                                    <li key={i} className="font-mono text-[11px]">
                                      <span className="text-text-dim">{n.ts.slice(0, 19)} ({n.by})</span> {n.text}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div className="text-[11px] text-text-dim">created {g.createdAt}{g.closedAt ? ` · closed ${g.closedAt}` : ''}</div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
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
      No active goals. Create one inside any IM thread with <code>/goal set &lt;title&gt;</code>.
      <div className="mt-2">
        <CircleDashed className="mx-auto h-8 w-8 opacity-30" />
      </div>
    </section>
  )
}
