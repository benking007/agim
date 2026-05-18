/**
 * EmptyState — placeholder shown when a list / table / panel has no
 * rows yet. Used by DataTable's empty branch, by the chat welcome
 * screen (when no messages), and by route bodies that point at an
 * unconfigured / unused subsystem.
 *
 * Slots:
 *   icon         — optional lucide-react icon node. Sits above the
 *                  title. Renders inside a soft surface-2 circle so
 *                  the icon doesn't look stranded on a blank page.
 *   title        — required short headline ("No jobs yet").
 *   description  — optional sub-line; can wrap.
 *   children     — optional action slot for one or two Buttons / Links
 *                  ("Create your first job", "Read the docs").
 *
 * Visual: centered column, generous vertical padding, max-width on
 * description so wrapping looks intentional on wide screens.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
}

function EmptyState({
  icon,
  title,
  description,
  children,
  className,
  ...props
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        'py-12 px-4 gap-3',
        className,
      )}
      {...props}
    >
      {icon && (
        <div
          className={cn(
            'flex items-center justify-center',
            'h-12 w-12 rounded-full bg-surface-2 text-text-dim',
            '[&_svg]:h-6 [&_svg]:w-6',
          )}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-text">{title}</h3>
      {description && (
        <p className="text-sm text-text-dim max-w-sm">{description}</p>
      )}
      {children && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  )
}
EmptyState.displayName = 'EmptyState'

export { EmptyState }
