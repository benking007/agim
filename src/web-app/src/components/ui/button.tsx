/**
 * Button — primary actionable element.
 *
 * Adapted from shadcn/ui (https://ui.shadcn.com) but tuned to agim's
 * native token palette (bg-accent / bg-surface / bg-danger ...) rather
 * than shadcn's bg-primary / bg-card / bg-destructive aliases. Same
 * Radix Slot escape hatch (asChild) for wrapping <Link>s etc.
 *
 * Mobile: every variant ships a min-h-9 (36px) baseline and the `icon`
 * size is intentionally bumped to h-11/w-11 to hit the 44px touch
 * guidance. Pages that need a tighter desktop look can compose
 * `size="sm"` (still 32px tall — never narrower than thumb width).
 */

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2',
    'whitespace-nowrap rounded-md text-sm font-medium',
    'transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    'disabled:pointer-events-none disabled:opacity-55',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'bg-accent text-accent-fg hover:bg-accent-hover',
        secondary:
          'bg-surface-2 text-text hover:bg-surface-hover border border-border',
        outline:
          'bg-surface text-text border border-border hover:bg-surface-hover hover:border-border-strong',
        ghost:
          'bg-transparent text-text-dim hover:bg-surface-hover hover:text-text',
        destructive:
          'bg-surface text-danger border border-danger hover:bg-danger hover:text-white',
        link:
          'bg-transparent text-accent underline-offset-4 hover:underline px-0 h-auto',
      },
      size: {
        // Compact 32px rhythm — matches h-8 Input / Select / Topbar widgets.
        // Trade-off: tighter than the 44×44 mobile touch ideal, but the
        // operator asked for a uniform compact UI across the whole console.
        default: 'h-8 px-3 py-1 text-sm',
        sm:      'h-7 px-2.5 py-1 text-xs',
        lg:      'h-9 px-5',
        icon:    'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size:    'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
