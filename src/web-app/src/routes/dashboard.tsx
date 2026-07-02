/**
 * /dashboard — operator home.
 *
 * Keep this page as a routing surface, not a second settings page: it
 * summarizes the minimum path and links to the detailed owner pages.
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ClipboardList,
  Database,
  Loader2,
  MessageSquare,
  Plug,
  RefreshCcw,
  Server,
  Settings,
  ShieldCheck,
} from 'lucide-react'

import { Topbar } from '@/components/shell/topbar'
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
}

interface DashboardAction {
  id: string
  title: string
  detail: string
  to: string
  primary?: boolean
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
  const nativeAgentSelected = defaultAgent === 'native'
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
      icon: <Bot />,
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

  const quickLinks = [
    { to: '/?welcome=1', icon: <MessageSquare />, title: t('dashboard.quick.chat') },
    { to: '/settings/start', icon: <Settings />, title: t('dashboard.quick.start') },
    { to: '/workspace', icon: <Database />, title: t('dashboard.quick.workspace') },
    { to: '/settings/service', icon: <Server />, title: t('dashboard.quick.service') },
  ]
  const advancedLinks = [
    { to: '/tasks', icon: <ClipboardList />, title: t('dashboard.advanced.tasks') },
    { to: '/memory', icon: <Database />, title: t('dashboard.advanced.memory') },
    { to: '/settings/agim-skills/installed', icon: <ShieldCheck />, title: t('dashboard.advanced.skills') },
    { to: '/observability', icon: <Server />, title: t('dashboard.advanced.observability') },
  ]

  return (
    <div className="min-h-dvh bg-bg">
      <Topbar />
      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6">
        <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{t('dashboard.title')}</h1>
              <Badge variant={coreReadyCount >= 3 ? 'success' : 'info'}>
                {t('dashboard.coreReady', { count: coreReadyCount })}
              </Badge>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-text-dim">{t('dashboard.subtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link to="/?welcome=1">
                <MessageSquare className="h-4 w-4" />
                <span>{t('dashboard.actions.chat')}</span>
              </Link>
            </Button>
            <Button
              type="button"
              variant="ghost"
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

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => (
            <StatusCardItem key={card.id} card={card} />
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
          <section className="rounded-md border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{t('dashboard.next.title')}</h2>
              <Badge variant={coreReadyCount >= 3 ? 'success' : 'secondary'}>
                {t(coreReadyCount >= 3 ? 'dashboard.next.ready' : 'dashboard.next.pending')}
              </Badge>
            </div>
            <div className="grid gap-2">
              {nextActions.map((action) => (
                <Link
                  key={action.id}
                  to={action.to}
                  className={cn(
                    'group flex min-h-16 items-center gap-3 rounded-md border border-border p-3 no-underline',
                    'hover:border-border-strong hover:bg-surface-hover',
                    action.primary && 'border-accent bg-accent-bg/45',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-dim',
                      action.primary && 'bg-accent text-accent-fg',
                    )}
                    aria-hidden="true"
                  >
                    <ArrowRight className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-text">{action.title}</span>
                    <span className="mt-0.5 block text-sm text-text-dim">{action.detail}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-text-dim transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">{t('dashboard.quick.title')}</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {quickLinks.map((link) => (
                <DashboardLink key={link.to} {...link} />
              ))}
            </div>
            <h2 className="mt-4 text-sm font-semibold">{t('dashboard.advanced.title')}</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {advancedLinks.map((link) => (
                <DashboardLink key={link.to} {...link} />
              ))}
            </div>
          </section>
        </section>
      </main>
    </div>
  )
}

function StatusCardItem({ card }: { card: StatusCard }): JSX.Element {
  const { t } = useTranslation()
  const done = card.state === 'done'
  return (
    <article className="rounded-md border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2',
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
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{card.title}</h2>
            <Badge variant={STATE_BADGE[card.state]}>{t(`dashboard.state.${card.state}`)}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-dim">{card.detail}</p>
          {card.meta && <p className="mt-1 truncate text-xs text-text-muted">{card.meta}</p>}
          <Button asChild variant={done ? 'ghost' : 'secondary'} size="sm" className="mt-3">
            <Link to={card.to}>
              <span>{card.action}</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </article>
  )
}

function DashboardLink({
  to,
  icon,
  title,
}: {
  to: string
  icon: JSX.Element
  title: string
}): JSX.Element {
  return (
    <Link
      to={to}
      className={cn(
        'flex min-h-12 items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 no-underline',
        'text-sm font-medium text-text hover:bg-surface-hover',
        '[&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0',
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  )
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
