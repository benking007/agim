/**
 * /settings/agim-skills — overview surface.
 *
 * The installed / hot / injection pages stay as the source of truth.
 * This entry point answers the first operator question: "is Skills
 * ready, and where should I click next?"
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Flame,
  Puzzle,
  RefreshCcw,
  Wand2,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAgimSkillsList, useSkillInjection } from '@/hooks/use-agim-skills'
import { useSkillsRemoteHot } from '@/hooks/use-skills'
import { cn } from '@/lib/utils'

type CardTone = 'success' | 'warning' | 'danger' | 'info' | 'default'
type NextActionId = 'fixUnavailable' | 'browseHot' | 'reviewOverride' | 'manageInstalled' | 'createSkill'

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

const ROOT = '/settings/agim-skills'

export default function AgimSkillsOverviewRoute(): JSX.Element {
  const { t } = useTranslation('settings')
  const skillsQuery = useAgimSkillsList()
  const hotQuery = useSkillsRemoteHot()
  const injectionQuery = useSkillInjection()

  const skills = skillsQuery.data?.skills ?? []
  const workspaceCount = skills.filter((s) => s.source === 'workspace').length
  const builtinCount = skills.filter((s) => s.source === 'builtin').length
  const unavailableCount = skills.filter((s) => !s.available).length
  const alwaysOnCount = skills.filter((s) => s.always).length
  const hotCount = hotQuery.data?.skills.length ?? 0
  const hotStale = Boolean(hotQuery.data?.stale)
  const hotUnavailable = hotQuery.isError || hotStale
  const overrideActive = Boolean(injectionQuery.data?.overrideActive)
  const autoChars = injectionQuery.data?.autoChars ?? injectionQuery.data?.auto?.length ?? 0
  const overrideChars = injectionQuery.data?.overrideChars ?? injectionQuery.data?.override?.length ?? 0
  const anyFetching = skillsQuery.isFetching || hotQuery.isFetching || injectionQuery.isFetching
  const needsAttention = unavailableCount + (hotUnavailable ? 1 : 0)

  const nextAction = pickNextAction({
    t,
    skillCount: skills.length,
    workspaceCount,
    unavailableCount,
    hotCount,
    overrideActive,
  })

  const cards: MetricCard[] = [
    {
      id: 'installed',
      title: t('agimSkills.overview.cards.installed.title'),
      value: skillsQuery.isLoading ? '-' : skills.length,
      detail: t('agimSkills.overview.cards.installed.detail', {
        workspace: workspaceCount,
        builtin: builtinCount,
      }),
      to: `${ROOT}/installed`,
      action: t('agimSkills.overview.cards.installed.action'),
      tone: skills.length > 0 ? 'info' : 'default',
      icon: <BookOpen />,
    },
    {
      id: 'availability',
      title: t('agimSkills.overview.cards.availability.title'),
      value: skillsQuery.isLoading ? '-' : unavailableCount,
      detail: unavailableCount > 0
        ? t('agimSkills.overview.cards.availability.missing', { count: unavailableCount })
        : t('agimSkills.overview.cards.availability.ready'),
      to: `${ROOT}/installed`,
      action: t('agimSkills.overview.cards.availability.action'),
      tone: unavailableCount > 0 ? 'danger' : 'success',
      icon: unavailableCount > 0 ? <AlertTriangle /> : <CheckCircle2 />,
    },
    {
      id: 'hot',
      title: t('agimSkills.overview.cards.hot.title'),
      value: hotQuery.isLoading ? '-' : hotCount,
      detail: hotQuery.isError
        ? t('agimSkills.overview.cards.hot.error')
        : hotStale
          ? t('agimSkills.overview.cards.hot.stale')
          : t('agimSkills.overview.cards.hot.ready', { count: hotCount }),
      to: `${ROOT}/hot`,
      action: t('agimSkills.overview.cards.hot.action'),
      tone: hotUnavailable ? 'warning' : hotCount > 0 ? 'info' : 'default',
      icon: <Flame />,
    },
    {
      id: 'injection',
      title: t('agimSkills.overview.cards.injection.title'),
      value: overrideActive
        ? t('agimSkills.overview.cards.injection.overrideValue')
        : t('agimSkills.overview.cards.injection.autoValue'),
      detail: overrideActive
        ? t('agimSkills.overview.cards.injection.overrideDetail', { chars: overrideChars.toLocaleString() })
        : t('agimSkills.overview.cards.injection.autoDetail', {
          chars: autoChars.toLocaleString(),
          always: alwaysOnCount,
        }),
      to: `${ROOT}/injection`,
      action: t('agimSkills.overview.cards.injection.action'),
      tone: overrideActive ? 'warning' : 'success',
      icon: <Wand2 />,
    },
  ]

  const views: Array<[string, string, LucideIcon]> = [
    ['installed', `${ROOT}/installed`, BookOpen],
    ['hot', `${ROOT}/hot`, Flame],
    ['injection', `${ROOT}/injection`, Puzzle],
  ]

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{t('agimSkills.overview.title')}</h1>
            <Badge variant={needsAttention > 0 ? 'warning' : 'success'}>
              {needsAttention > 0
                ? t('agimSkills.overview.needsAttention', { count: needsAttention })
                : t('agimSkills.overview.ready')}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-text-dim">{t('agimSkills.overview.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={anyFetching}
          onClick={() => {
            void skillsQuery.refetch()
            void hotQuery.refetch()
            void injectionQuery.refetch()
          }}
        >
          <RefreshCcw className={cn('h-4 w-4', anyFetching && 'animate-spin')} />
          <span>{t('agimSkills.overview.refresh')}</span>
        </Button>
      </header>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
          <h2 className="text-sm font-semibold">{t('agimSkills.overview.views.title')}</h2>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
            {views.map(([id, to, Icon]) => (
              <Button key={id} asChild variant="secondary" size="sm">
                <Link to={to}>
                  <Icon className="h-4 w-4" />
                  <span>{t(`agimSkills.tab.${id}`)}</span>
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
  skillCount: number
  workspaceCount: number
  unavailableCount: number
  hotCount: number
  overrideActive: boolean
}): NextAction {
  const id: NextActionId = opts.unavailableCount > 0
    ? 'fixUnavailable'
    : opts.skillCount === 0
      ? 'createSkill'
      : opts.workspaceCount === 0 && opts.hotCount > 0
        ? 'browseHot'
        : opts.overrideActive
          ? 'reviewOverride'
          : 'manageInstalled'

  const to: Record<NextActionId, string> = {
    fixUnavailable: `${ROOT}/installed`,
    browseHot:      `${ROOT}/hot`,
    reviewOverride: `${ROOT}/injection`,
    manageInstalled: `${ROOT}/installed`,
    createSkill:    `${ROOT}/installed`,
  }
  return {
    id,
    to: to[id],
    title: opts.t(`agimSkills.overview.next.${id}.title`),
    detail: opts.t(`agimSkills.overview.next.${id}.detail`),
  }
}
