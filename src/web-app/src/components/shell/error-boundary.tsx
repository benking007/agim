/**
 * ErrorBoundary — catches uncaught render-time errors anywhere in
 * the SPA so a single broken route can't blank the whole console.
 *
 * Mount at the router root once; child routes inherit. Inside a
 * RequireAuth boundary so a thrown error post-login still keeps
 * the user authenticated.
 *
 * React still requires class components for error boundaries (the
 * hook-based equivalent is on the React roadmap but not shipped).
 * This is the only class component we keep in the app.
 *
 * Production behavior: shows a generic apology + the error message
 * (no stack), with a Reload + Back-to-home pair. Dev mode (Vite
 * `import.meta.env.DEV`) additionally shows the component stack
 * so the operator can pin down the failure path.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCcw, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  info: ErrorInfo | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(_error: Error, info: ErrorInfo): void {
    // Capture the component stack for the dev surface. We deliberately
    // don't send this to any telemetry endpoint — adding one now would
    // need its own design (PII review, retention, opt-out).
    this.setState({ info })
  }

  handleReset = (): void => {
    this.setState({ error: null, info: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorFallback
        error={this.state.error}
        info={this.state.info}
        onReset={this.handleReset}
      />
    }
    return this.props.children
  }
}

interface ErrorFallbackProps {
  error: Error
  info: ErrorInfo | null
  onReset: () => void
}

function ErrorFallback({ error, info, onReset }: ErrorFallbackProps): JSX.Element {
  // The boundary may sit OUTSIDE the i18n provider during some
  // test setups, so defaultValue strings shield against an unhooked
  // t() returning the key verbatim.
  const { t } = useTranslation('common')
  const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-8">
      <div className="flex flex-col items-center gap-4 text-center max-w-xl">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-bg text-danger">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold">
          {t('errorBoundary.title', { defaultValue: 'Something went wrong.' })}
        </h1>
        <p className="text-sm text-text-dim">
          {t('errorBoundary.description', {
            defaultValue: 'An unexpected error broke the page render. Try reloading or heading back to the home screen; if it persists, copy the message below and report it.',
          })}
        </p>
        <pre className="w-full max-w-lg overflow-auto rounded-md bg-surface-2 px-3 py-2 text-left text-xs leading-5 text-text-dim">
          {error.name}: {error.message}
        </pre>
        {isDev && info?.componentStack && (
          <details className="w-full max-w-lg text-left text-xs">
            <summary className="cursor-pointer text-text-dim">component stack (dev)</summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-surface-2 px-3 py-2 text-text-muted">
              {info.componentStack}
            </pre>
          </details>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="default"
            onClick={() => {
              onReset()
              // Reload as a last resort — the boundary's reset only
              // clears its local state, but a corrupted module is
              // probably unrecoverable without a fresh JS context.
              if (typeof window !== 'undefined') window.location.reload()
            }}
          >
            <RotateCcw className="h-4 w-4" />
            {t('errorBoundary.reload', { defaultValue: 'Reload' })}
          </Button>
          <Button type="button" variant="secondary" asChild>
            <Link to="/" onClick={onReset}>
              <Home className="h-4 w-4" />
              {t('errorBoundary.home', { defaultValue: 'Home' })}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
