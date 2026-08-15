/**
 * /setup — first-run wizard. Full-screen, no sidebar.
 * Reuses QuickAgentSetupCard so Settings → LLM stays on the same path.
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Loader2, MessageSquare, Settings } from 'lucide-react'

import { QuickAgentSetupCard } from '@/components/setup/quick-agent-setup'
import { Button } from '@/components/ui/button'
import { useLlmList } from '@/hooks/use-llm-admin'
import { useOnboardingStatus, useSkipOnboarding } from '@/hooks/use-onboarding'

export default function SetupRoute(): JSX.Element {
  const { t } = useTranslation(['setup', 'settings', 'common'])
  const navigate = useNavigate()
  const status = useOnboardingStatus()
  const skip = useSkipOnboarding()
  const listQuery = useLlmList()

  async function onSkip(): Promise<void> {
    try {
      await skip.mutateAsync()
    } catch {
      /* still leave the wizard so the operator is not trapped */
    }
    navigate('/', { replace: true })
  }

  if (status.isLoading) {
    return (
      <SetupShell>
        <p className="flex items-center justify-center gap-2 text-sm text-text-dim">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('setup:loading')}
        </p>
      </SetupShell>
    )
  }

  if (status.data?.reason === 'ready') {
    return (
      <SetupShell>
        <h1 className="text-xl font-semibold">{t('setup:alreadyTitle')}</h1>
        <p className="mt-2 text-sm text-text-dim">{t('setup:alreadyBody')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/?welcome=1">
              {t('setup:enterChat')}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/settings/llm">
              <Settings className="h-4 w-4" />
              {t('setup:openSettings')}
            </Link>
          </Button>
        </div>
      </SetupShell>
    )
  }

  return (
    <SetupShell>
      <div className="mb-5 flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-bg text-accent">
          <MessageSquare className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold">{t('setup:title')}</h1>
          <p className="mt-1 text-sm text-text-dim">{t('setup:subtitle')}</p>
        </div>
      </div>

      {listQuery.isLoading ? (
        <div className="h-48 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <QuickAgentSetupCard
          variant="wizard"
          data={listQuery.data}
          onRefresh={() => { void listQuery.refetch() }}
          onComplete={() => navigate('/?welcome=1', { replace: true })}
          onSkip={() => { void onSkip() }}
        />
      )}

      <details className="mt-6 rounded-md border border-border bg-surface-2/60 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">{t('setup:cliTitle')}</summary>
        <p className="mt-2 text-sm text-text-dim">{t('setup:cliBody')}</p>
        <pre className="mt-2 overflow-auto rounded-md bg-surface p-2 text-xs text-text">
          {t('setup:cliHintClaude')}
          {'\n'}
          {t('setup:cliHintCodex')}
        </pre>
      </details>
    </SetupShell>
  )
}

function SetupShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-8">
      <div className="w-full max-w-xl rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">
        {children}
      </div>
    </div>
  )
}
