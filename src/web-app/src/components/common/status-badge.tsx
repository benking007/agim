/**
 * StatusBadge — domain status string → Badge variant + label.
 *
 * Single source of truth for the color mapping across the 4 M2 pages
 * (jobs / approvals / reminders / memos) plus the M3 observability
 * page. Without this every page would invent its own (job status
 * "running" mapped to "warning" on tasks.html, "info" on approvals.
 * html, "secondary" on observability — the kind of drift the v2
 * rewrite is supposed to eliminate).
 *
 * The label slot is intentionally a child rather than a prop: callers
 * pass i18n'd strings via `<StatusBadge status="running">{t('jobs.
 * status.running')}</StatusBadge>` so the badge stays language-aware
 * without needing useTranslation here.
 *
 * Unknown status falls back to `default` variant (neutral gray pill)
 * so a backend that introduces a new state doesn't crash the page.
 */

import type * as React from 'react'
import { Badge, type BadgeProps } from '@/components/ui/badge'

/**
 * Status palette shared across domain entities. The mapping is
 * deliberately broad — both "succeeded" and "completed" land on
 * success; both "running" and "in_progress" land on info, etc. —
 * because the backend hasn't been canonicalised yet (memory.ts uses
 * one set, jobs.ts another).
 */
const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  // Success-family
  succeeded:  'success',
  completed:  'success',
  done:       'success',
  approved:   'success',
  allowed:    'success',
  delivered:  'success',
  active:     'success',

  // In-flight
  running:    'info',
  in_progress:'info',
  pending:    'info',
  queued:     'info',
  scheduled:  'info',
  open:       'info',

  // Warnings (operator may need to look)
  paused:     'warning',
  awaiting:   'warning',
  timeout:    'warning',
  expired:    'warning',

  // Failed / errored
  failed:     'danger',
  error:      'danger',
  denied:     'danger',
  rejected:   'danger',
  cancelled:  'danger',
  canceled:   'danger',

  // Terminal-neutral
  finished:   'default',
  closed:     'default',
  archived:   'default',
}

export interface StatusBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  status: string
  children?: React.ReactNode
  /** Force-override the auto-mapped variant. */
  variant?: BadgeProps['variant']
}

function StatusBadge({
  status,
  variant,
  children,
  ...rest
}: StatusBadgeProps): JSX.Element {
  const resolved = variant ?? STATUS_VARIANT[status.toLowerCase()] ?? 'default'
  return (
    <Badge variant={resolved} {...rest}>
      {children ?? status}
    </Badge>
  )
}
StatusBadge.displayName = 'StatusBadge'

export { StatusBadge, STATUS_VARIANT }
