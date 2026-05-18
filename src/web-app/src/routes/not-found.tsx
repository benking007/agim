/**
 * 404 — fallback for unknown paths. Renders inside the Topbar shell
 * so the operator keeps app-level nav (and can route to any other
 * page from a typo'd URL).
 */

import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'
import { FileQuestion } from 'lucide-react'
import { Topbar } from '@/components/shell/topbar'
import { Button } from '@/components/ui/button'

export default function NotFoundRoute(): JSX.Element {
  const { t } = useTranslation()
  const loc = useLocation()
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <Topbar />
      <main className="grid flex-1 place-items-center px-4 py-8 pb-safe">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-text-dim">
            <FileQuestion className="h-6 w-6" />
          </div>
          <div className="text-6xl font-bold tracking-tight text-text-muted">404</div>
          <h1 className="text-xl font-semibold">
            {t('notFound.title', { defaultValue: 'Nothing here.' })}
          </h1>
          <p className="text-sm text-text-dim">
            {t('notFound.description', {
              defaultValue: "The page you're looking for doesn't exist.",
            })}
          </p>
          <code className="rounded bg-surface-2 px-2 py-0.5 text-xs text-text-muted">{loc.pathname}</code>
          <Button asChild className="mt-2">
            <Link to="/">{t('actions.back')}</Link>
          </Button>
        </div>
      </main>
    </div>
  )
}
