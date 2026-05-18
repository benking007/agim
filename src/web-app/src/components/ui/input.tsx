/**
 * Input — single-line text input with shell-style focus ring.
 * Mobile: 16px font-size on first focus (font-size sm 12px would
 * trigger iOS auto-zoom on focus), but we counteract via max-scale=1
 * in viewport meta; staying on `text-sm` keeps the desktop density.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-border bg-surface',
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
