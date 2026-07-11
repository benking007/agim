/**
 * Badge — compact pill for status / metadata. Used by StatusBadge
 * (components/common/) to map domain statuses (job/approval/reminder)
 * onto a consistent palette.
 *
 * The variant names here are intentionally narrow — only the colors
 * the design system reserves for status. Layout-only badges (e.g. a
 * count of selected rows) compose `variant="secondary"` plus extra
 * classes via `className`.
 */

import type * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  [
    'inline-flex items-center gap-1',
    'rounded-full border px-2 py-0.5',
    'text-xs font-semibold uppercase tracking-wide leading-5',
    'transition-colors',
  ].join(' '),
  {
    variants: {
      variant: {
        default:    'bg-surface-2 text-text-dim border-transparent',
        secondary:  'bg-surface-2 text-text border-border',
        outline:    'bg-transparent text-text-dim border-border',
        success:    'bg-success-bg text-success border-transparent',
        warning:    'bg-warning-bg text-warning border-transparent',
        danger:     'bg-danger-bg text-danger border-transparent',
        info:       'bg-info-bg text-info border-transparent',
        accent:     'bg-accent-bg text-accent border-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
