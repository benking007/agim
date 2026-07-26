/**
 * Providers — single wrapping shell composing the cross-cutting
 * providers every route depends on: QueryClient, i18n, theme
 * application, tooltip provider, toaster mount.
 *
 * Kept as one component (rather than splitting into ProviderTree +
 * Toaster + ...) so a future addition (e.g. <ErrorBoundary>) lands
 * in one obvious spot and the route layer never imports providers
 * directly.
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { queryClient } from '@/lib/query-client'
import { syncI18nLanguage } from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { useApplyTheme, usePrefs } from '@/stores/prefs'
import { bindAuthToStorage } from '@/stores/auth'

function LanguageBinder({ children }: { children: React.ReactNode }): JSX.Element {
  // Keep the i18next instance in lockstep with the zustand store —
  // setLang in the store fires, this effect runs, i18next changes
  // language, every useTranslation() resubscribes automatically.
  const lang = usePrefs((s) => s.lang)
  const { i18n } = useTranslation()
  useEffect(() => {
    if (i18n.language !== lang) {
      syncI18nLanguage(lang)
    }
  }, [lang, i18n])
  return <>{children}</>
}

function ThemeBinder({ children }: { children: React.ReactNode }): JSX.Element {
  useApplyTheme()
  return <>{children}</>
}

function AuthBinder({ children }: { children: React.ReactNode }): JSX.Element {
  // Cross-tab sync: sign-out in one tab flips others to /login on
  // their next render. The lib/api/client.ts 401 handler covers the
  // single-tab case; this catches the multi-tab one.
  useEffect(() => bindAuthToStorage(), [])
  return <>{children}</>
}

export function Providers({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageBinder>
        <ThemeBinder>
          <AuthBinder>
            <TooltipProvider>
              {children}
              <Toaster />
            </TooltipProvider>
          </AuthBinder>
        </ThemeBinder>
      </LanguageBinder>
    </QueryClientProvider>
  )
}
