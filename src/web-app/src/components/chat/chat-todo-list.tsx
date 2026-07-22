/**
 * ChatTodoList — Cursor-style plan checklist surfaced in the chat thread.
 *
 * Reads the latest `agim_todo_write` step from ChatActivity (structured
 * todoItems, with markdown/JSON preview fallback). Collapsible; expands
 * by default while the run is live or items remain incomplete.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronRight,
  Circle,
  ListTodo,
  Loader2,
} from 'lucide-react'

import type { ChatActivity } from '@/hooks/use-chat'
import {
  extractLatestTodoItems,
  summarizeTodoItems,
  type ChatTodoItem,
  type ChatTodoStatus,
} from '@/lib/activity-todo'
import { cn } from '@/lib/utils'

export interface ChatTodoListProps {
  activity: ChatActivity
  /** Portal dark surface — softens borders / text. */
  dark?: boolean
  className?: string
}

function StatusIcon({
  status,
  dark,
}: {
  status: ChatTodoStatus
  dark?: boolean
}): JSX.Element {
  const cls = 'h-3.5 w-3.5 shrink-0'
  if (status === 'completed') {
    return <Check className={cn(cls, 'text-emerald-500')} strokeWidth={2.5} />
  }
  if (status === 'in_progress') {
    return <Loader2 className={cn(cls, 'animate-spin text-teal-500')} />
  }
  return <Circle className={cn(cls, dark ? 'text-zinc-600' : 'text-text-muted')} />
}

function TodoRow({
  item,
  index,
  dark,
}: {
  item: ChatTodoItem
  index: number
  dark?: boolean
}): JSX.Element {
  const done = item.status === 'completed'
  const active = item.status === 'in_progress'
  return (
    <li
      className={cn(
        'flex items-start gap-2 py-1 text-[13px] leading-snug',
        done && (dark ? 'text-zinc-500' : 'text-text-muted'),
        active && (dark ? 'text-zinc-100' : 'text-text'),
        !done && !active && (dark ? 'text-zinc-300' : 'text-text-dim'),
      )}
    >
      <span className="mt-0.5">
        <StatusIcon status={item.status} dark={dark} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('mr-1.5 tabular-nums opacity-50', dark ? 'text-zinc-500' : '')}>
          {index + 1}.
        </span>
        <span className={cn(done && 'line-through decoration-from-font opacity-80')}>
          {item.content}
        </span>
      </span>
    </li>
  )
}

export function ChatTodoList({ activity, dark, className }: ChatTodoListProps): JSX.Element | null {
  const { t } = useTranslation()
  const items = extractLatestTodoItems(activity)
  const running = activity.status === 'running'
  const summary = items ? summarizeTodoItems(items) : null
  const allDone = summary?.allDone === true
  const hasItems = (summary?.total ?? 0) > 0

  // Expand while the turn is live or work remains; collapse when all done
  // (user can still reopen). Depend on primitives so a new summary object
  // each render does not fight a manual expand after completion.
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (!hasItems) return
    if (running || !allDone) setOpen(true)
    else setOpen(false)
  }, [running, hasItems, allDone])

  if (!items || items.length === 0 || !summary) return null

  const title = summary.allDone
    ? t('chat.todoTitleDone', {
        completed: summary.completed,
        total: summary.total,
        defaultValue: 'Plan · {{completed}}/{{total}} done',
      })
    : t('chat.todoTitle', {
        completed: summary.completed,
        total: summary.total,
        defaultValue: 'Plan · {{completed}}/{{total}}',
      })

  return (
    <div
      className={cn(
        'w-full max-w-[85%] sm:max-w-[75%]',
        className,
      )}
    >
      <div
        className={cn(
          'overflow-hidden rounded-xl border',
          dark
            ? 'border-zinc-800 bg-zinc-950/60'
            : 'border-border/70 bg-surface/80',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left transition',
            dark ? 'hover:bg-zinc-900/80' : 'hover:bg-surface-2/80',
          )}
        >
          <ListTodo
            className={cn(
              'h-4 w-4 shrink-0',
              summary.allDone ? 'text-emerald-500' : 'text-teal-500',
            )}
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight',
              dark ? 'text-zinc-200' : 'text-text',
            )}
          >
            {title}
          </span>
          {summary.inProgress > 0 && (
            <span className={cn(
              'shrink-0 text-[10px] uppercase tracking-wide',
              dark ? 'text-teal-400/80' : 'text-teal-600',
            )}
            >
              {t('chat.todoInProgress', { defaultValue: 'in progress' })}
            </span>
          )}
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
              dark ? 'text-zinc-500' : 'text-text-muted',
              open && 'rotate-90',
            )}
          />
        </button>

        {open && (
          <ul
            className={cn(
              'space-y-0.5 border-t px-3 py-2',
              dark ? 'border-zinc-800' : 'border-border/60',
            )}
          >
            {items.map((item, index) => (
              <TodoRow key={item.content} item={item} index={index} dark={dark} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
