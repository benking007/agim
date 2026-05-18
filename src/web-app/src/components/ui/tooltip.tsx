/**
 * Tooltip — Radix Tooltip. Skip on touch devices (no hover); Radix
 * already disables pointer-events tooltips on coarse pointers, so on
 * mobile they only appear via long-press if the page wraps with the
 * `disableHoverableContent` provider option.
 *
 * Use sparingly — important context belongs in visible text, not a
 * hover. We surface tooltips mostly for IconButton affordances
 * (Refresh, Theme cycle, etc.) where the icon alone is ambiguous.
 */

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      'z-50 overflow-hidden rounded-md',
      'bg-text text-bg px-2 py-1 text-xs font-medium shadow-md',
      'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0',
      'data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95',
      className,
    )}
    {...props}
  />
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
