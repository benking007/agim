/**
 * /memory — overview surface.
 *
 * The detailed memory tabs remain the source of truth. This page
 * summarizes the bank in human terms: users, facts, personas,
 * extraction backlog, and vector recall readiness.
 */

import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  Brain,
  Database,
  FileText,
  RefreshCcw,
  Search,
  Sparkles,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  useConsolidateStatus,
  useDistillStatus,
  useMemoryUsers,
} from '@/hooks/use-memory'
import { useVectorStatus } from '@/hooks/use-vector'
import { cn } from '@/lib/utils'

type CardTone = 'success' | 'warning' | 'danger' | 'info' | 'default'
type NextActionId = 'pickUser' | 'createMemory' | 'persona' | 'distill' | 'vector' | 'facts'

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
  id: NextActionId
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

export default function MemoryOverviewRoute(): JSX.Element {
  const { t } = useTranslation('memory')
  const [params] = useSearchParams()
  const userKey = params.get('user') ?? ''

  const usersQuery = useMemoryUsers()
  const consolidateQuery = useConsolidateStatus()
  const distillQuery = useDistillStatus()
  const vectorQuery = useVectorStatus(userKey ? { user_key: userKey } : {})

  const users = usersQuery.data?.users ?? []
  const selectedUser = userKey ? users.find((u) => u.user_key === userKey) : undefined
  const totalFacts = users.reduce((sum, u) => sum + u.fact_count, 0)
  const personaCount = users.filter((u) => u.has_persona).length
  const selectedFacts = selectedUser?.fact_count ?? 0
  const selectedHasPersona = Boolean(selectedUser?.has_persona)

  const consolidateJobs = consolidateQuery.data?.jobs ?? []
  const runningConsolidate = consolidateJobs.some((j) => j.phase === 'running')
  const failedConsolidate = consolidateJobs.some((j) => j.phase === 'failed')
  const distill = distillQuery.data
  const vector = vectorQuery.data
  const coverage = vector?.coverage
  const vectorReady = Boolean(vector?.status.ready)
  const vectorOff = vector?.status.backend === 'off'
  const coveragePercent = coverage && coverage.total > 0
    ? Math.round((coverage.withEmbedding / coverage.total) * 100)
    : 0
  const coverageGap = coverage
    ? Math.max(0, coverage.total - coverage.withEmbedding)
    : 0

  const healthIssues = [
    distill?.lastError,
    failedConsolidate,
    !vectorOff && coverageGap > 0,
  ].filter(Boolean).length
  const anyFetching = usersQuery.isFetching
    || consolidateQuery.isFetching
    || distillQuery.isFetching
    || vectorQuery.isFetching

  const nextAction = pickNextAction({
    t,
    userKey,
    hasUsers: users.length > 0,
    selectedFacts,
    selectedHasPersona,
    distillPending: distill?.pendingTotal ?? 0,
    vectorNeedsBackfill: !vectorOff && coverageGap > 0,
  })

  const cards: MetricCard[] = [
    {
      id: 'bank',
      title: t('overview.cards.bank.title'),
      value: users.length,
      detail: t('overview.cards.bank.detail', { facts: totalFacts, personas: personaCount }),
      to: withUser('/memory/facts', userKey),
      action: t('overview.cards.bank.action'),
      tone: users.length > 0 ? 'info' : 'default',
      icon: <Database />,
    },
    {
      id: 'selected',
      title: t('overview.cards.selected.title'),
      value: userKey ? selectedFacts : '-',
      detail: userKey
        ? selectedHasPersona
          ? t('overview.cards.selected.ready', { user: userKey })
          : t('overview.cards.selected.noPersona', { user: userKey })
        : t('overview.cards.selected.empty'),
      to: withUser('/memory/persona', userKey),
      action: t('overview.cards.selected.action'),
      tone: userKey ? selectedHasPersona ? 'success' : 'warning' : 'default',
      icon: <Brain />,
    },
    {
      id: 'distill',
      title: t('overview.cards.distill.title'),
      value: distill?.pendingTotal ?? 0,
      detail: distill?.running
        ? t('overview.cards.distill.running')
        : distill?.lastError
          ? t('overview.cards.distill.error')
          : distill?.enabled
            ? t('overview.cards.distill.ready')
            : t('overview.cards.distill.off'),
      to: '/memory/distill',
      action: t('overview.cards.distill.action'),
      tone: distill?.lastError ? 'danger' : (distill?.pendingTotal ?? 0) > 0 ? 'warning' : 'success',
      icon: <Sparkles />,
    },
    {
      id: 'consolidate',
      title: t('overview.cards.consolidate.title'),
      value: personaCount,
      detail: runningConsolidate
        ? t('overview.cards.consolidate.running')
        : failedConsolidate
          ? t('overview.cards.consolidate.failed')
          : t('overview.cards.consolidate.detail', { count: personaCount }),
      to: withUser('/memory/persona', userKey),
      action: t('overview.cards.consolidate.action'),
      tone: failedConsolidate ? 'danger' : runningConsolidate ? 'warning' : personaCount > 0 ? 'success' : 'default',
      icon: <FileText />,
    },
    {
      id: 'vector',
      title: t('overview.cards.vector.title'),
      value: vectorOff ? t('overview.cards.vector.offValue') : `${coveragePercent}%`,
      detail: vectorOff
        ? t('overview.cards.vector.off')
        : vectorReady
          ? t('overview.cards.vector.ready', { embedded: coverage?.withEmbedding ?? 0, total: coverage?.total ?? 0 })
          : t('overview.cards.vector.notReady'),
      to: withUser('/memory/vector', userKey),
      action: t('overview.cards.vector.action'),
      tone: vectorOff ? 'default' : vectorReady && coverageGap === 0 ? 'success' : 'warning',
      icon: <Search />,
    },
  ]

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{t('overview.title')}</h1>
            <Badge variant={healthIssues > 0 ? 'warning' : 'success'}>
              {healthIssues > 0
                ? t('overview.needsAttention', { count: healthIssues })
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
            void usersQuery.refetch()
            void consolidateQuery.refetch()
            void distillQuery.refetch()
            void vectorQuery.refetch()
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
          <h2 className="text-sm font-semibold">{t('overview.views.title')}</h2>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {([
              ['facts', withUser('/memory/facts', userKey)],
              ['persona', withUser('/memory/persona', userKey)],
              ['distill', '/memory/distill'],
              ['vector', withUser('/memory/vector', userKey)],
            ] satisfies Array<[string, string]>).map(([id, to]) => (
              <Button key={id} asChild variant="secondary" size="sm">
                <Link to={to}>
                  <span>{t(`tabs.${id}`)}</span>
                </Link>
              </Button>
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
          {card.icon}
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
  userKey: string
  hasUsers: boolean
  selectedFacts: number
  selectedHasPersona: boolean
  distillPending: number
  vectorNeedsBackfill: boolean
}): NextAction {
  const id: NextActionId = !opts.hasUsers
    ? 'createMemory'
    : !opts.userKey
      ? 'pickUser'
      : opts.selectedFacts > 0 && !opts.selectedHasPersona
        ? 'persona'
        : opts.distillPending > 0
          ? 'distill'
          : opts.vectorNeedsBackfill
            ? 'vector'
            : 'facts'
  const to: Record<NextActionId, string> = {
    pickUser:      '/memory',
    createMemory: '/?welcome=1',
    persona:      withUser('/memory/persona', opts.userKey),
    distill:      '/memory/distill',
    vector:       withUser('/memory/vector', opts.userKey),
    facts:        withUser('/memory/facts', opts.userKey),
  }
  return {
    id,
    to: to[id],
    title: opts.t(`overview.next.${id}.title`),
    detail: opts.t(`overview.next.${id}.detail`),
  }
}

function withUser(path: string, userKey: string): string {
  return userKey ? `${path}?user=${encodeURIComponent(userKey)}` : path
}
