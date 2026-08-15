/**
 * /tasks — overview surface.
 *
 * The detailed task pages are still the source of truth. This page
 * gives operators a small set of live signals and routes them to the
 * right table when something needs attention.
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  HelpCircle,
  Inbox,
  RefreshCcw,
  Workflow,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useA2AStats } from '@/hooks/use-a2a'
import { useAsksList, useHeartbeatList } from '@/hooks/use-background-tasks'
import { useJobs } from '@/hooks/use-jobs'
import { useOutboxStats } from '@/hooks/use-outbox'
import { useSchedules } from '@/hooks/use-schedules'
import { cn } from '@/lib/utils'

type CardTone = 'success' | 'warning' | 'danger' | 'info' | 'default'
type NextActionId = 'asks' | 'outboxStuck' | 'jobs' | 'outbox' | 'automation' | 'idle'

interface MetricCard {
  id: string
  title: string
  value: string | number
  detail: string
  to: string
  action: string
  tone: CardTone
  icon: JSX.Element
}

interface NextAction {
  id: string
  to: string
  title: string
  detail: string
}

const TONE_CLASS: Record<CardTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
  info:    'text-info',
  default: 'text-text-dim',
}

export default function TasksOverviewRoute(): JSX.Element {
  const { t } = useTranslation('tasks')
  const jobsQuery = useJobs({ limit: 5, offset: 0 })
  const outboxQuery = useOutboxStats()
  const schedulesQuery = useSchedules({})
  const a2aQuery = useA2AStats()
  const heartbeatQuery = useHeartbeatList()
  const asksQuery = useAsksList()

  const jobStats = jobsQuery.data?.stats
  const jobs = jobsQuery.data?.jobs ?? []
  const runningJobs = jobStats?.running ?? jobs.filter((j) => j.status === 'running').length
  const pendingJobs = jobStats?.pending ?? jobs.filter((j) => j.status === 'pending').length
  const failedJobs = jobStats?.failed ?? jobs.filter((j) => j.status === 'failed').length
  const activeJobs = runningJobs + pendingJobs

  const outbox = outboxQuery.data
  const outboxPending = outbox?.pending ?? 0
  const outboxGivingUp = outbox?.giving_up ?? 0

  const schedules = schedulesQuery.data?.schedules ?? []
  const enabledSchedules = schedules.filter((s) => s.enabled).length
  const heartbeatBindings = heartbeatQuery.data?.bindings ?? []
  const enabledHeartbeats = heartbeatBindings.filter((b) => b.enabled).length
  const pendingAsks = asksQuery.data?.count ?? asksQuery.data?.pending.length ?? 0
  const a2aRecent = a2aQuery.data?.recent24h ?? 0
  const automationCount = enabledSchedules + enabledHeartbeats
  const needsAttention = pendingAsks + outboxGivingUp + failedJobs
  const anyFetching = jobsQuery.isFetching
    || outboxQuery.isFetching
    || schedulesQuery.isFetching
    || a2aQuery.isFetching
    || heartbeatQuery.isFetching
    || asksQuery.isFetching

  const nextAction = pickNextAction({
    t,
    pendingAsks,
    outboxGivingUp,
    activeJobs,
    outboxPending,
    automationCount,
  })

  const cards: MetricCard[] = [
    {
      id: 'work',
      title: t('overview.cards.work.title'),
      value: activeJobs,
      detail: t('overview.cards.work.detail', { running: runningJobs, pending: pendingJobs }),
      to: '/tasks/jobs',
      action: t('overview.cards.work.action'),
      tone: activeJobs > 0 ? 'warning' : 'success',
      icon: <ClipboardList />,
    },
    {
      id: 'asks',
      title: t('overview.cards.asks.title'),
      value: pendingAsks,
      detail: pendingAsks > 0
        ? t('overview.cards.asks.waiting', { count: pendingAsks })
        : t('overview.cards.asks.clear'),
      to: '/tasks/asks',
      action: t('overview.cards.asks.action'),
      tone: pendingAsks > 0 ? 'danger' : 'success',
      icon: <HelpCircle />,
    },
    {
      id: 'outbox',
      title: t('overview.cards.outbox.title'),
      value: outboxGivingUp > 0 ? outboxGivingUp : outboxPending,
      detail: outboxGivingUp > 0
        ? t('overview.cards.outbox.stuck', { count: outboxGivingUp })
        : t('overview.cards.outbox.detail', { pending: outboxPending }),
      to: '/tasks/outbox',
      action: t('overview.cards.outbox.action'),
      tone: outboxGivingUp > 0 ? 'danger' : outboxPending > 0 ? 'warning' : 'success',
      icon: <Inbox />,
    },
    {
      id: 'automation',
      title: t('overview.cards.automation.title'),
      value: automationCount,
      detail: t('overview.cards.automation.detail', {
        schedules: enabledSchedules,
        heartbeats: enabledHeartbeats,
      }),
      to: '/tasks/schedules',
      action: t('overview.cards.automation.action'),
      tone: automationCount > 0 ? 'info' : 'default',
      icon: <CalendarClock />,
    },
    {
      id: 'a2a',
      title: t('overview.cards.a2a.title'),
      value: a2aRecent,
      detail: t('overview.cards.a2a.detail'),
      to: '/tasks/a2a',
      action: t('overview.cards.a2a.action'),
      tone: a2aRecent > 0 ? 'info' : 'default',
      icon: <Workflow />,
    },
  ]

  const groups = [
    {
      title: t('overview.groups.work'),
      links: [
        ['approvals', '/tasks/approvals'],
        ['jobs', '/tasks/jobs'],
        ['subtasks', '/tasks/subtasks'],
        ['bgjobs', '/tasks/bgjobs'],
        ['outbox', '/tasks/outbox'],
      ],
    },
    {
      title: t('overview.groups.automation'),
      links: [
        ['schedules', '/tasks/schedules'],
        ['heartbeat', '/tasks/heartbeat'],
        ['asks', '/tasks/asks'],
      ],
    },
    {
      title: t('overview.groups.review'),
      links: [
        ['a2a', '/tasks/a2a'],
        ['plans', '/tasks/plans'],
      ],
    },
  ] as const

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{t('overview.title')}</h1>
            <Badge variant={needsAttention > 0 ? 'warning' : 'success'}>
              {needsAttention > 0
                ? t('overview.needsAttention', { count: needsAttention })
                : t('overview.clear')}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-text-dim">{t('overview.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={anyFetching}
          onClick={() => {
            void jobsQuery.refetch()
            void outboxQuery.refetch()
            void schedulesQuery.refetch()
            void a2aQuery.refetch()
            void heartbeatQuery.refetch()
            void asksQuery.refetch()
          }}
        >
          <RefreshCcw className={cn('h-4 w-4', anyFetching && 'animate-spin')} />
          <span>{t('overview.refresh')}</span>
        </Button>
      </header>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {cards.map((card) => (
          <MetricCardItem key={card.id} card={card} />
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)]">
        <Link
          to={nextAction.to}
          className={cn(
            'group flex min-h-24 items-center gap-3 rounded-md border border-accent bg-accent-bg/45 p-4 no-underline',
            'hover:bg-accent-bg',
          )}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg">
            <ArrowRight className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-text">{nextAction.title}</span>
            <span className="mt-1 block text-sm text-text-dim">{nextAction.detail}</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-text-dim transition-transform group-hover:translate-x-0.5" />
        </Link>

        <section className="rounded-md border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold">{t('overview.groups.title')}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {groups.map((group) => (
              <div key={group.title}>
                <h3 className="text-[11px] font-semibold uppercase leading-5 text-text-muted">
                  {group.title}
                </h3>
                <div className="mt-1 flex flex-wrap gap-2">
                  {group.links.map(([id, to]) => (
                    <Button key={to} asChild variant="secondary" size="sm">
                      <Link to={to}>
                        <span>{t(`subnav.${id}`)}</span>
                      </Link>
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </section>
    </div>
  )
}

function MetricCardItem({ card }: { card: MetricCard }): JSX.Element {
  return (
    <article className="rounded-md border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2',
            TONE_CLASS[card.tone],
            '[&_svg]:h-4 [&_svg]:w-4',
          )}
          aria-hidden="true"
        >
          {card.tone === 'success' ? <CheckCircle2 /> : card.icon}
        </span>
        <span className={cn('text-2xl font-semibold tabular-nums', TONE_CLASS[card.tone])}>
          {card.value}
        </span>
      </div>
      <h2 className="mt-3 text-sm font-semibold">{card.title}</h2>
      <p className="mt-1 min-h-10 text-sm text-text-dim">{card.detail}</p>
      <Button asChild variant="ghost" size="sm" className="mt-2">
        <Link to={card.to}>
          <span>{card.action}</span>
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    </article>
  )
}

function pickNextAction(opts: {
  t: ReturnType<typeof useTranslation>['t']
  pendingAsks: number
  outboxGivingUp: number
  activeJobs: number
  outboxPending: number
  automationCount: number
}): NextAction {
  const id: NextActionId = opts.pendingAsks > 0
    ? 'asks'
    : opts.outboxGivingUp > 0
      ? 'outboxStuck'
      : opts.activeJobs > 0
        ? 'jobs'
        : opts.outboxPending > 0
          ? 'outbox'
          : opts.automationCount > 0
            ? 'automation'
            : 'idle'
  const to: Record<NextActionId, string> = {
    asks:        '/tasks/asks',
    outboxStuck: '/tasks/outbox',
    jobs:        '/tasks/jobs',
    outbox:      '/tasks/outbox',
    automation:  '/tasks/schedules',
    idle:        '/tasks/jobs',
  }
  return {
    id,
    to: to[id],
    title: opts.t(`overview.next.${id}.title`),
    detail: opts.t(`overview.next.${id}.detail`),
  }
}
