/**
 * /settings/start — low-friction setup runway.
 *
 * This page does not replace the detailed settings pages. It gives new
 * operators a small number of visible next steps, each linking to the
 * existing page that owns the actual configuration.
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Loader2,
  MessageSquare,
  Plug,
  RefreshCcw,
  Server,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useLlmList } from '@/hooks/use-llm-admin'
import { useConfig, useServiceStatus } from '@/hooks/use-settings'
import { useAgentsStatus } from '@/hooks/use-workspace'
import { agentDisplayName } from '@/lib/agent-label'
import { cn } from '@/lib/utils'

type StepState = 'done' | 'todo' | 'warn' | 'loading'

interface SetupStep {
  id: string
  state: StepState
  icon: JSX.Element
  title: string
  detail: string
  action: string
  to: string
}

const STATE_BADGE: Record<StepState, 'success' | 'warning' | 'info' | 'outline'> = {
  done:    'success',
  todo:    'outline',
  warn:    'warning',
  loading: 'info',
}

export default function SettingsStartRoute(): JSX.Element {
  const { t } = useTranslation('settings')
  const cfgQuery = useConfig()
  const serviceQuery = useServiceStatus()
  const agentsQuery = useAgentsStatus()
  const llmQuery = useLlmList()

  const cfg = cfgQuery.data
  const defaultAgent = cfg?.defaultAgent || cfg?.agents?.[0] || ''
  const agentName = defaultAgent ? agentDisplayName(defaultAgent) : t('start.unknown')
  const agentStatus = defaultAgent ? agentsQuery.data?.[defaultAgent] : undefined
  const agentLoading = cfgQuery.isLoading || agentsQuery.isLoading
  const service = serviceQuery.data
  const serviceRunning = Boolean(service && service.mode !== 'none')
  const usableBackends = (llmQuery.data?.backends ?? []).filter((b) => b.secret.source !== 'none')
  const llmReady = usableBackends.length > 0
  const messengers = cfg?.messengers ?? []
  const imReady = messengers.length > 0

  const webState: StepState = serviceQuery.isLoading ? 'loading' : serviceRunning ? 'done' : 'warn'
  const agentState: StepState = agentLoading
    ? 'loading'
    : agentStatus === true
      ? 'done'
      : agentStatus === false
        ? 'warn'
        : defaultAgent
          ? 'todo'
          : 'warn'
  const llmState: StepState = llmQuery.isLoading ? 'loading' : llmReady ? 'done' : 'todo'
  const imState: StepState = cfgQuery.isLoading ? 'loading' : imReady ? 'done' : 'todo'

  const doneCount = [webState, agentState, imState, llmState].filter((s) => s === 'done').length
  const steps: SetupStep[] = [
    {
      id: 'web',
      state: webState,
      icon: <MessageSquare />,
      title: t('start.steps.web.title'),
      detail: serviceRunning
        ? t('start.steps.web.ready', { mode: service?.mode ?? '' })
        : t('start.steps.web.needsStart'),
      action: t('start.steps.web.action'),
      to: '/?welcome=1',
    },
    {
      id: 'agent',
      state: agentState,
      icon: <Bot />,
      title: t('start.steps.agent.title'),
      detail: agentStatus === true
        ? t('start.steps.agent.ready', { agent: agentName })
        : agentStatus === false
          ? t('start.steps.agent.offline', { agent: agentName })
          : defaultAgent
            ? t('start.steps.agent.selected', { agent: agentName })
            : t('start.steps.agent.empty'),
      action: t('start.steps.agent.action'),
      to: '/settings/agents',
    },
    {
      id: 'llm',
      state: llmState,
      icon: <Bot />,
      title: t('start.steps.llm.title'),
      detail: llmReady
        ? t('start.steps.llm.ready', { count: usableBackends.length })
        : t('start.steps.llm.empty'),
      action: t('start.steps.llm.action'),
      to: '/settings/llm',
    },
    {
      id: 'im',
      state: imState,
      icon: <Plug />,
      title: t('start.steps.im.title'),
      detail: imReady
        ? t('start.steps.im.ready', { platforms: messengers.map((m) => platformLabel(m, t)).join(', ') })
        : t('start.steps.im.empty'),
      action: t('start.steps.im.action'),
      to: '/settings/messengers',
    },
  ]

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{t('start.title')}</h1>
            <Badge variant={doneCount >= 3 ? 'success' : 'info'}>{doneCount}/4</Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-text-dim">{t('start.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to="/?welcome=1">
              <MessageSquare className="h-4 w-4" />
              <span>{t('start.actions.chat')}</span>
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={cfgQuery.isFetching || serviceQuery.isFetching || agentsQuery.isFetching || llmQuery.isFetching}
            onClick={() => {
              void cfgQuery.refetch()
              void serviceQuery.refetch()
              void agentsQuery.refetch()
              void llmQuery.refetch()
            }}
          >
            <RefreshCcw
              className={cn(
                'h-4 w-4',
                (cfgQuery.isFetching || serviceQuery.isFetching || agentsQuery.isFetching || llmQuery.isFetching)
                  && 'animate-spin',
              )}
            />
            <span>{t('start.actions.refresh')}</span>
          </Button>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        {steps.map((step) => (
          <SetupStepCard key={step.id} step={step} />
        ))}
      </section>

      <section className="rounded-md border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-dim">
            <Server className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t('start.deploy.title')}</h2>
            <p className="mt-1 text-sm text-text-dim">{t('start.deploy.detail')}</p>
          </div>
          <Button asChild variant="secondary" size="sm">
            <Link to="/settings/service">
              <span>{t('start.deploy.action')}</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  )
}

function SetupStepCard({ step }: { step: SetupStep }): JSX.Element {
  const { t } = useTranslation('settings')
  const done = step.state === 'done'
  return (
    <article className="rounded-md border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2',
            step.state === 'done' && 'text-success',
            step.state === 'warn' && 'text-warning',
            step.state === 'todo' && 'text-text-dim',
            step.state === 'loading' && 'text-info',
            '[&_svg]:h-4 [&_svg]:w-4',
          )}
          aria-hidden="true"
        >
          {step.state === 'done'
            ? <CheckCircle2 />
            : step.state === 'warn'
              ? <AlertCircle />
              : step.state === 'loading'
                ? <Loader2 className="animate-spin" />
                : step.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{step.title}</h2>
            <Badge variant={STATE_BADGE[step.state]}>{t(`start.state.${step.state}`)}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-dim">{step.detail}</p>
          <Button asChild variant={done ? 'ghost' : 'secondary'} size="sm" className="mt-3">
            <Link to={step.to}>
              <span>{step.action}</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </article>
  )
}

function platformLabel(id: string, t: ReturnType<typeof useTranslation>['t']): string {
  const labels: Record<string, string> = {
    'wechat-ilink': t('messengers.platform.wechat'),
    telegram:       t('messengers.platform.telegram'),
    feishu:         t('messengers.platform.feishu'),
    dingtalk:       t('messengers.platform.dingtalk'),
    discord:        t('messengers.platform.discord'),
    email:          t('tabs.email'),
  }
  return labels[id] ?? id
}
