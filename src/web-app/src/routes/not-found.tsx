/**
 * 404 — fallback for unknown paths. Designed to be lightweight: no
 * data fetches, no providers needed beyond what's in the router root.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export default function NotFoundRoute(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 text-center">
      <div>
        <div className="text-6xl font-bold text-text-muted">404</div>
        <h1 className="mt-2 text-xl font-semibold">
          {t('notFound.title', { defaultValue: 'Nothing here.' })}
        </h1>
        <p className="mt-2 text-sm text-text-dim">
          {t('notFound.description', {
            defaultValue: "The page you're looking for doesn't exist.",
          })}
        </p>
        <Button asChild className="mt-4">
          <Link to="/">{t('actions.back')}</Link>
        </Button>
      </div>
    </div>
  )
}
