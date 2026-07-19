/**
 * Toaster — thin wrapper around the `sonner` package, which is what
 * shadcn/ui uses as its default toast since 2024. Renders nothing
 * until something calls `toast.success(...)`, `toast.error(...)`, etc.
 *
 * Usage:
 *   import { Toaster } from '@/components/ui/sonner'
 *   import { toast } from 'sonner'
 *   <App>… <Toaster /></App>
 *   toast.error('Network unreachable')
 *
 * Theme: we don't pass a fixed theme; sonner reads `prefers-color-
 * scheme` itself, and we additionally override its CSS variables in
 * @layer base so they pick up our HSL tokens.
 *
 * Mobile: position defaults to `top-center` so the toast is reachable
 * even when the soft keyboard is up.
 *
 * Font: sonner's stylesheet hardcodes `ui-sans-serif, -apple-system…`
 * without Agim CJK / PingFang. On some iOS WKWebView locales that
 * stack paints Han as [?]; force `font-sans` (Agim CJK-first).
 */

import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster(props: ToasterProps): JSX.Element {
  return (
    <Sonner
      position="top-center"
      richColors
      closeButton
      className="font-sans"
      toastOptions={{
        classNames: {
          toast:
            'border border-border bg-surface text-text shadow-md font-sans',
          title: 'font-medium font-sans',
          description: 'text-text-dim text-sm font-sans',
          actionButton:
            'bg-accent text-accent-fg rounded-md',
          cancelButton:
            'bg-surface-2 text-text rounded-md',
          error: 'bg-danger-bg text-danger border-danger',
          success: 'bg-success-bg text-success border-success',
          warning: 'bg-warning-bg text-warning border-warning',
          info: 'bg-info-bg text-info border-info',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
