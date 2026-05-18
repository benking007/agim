/**
 * Home route — temporary landing page after sign-in. PR-6 replaces
 * this with the actual chat route (WS streaming, agent picker,
 * approval cards). Keep it minimal so it doesn't grow accidental
 * features that block the chat handoff.
 */

import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/endpoints'
import { describeError } from '@/lib/api/errors'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export default function HomeRoute(): JSX.Element {
  const { t } = useTranslation()
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  })

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('appName')} — {t('states.saved')}
      </h1>
      <p className="mt-2 text-sm text-text-dim">
        {t('home.placeholder', {
          defaultValue:
            'Signed in. The chat surface ships in PR-6; this route is intentionally blank.',
        })}
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('home.healthCheck', { defaultValue: 'Backend reachable' })}</CardTitle>
          <CardDescription>GET /api/health</CardDescription>
        </CardHeader>
        <CardContent>
          {health.isPending && (
            <div className="text-sm text-text-dim">{t('states.loading')}</div>
          )}
          {health.error && (
            <div className="text-sm text-danger">{describeError(health.error, t).message}</div>
          )}
          {health.data !== undefined && (
            <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-xs">
{JSON.stringify(health.data, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
