/**
 * In-page Jobs / Subtasks switch. Canonical URL is /tasks/jobs;
 * subtasks use ?kind=subtasks. /tasks/subtasks redirects here.
 */

import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export type WorkKind = 'jobs' | 'subtasks'

export function readWorkKind(params: URLSearchParams): WorkKind {
  return params.get('kind') === 'subtasks' ? 'subtasks' : 'jobs'
}

export function WorkKindTabs(): JSX.Element {
  const { t } = useTranslation('tasks')
  const location = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const kind = readWorkKind(params)

  function setKind(next: WorkKind): void {
    const p = new URLSearchParams(params)
    if (next === 'jobs') {
      p.delete('kind')
      p.delete('agent')
    } else {
      p.set('kind', 'subtasks')
      p.delete('status')
      p.delete('page')
      p.delete('per_page')
    }
    const search = p.toString()
    if (!location.pathname.endsWith('/jobs')) {
      navigate({ pathname: '/tasks/jobs', search })
      return
    }
    setParams(p, { replace: false })
  }

  return (
    <div
      role="tablist"
      aria-label={t('work.viewsLabel')}
      className="flex shrink-0 items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {(['jobs', 'subtasks'] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={kind === id}
          className={cn(
            'rounded-md px-3 py-1 text-sm transition-colors tap-target',
            kind === id
              ? 'bg-brand-50 font-medium text-brand-600 shadow-sm dark:bg-accent-bg dark:text-accent'
              : 'text-text-dim hover:text-text',
          )}
          onClick={() => setKind(id)}
        >
          {t(id === 'jobs' ? 'subnav.jobs' : 'subnav.subtasks')}
        </button>
      ))}
    </div>
  )
}
