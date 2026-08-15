/**
 * Send first-run visitors to /setup before chat (desktop or /m/chat)
 * can claim the route. Must wrap MobileChatRedirect so a narrow
 * viewport cannot skip the wizard.
 */

import type { ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'

import { useOnboardingStatus } from '@/hooks/use-onboarding'

export function FirstRunRedirect({ children }: { children: ReactNode }): JSX.Element {
  const [searchParams] = useSearchParams()
  const forceWelcome = searchParams.get('welcome') === '1'
  const onboarding = useOnboardingStatus()

  if (onboarding.data?.firstRun && !forceWelcome) {
    return <Navigate to="/setup" replace />
  }
  return <>{children}</>
}
