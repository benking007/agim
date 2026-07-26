/**
 * Topbar — shared application chrome. Pinned to the top of every
 * protected route. Holds: brand, primary nav (Chat / Tasks / ...),
 * theme + language controls.
 *
 * Mobile (< sm):
 *   * Brand stays on the left
 *   * Nav collapses into a horizontal scroll strip (no hamburger
 *     yet — the nav is short enough that a horizontal scroller is more
 *     thumb-friendly than a drawer for now)
 *   * Theme+lang stay on the right, condensed
 *
 * The /chat route shipped in M1 with its own bespoke topbar (status
 * pill + agent picker). It'll adopt this shell in a follow-up; the
 * Topbar is forward-compatible (extra topbar slot left of the
 * controls for future page chrome via children).
 */

import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { ThemeAndLangControls } from '@/components/shell/theme-lang-controls'
import { useIsDesktop } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'

interface NavEntry {
  to: string
  i18nKey: string
}

/** Order matches the M1 plan's IA. Each entry is gated on the route
 *  actually existing — we show only the ones plumbed-in so users
 *  don't click a "Reminders" link that 404s mid-M2. As each follow-up
 *  PR lands its route, the `mounted` flag flips. */
const NAV: Array<NavEntry & { mounted: boolean }> = [
  { to: '/dashboard',      i18nKey: 'nav.dashboard',     mounted: true  },
  { to: '/',              i18nKey: 'nav.chat',          mounted: true  },
  { to: '/tasks',         i18nKey: 'nav.tasks',         mounted: true  },
  { to: '/approvals',     i18nKey: 'nav.approvals',     mounted: true  },
  { to: '/reminders',     i18nKey: 'nav.reminders',     mounted: true  },
  { to: '/memos',         i18nKey: 'nav.memos',         mounted: true  },
  { to: '/memory',        i18nKey: 'nav.memory',        mounted: true  },
  // Skills consolidated under Settings → 技能 in 2026-05. Old /skills URLs
  // still resolve via the redirect in router.tsx so bookmarks don't 404.
  { to: '/workspace',     i18nKey: 'nav.workspace',     mounted: true  },
  { to: '/observability', i18nKey: 'nav.observability', mounted: true  },
  { to: '/settings',      i18nKey: 'nav.settings',      mounted: true  },
]

export interface TopbarProps {
  /** Optional content slot rendered between the nav and the
   *  theme/lang controls. Pages use it for page-specific chrome
   *  (the chat route's status pill + agent picker live here once
   *  /chat adopts the shell). */
  children?: React.ReactNode
}

export function Topbar({ children }: TopbarProps): JSX.Element {
  const { t } = useTranslation()
  // R10: render nav exactly once. Pre-R10 we rendered it both in the
  // `hidden sm:flex` desktop slot AND a `sm:hidden` mobile row, relying
  // on CSS to hide one. That left two copies in the accessibility tree
  // (and the test DOM), breaking `getByRole` lookups and announcing
  // every nav item twice to screen readers.
  const isDesktop = useIsDesktop()
  const navLinks = (
    <nav
      className={cn(
        'flex min-w-0 flex-1 items-center gap-1',
        'overflow-x-auto scrollbar-thin',
        '[&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:bg-border',
      )}
      aria-label={t('appName')}
    >
      {NAV.filter((n) => n.mounted).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          className={({ isActive }) =>
            cn(
              'shrink-0 rounded-lg border px-4 py-2 text-sm font-medium no-underline',
              'transition-all tap-target',
              isActive
                ? 'border-brand-100/30 bg-brand-50 text-brand-600 shadow-sm dark:border-accent/20 dark:bg-accent-bg dark:text-accent'
                : 'border-transparent text-text-dim hover:bg-surface-hover hover:text-text',
            )
          }
        >
          {t(n.i18nKey)}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <header
      className={cn(
        'sticky top-0 z-50',
        'flex flex-col border-b border-border bg-surface/95 text-text backdrop-blur-md',
        'pt-safe shadow-sm',
      )}
    >
      {/* Agim 2.0 style top navigation bar. */}
      <div
        className={cn(
          'flex min-w-0 items-center justify-between gap-4',
          'px-3 py-3 sm:px-6',
        )}
      >
        <NavLink
          to="/dashboard"
          className="flex shrink-0 items-center gap-2.5 no-underline"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-tr from-brand-600 to-indigo-400 text-white shadow-sm shadow-brand-500/10">
            <Zap className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="hidden items-center gap-2 sm:flex">
            <span className="text-lg font-bold tracking-normal text-text">{t('appName')}</span>
          </span>
        </NavLink>

        {isDesktop && <div className="flex min-w-0 flex-1">{navLinks}</div>}

        <div className="flex shrink-0 items-center gap-3">
          {children && <div className="flex items-center gap-2">{children}</div>}

          <ThemeAndLangControls />
        </div>
      </div>

      {!isDesktop && (
        <div className="border-t border-border px-3 py-2">{navLinks}</div>
      )}
    </header>
  )
}
