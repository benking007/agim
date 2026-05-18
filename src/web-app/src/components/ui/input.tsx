/**
 * Input — single-line text input with shell-style focus ring.
 *
 * Density: h-8 (32px). The original shadcn default is h-9 (36px),
 * but real-world feedback found 36px rows visually inflated against
 * shadcn-style table cells (h-10 at most). 32px sits closer to
 * Linear / Notion density. iOS auto-zoom is suppressed via
 * `maximum-scale=1` in viewport meta, so text-sm (14px) is safe
 * here without inflating to 16px.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-8 w-full rounded-md border border-border bg-surface',
          'px-3 py-1 text-sm shadow-sm',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          'placeholder:text-text-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
          'disabled:cursor-not-allowed disabled:opacity-55',
          className,
        )}
        ref={ref}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

export { Input }
