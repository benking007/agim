/**
 * /dashboard — operator home.
 *
 * Keep this page as a routing surface, not a second settings page: it
 * summarizes the minimum path and links to the detailed owner pages.
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Code2,
  Database,
  Loader2,
  MessageSquare,
  Plug,
  RefreshCcw,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'

import { WorkbenchFrame } from '@/components/shell/workbench-frame'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useLlmList } from '@/hooks/use-llm-admin'
import { useConfig, useServiceStatus } from '@/hooks/use-settings'
import { useAgentsStatus } from '@/hooks/use-workspace'
import { agentDisplayName } from '@/lib/agent-label'
import { cn } from '@/lib/utils'

type StatusState = 'done' | 'todo' | 'warn' | 'loading'
type BadgeVariant = 'success' | 'warning' | 'info' | 'outline'

interface StatusCard {
  id: string
  state: StatusState
  icon: JSX.Element
  title: string
  detail: string
  meta?: string
  action: string
  to: string
  tone: 'success' | 'accent' | 'info' | 'warning'
}

interface DashboardAction {
  id: string
  title: string
  detail: string
  to: string
  primary?: boolean
}

interface DashboardLinkItem {
  to: string
  icon: JSX.Element
  title: string
  detail: string
}

const STATE_BADGE: Record<StatusState, BadgeVariant> = {
  done:    'success',
  todo:    'outline',
  warn:    'warning',
  loading: 'info',
}

export default function DashboardRoute(): JSX.Element {
  const { t } = useTranslation()
  const cfgQuery = useConfig()
  const serviceQuery = useServiceStatus()
  const agentsQuery = useAgentsStatus()
  const llmQuery = useLlmList()

  const cfg = cfgQuery.data
  const defaultAgent = cfg?.defaultAgent || cfg?.agents?.[0] || ''
  const agentName = defaultAgent ? agentDisplayName(defaultAgent) : t('dashboard.unknown')
  const nativeAgentSelected = defaultAgent === 'agim' || defaultAgent === 'native'
  const agentStatus = defaultAgent ? agentsQuery.data?.[defaultAgent] : undefined
  const agentLoading = cfgQuery.isLoading || agentsQuery.isLoading
  const service = serviceQuery.data
  const serviceRunning = Boolean(service && service.mode !== 'none')
  const usableBackends = (llmQuery.data?.backends ?? []).filter((b) => b.secret.source !== 'none')
  const llmReady = usableBackends.length > 0
  const messengers = cfg?.messengers ?? []
  const imReady = messengers.length > 0

  const webState: StatusState = serviceQuery.isLoading ? 'loading' : serviceRunning ? 'done' : 'warn'
  const agentState: StatusState = agentLoading
    ? 'loading'
    : agentStatus === true
      ? 'done'
      : agentStatus === false
        ? 'warn'
        : defaultAgent
          ? 'todo'
          : 'warn'
  const llmState: StatusState = llmQuery.isLoading
    ? 'loading'
    : llmReady
      ? 'done'
      : nativeAgentSelected
        ? 'warn'
        : 'todo'
  const imState: StatusState = cfgQuery.isLoading ? 'loading' : imReady ? 'done' : 'todo'
  const coreReadyCount = [webState, agentState, imState].filter((s) => s === 'done').length
  const anyFetching = cfgQuery.isFetching
    || serviceQuery.isFetching
    || agentsQuery.isFetching
    || llmQuery.isFetching

  const cards: StatusCard[] = [
    {
      id: 'web',
      state: webState,
      icon: <MessageSquare />,
      tone: 'success',
      title: t('dashboard.cards.web.title'),
      detail: serviceRunning
        ? t('dashboard.cards.web.ready', { mode: service?.mode ?? '' })
        : t('dashboard.cards.web.needsStart'),
      meta: service?.web ? `${service.web.bind}:${service.web.port}` : undefined,
      action: serviceRunning
        ? t('dashboard.cards.web.open')
        : t('dashboard.cards.web.action'),
      to: serviceRunning ? '/?welcome=1' : '/settings/service',
    },
    {
      id: 'agent',
      state: agentState,
      icon: <Bot />,
      tone: 'accent',
      title: t('dashboard.cards.agent.title'),
      detail: agentStatus === true
        ? t('dashboard.cards.agent.ready', { agent: agentName })
        : agentStatus === false
          ? t('dashboard.cards.agent.offline', { agent: agentName })
          : defaultAgent
            ? t('dashboard.cards.agent.selected', { agent: agentName })
            : t('dashboard.cards.agent.empty'),
      meta: defaultAgent ? t('dashboard.cards.agent.default') : undefined,
      action: t('dashboard.cards.agent.action'),
      to: '/settings/agents',
    },
    {
      id: 'llm',
      state: llmState,
      icon: <Code2 />,
      tone: 'info',
      title: t('dashboard.cards.llm.title'),
      detail: llmReady
        ? t('dashboard.cards.llm.ready', { count: usableBackends.length })
        : nativeAgentSelected
          ? t('dashboard.cards.llm.required')
          : t('dashboard.cards.llm.optional'),
      meta: nativeAgentSelected
        ? t('dashboard.cards.llm.core')
        : t('dashboard.cards.llm.meta'),
      action: t('dashboard.cards.llm.action'),
      to: '/settings/llm',
    },
    {
      id: 'im',
      state: imState,
      icon: <Plug />,
      tone: 'warning',
      title: t('dashboard.cards.im.title'),
      detail: imReady
        ? t('dashboard.cards.im.ready', { platforms: messengers.map((m) => platformLabel(m, t)).join(', ') })
        : t('dashboard.cards.im.empty'),
      meta: imReady ? t('dashboard.cards.im.metaReady', { count: messengers.length }) : undefined,
      action: t('dashboard.cards.im.action'),
      to: '/settings/messengers',
    },
  ]

  const nextActions = makeNextActions({
    t,
    serviceRunning,
    agentReady: agentState === 'done',
    imReady,
    llmReady,
    nativeAgentSelected,
  })

  const quickLinks: DashboardLinkItem[] = [
    {
      to: '/?welcome=1',
      icon: <MessageSquare />,
      title: t('dashboard.quick.chat'),
      detail: t('dashboard.quick.chatDetail'),
    },
    {
      to: '/settings/start',
      icon: <Settings />,
      title: t('dashboard.quick.start'),
      detail: t('dashboard.quick.startDetail'),
    },
    {
      to: '/workspace',
      icon: <Database />,
      title: t('dashboard.quick.workspace'),
      detail: t('dashboard.quick.workspaceDetail'),
    },
    {
      to: '/settings/service',
      icon: <Server />,
      title: t('dashboard.quick.service'),
      detail: t('dashboard.quick.serviceDetail'),
    },
  ]
  const advancedLinks: DashboardLinkItem[] = [
    {
      to: '/tasks',
      icon: <ClipboardList />,
      title: t('dashboard.advanced.tasks'),
      detail: t('dashboard.advanced.tasksDetail'),
    },
    {
      to: '/memory',
      icon: <BrainCircuit />,
      title: t('dashboard.advanced.memory'),
      detail: t('dashboard.advanced.memoryDetail'),
    },
    {
      to: '/settings/agim-skills/installed',
      icon: <ShieldCheck />,
      title: t('dashboard.advanced.skills'),
      detail: t('dashboard.advanced.skillsDetail'),
    },
    {
      to: '/observability',
      icon: <Activity />,
      title: t('dashboard.advanced.observability'),
      detail: t('dashboard.advanced.observabilityDetail'),
    },
  ]

  return (
    <WorkbenchFrame contentClassName="space-y-5">
          <header className="flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-end">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>{t('dashboard.eyebrow')}</span>
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="font-medium text-text-dim">{t('dashboard.scope')}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold tracking-normal text-text">{t('dashboard.title')}</h1>
                <Badge
                  variant={coreReadyCount >= 3 ? 'success' : 'info'}
                  className="normal-case"
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      coreReadyCount >= 3 ? 'bg-success' : 'bg-info',
                    )}
                  />
                  {t('dashboard.coreReady', { count: coreReadyCount })}
                </Badge>
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">{t('dashboard.subtitle')}</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" className="shadow-[var(--ag-shadow-sm)]">
                <Link to="/?welcome=1">
                  <MessageSquare className="h-4 w-4" />
                  <span>{t('dashboard.actions.chat')}</span>
                </Link>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={anyFetching}
                onClick={() => {
                  void cfgQuery.refetch()
                  void serviceQuery.refetch()
                  void agentsQuery.refetch()
                  void llmQuery.refetch()
                }}
              >
                <RefreshCcw className={cn('h-4 w-4', anyFetching && 'animate-spin')} />
                <span>{t('actions.refresh')}</span>
              </Button>
            </div>
          </header>

          <section className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            {cards.map((card) => (
              <StatusCardItem key={card.id} card={card} />
            ))}
          </section>

          <section className="grid gap-5 xl:grid-cols-12">
            <section className="xl:col-span-7 rounded-xl border border-border bg-surface p-6 shadow-sm">
              <div className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
                <div>
                  <h2 className="flex items-center gap-2 text-base font-bold text-text">
                    <Sparkles className="h-4 w-4 text-brand-600" />
                    {t('dashboard.next.title')}
                  </h2>
                  <p className="mt-1 text-sm text-text-muted">{t('dashboard.next.subtitle')}</p>
                </div>
                <Badge variant={coreReadyCount >= 3 ? 'success' : 'secondary'} className="normal-case">
                  {t(coreReadyCount >= 3 ? 'dashboard.next.ready' : 'dashboard.next.pending')}
                </Badge>
              </div>
              <div className="space-y-3">
                {nextActions.map((action, index) => (
                  <NextActionItem
                    key={action.id}
                    action={action}
                    index={index}
                  />
                ))}
              </div>
            </section>

            <section className="xl:col-span-5 grid gap-5">
              <section className="rounded-xl border border-border bg-surface p-6 shadow-sm">
                <h2 className="flex items-center gap-2 text-sm font-bold text-text">
                  <span className="h-3 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
                  {t('dashboard.quick.title')}
                </h2>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {quickLinks.map((link) => (
                    <DashboardLink key={link.to} {...link} />
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-border bg-surface p-6 shadow-sm">
                <h2 className="flex items-center gap-2 text-sm font-bold text-text">
                  <span className="h-3 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
                  {t('dashboard.advanced.title')}
                </h2>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {advancedLinks.map((link) => (
                    <DashboardLink key={link.to} {...link} />
                  ))}
                </div>
              </section>
            </section>
          </section>

    </WorkbenchFrame>
  )
}

function StatusCardItem({ card }: { card: StatusCard }): JSX.Element {
  const { t } = useTranslation()
  const done = card.state === 'done'
  const tone = statusTone(card.tone)
  return (
    <article
      className={cn(
        'group relative overflow-hidden rounded-xl border border-border bg-surface p-5',
        'transition-all duration-300 hover:-translate-y-1 hover:border-brand-500/50 hover:shadow-xl',
      )}
    >
      <div className={cn('absolute inset-x-0 top-0 h-1', tone.bar)} aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
            done ? tone.iconReady : tone.iconIdle,
            card.state === 'done' && 'text-success',
            card.state === 'warn' && 'text-warning',
            card.state === 'todo' && 'text-text-dim',
            card.state === 'loading' && 'text-info',
            '[&_svg]:h-4 [&_svg]:w-4',
          )}
          aria-hidden="true"
        >
          {card.state === 'done'
            ? <CheckCircle2 />
            : card.state === 'warn'
              ? <AlertCircle />
              : card.state === 'loading'
                ? <Loader2 className="animate-spin" />
                : card.icon}
        </span>
        <Badge variant={STATE_BADGE[card.state]} className="normal-case">
          {t(`dashboard.state.${card.state}`)}
        </Badge>
      </div>
      <div className="mt-4 min-w-0">
        <h2 className="text-sm font-semibold text-text transition-colors group-hover:text-brand-600">{card.title}</h2>
        <p className="mt-1 line-clamp-2 min-h-10 text-sm leading-5 text-text-muted">{card.detail}</p>
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="min-w-0 truncate text-xs font-mono text-text-muted">{card.meta ?? '—'}</span>
          <Link
            to={card.to}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-brand-600 no-underline hover:text-brand-700 hover:underline"
          >
            <span>{card.action}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </article>
  )
}

function NextActionItem({
  action,
  index,
}: {
  action: DashboardAction
  index: number
}): JSX.Element {
  return (
    <Link
      to={action.to}
      className={cn(
        'group relative flex min-h-20 items-start gap-3 rounded-lg border p-4 pl-5 no-underline',
        'transition-all hover:bg-surface-hover hover:shadow-md',
        action.primary
          ? 'border-2 border-brand-500/80 bg-accent-bg/40'
          : 'border-border bg-surface hover:border-border-strong',
      )}
    >
      <span
        className={cn(
          'absolute -left-2.5 -top-2.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold shadow-[var(--ag-shadow-sm)]',
          action.primary ? 'bg-brand-600 text-white' : 'bg-surface-2 text-text-dim',
        )}
        aria-hidden="true"
      >
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 pl-2">
        <span className="block text-sm font-semibold text-text group-hover:text-brand-600">{action.title}</span>
        <span className="mt-1 block text-sm leading-5 text-text-muted">{action.detail}</span>
      </span>
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform group-hover:scale-105',
          action.primary ? 'bg-brand-100 text-brand-600 dark:bg-accent-bg dark:text-accent' : 'bg-surface-2 text-text-muted',
        )}
        aria-hidden="true"
      >
        <ArrowRight className="h-4 w-4" />
      </span>
    </Link>
  )
}

function DashboardLink({
  to,
  icon,
  title,
  detail,
}: {
  to: string
  icon: JSX.Element
  title: string
  detail: string
}): JSX.Element {
  return (
    <Link
      to={to}
      className={cn(
        'group flex min-h-16 items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3 no-underline',
        'transition-all hover:border-brand-100 hover:bg-accent-bg/50',
        '[&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0',
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface text-text-dim group-hover:text-brand-600">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-text group-hover:text-brand-600">{title}</span>
        <span className="mt-0.5 block truncate text-[10px] text-text-muted">{detail}</span>
      </span>
    </Link>
  )
}

function statusTone(tone: StatusCard['tone']): {
  bar: string
  iconReady: string
  iconIdle: string
} {
  switch (tone) {
    case 'success':
      return {
        bar: 'bg-success',
        iconReady: 'bg-success-bg text-success',
        iconIdle: 'bg-success-bg/60 text-success',
      }
    case 'info':
      return {
        bar: 'bg-info',
        iconReady: 'bg-info-bg text-info',
        iconIdle: 'bg-info-bg/60 text-info',
      }
    case 'warning':
      return {
        bar: 'bg-warning',
        iconReady: 'bg-warning-bg text-warning',
        iconIdle: 'bg-warning-bg/60 text-warning',
      }
    default:
      return {
        bar: 'bg-accent',
        iconReady: 'bg-accent-bg text-accent',
        iconIdle: 'bg-accent-bg/60 text-accent',
      }
  }
}

function makeNextActions(opts: {
  t: ReturnType<typeof useTranslation>['t']
  serviceRunning: boolean
  agentReady: boolean
  imReady: boolean
  llmReady: boolean
  nativeAgentSelected: boolean
}): DashboardAction[] {
  const actions: DashboardAction[] = []
  const add = (id: string, to: string, primary = false) => {
    actions.push({
      id,
      to,
      primary,
      title: opts.t(`dashboard.next.items.${id}.title`),
      detail: opts.t(`dashboard.next.items.${id}.detail`),
    })
  }

  if (!opts.serviceRunning) {
    add('service', '/settings/service', true)
    add('agent', '/settings/agents')
    add('chat', '/?welcome=1')
  } else if (!opts.agentReady) {
    if (opts.nativeAgentSelected && !opts.llmReady) {
      add('llm', '/settings/llm', true)
      add('agent', '/settings/agents')
    } else {
      add('agent', '/settings/agents', true)
      add('llm', '/settings/llm')
    }
    add('chat', '/?welcome=1')
  } else {
    add('chat', '/?welcome=1', true)
    if (!opts.imReady) add('im', '/settings/messengers')
    if (!opts.llmReady) add('llmOptional', '/settings/llm')
  }

  if (opts.imReady && opts.serviceRunning && opts.agentReady) {
    add('operate', '/tasks')
  } else if (!opts.imReady && !actions.some((a) => a.id === 'im')) {
    add('im', '/settings/messengers')
  }

  return actions.slice(0, 4)
}

function platformLabel(id: string, t: ReturnType<typeof useTranslation>['t']): string {
  const labels: Record<string, string> = {
    'wechat-ilink': t('dashboard.platform.wechat'),
    telegram:       t('dashboard.platform.telegram'),
    feishu:         t('dashboard.platform.feishu'),
    dingtalk:       t('dashboard.platform.dingtalk'),
    discord:        t('dashboard.platform.discord'),
    email:          t('dashboard.platform.email'),
  }
  return labels[id] ?? id
}
