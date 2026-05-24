/**
 * Topbar — shared application chrome. Pinned to the top of every
 * protected route. Holds: brand, primary nav (Chat / Tasks / ...),
 * theme + language controls.
 *
 * Mobile (< sm):
 *   * Brand stays on the left
 *   * Nav collapses into a horizontal scroll strip (no hamburger
 *     yet — we have ≤ 9 nav items so a horizontal scroller is more
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
  { to: '/',              i18nKey: 'nav.chat',          mounted: true  },
  { to: '/tasks',         i18nKey: 'nav.tasks',         mounted: true  },
  { to: '/approvals',     i18nKey: 'nav.approvals',     mounted: true  },
  { to: '/reminders',     i18nKey: 'nav.reminders',     mounted: true  },
  { to: '/memos',         i18nKey: 'nav.memos',         mounted: true  },
  { to: '/memory',        i18nKey: 'nav.memory',        mounted: true  },
  // Skills consolidated under Settings → 技能 in 2026-05 (installed CRUD +
  // skillhub 热门 in one place). Old /skills URLs still resolve via the
  // redirect in router.tsx so bookmarks don't 404.
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
        'flex flex-1 min-w-0 items-center gap-1',
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
              'shrink-0 rounded-md px-2.5 py-1.5 text-sm no-underline',
              'transition-colors tap-target',
              isActive
                ? 'bg-accent-bg text-accent font-medium'
                : 'text-text-dim hover:bg-surface-hover hover:text-text',
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
        'sticky top-0 z-20',
        // Mobile (<sm): two-row layout — brand + widgets on row 1, nav
        // links on row 2 (horizontally scrollable). Desktop (≥sm): single
        // row, nav inline. Avoids the "brand + 4 widgets squeeze nav off-
        // screen" issue on /chat where children = AgentPicker pushes the
        // nav width below the threshold to even show the active item.
        'flex flex-col sm:flex-row sm:items-center sm:gap-3',
        'border-b border-border bg-surface',
        'pt-safe',
        'shadow-sm',
      )}
    >
      {/* Row 1 (mobile) / left half (desktop) — brand + widgets */}
      <div
        className={cn(
          'flex items-center gap-2 sm:gap-3',
          'overflow-x-hidden',
          'px-3 sm:px-4 py-2 sm:py-2',
          'sm:flex-1 sm:min-w-0',
        )}
      >
        <NavLink
          to="/"
          className="flex shrink-0 items-center gap-1 text-md font-semibold no-underline"
          end
        >
          <span aria-hidden="true">🤖</span>
          <span className="hidden sm:inline">{t('appName')}</span>
        </NavLink>

        {/* Desktop nav lives inline on row 1; the mobile copy is on
            row 2 below. Render only one based on the viewport. */}
        {isDesktop && <div className="flex flex-1 min-w-0">{navLinks}</div>}

        {children && <div className="flex items-center gap-2">{children}</div>}

        <div className="flex shrink-0 items-center gap-2">
          <ThemeAndLangControls />
        </div>
      </div>

      {/* Row 2 (mobile only) — scrollable nav strip */}
      {!isDesktop && (
        <div className="border-t border-border px-3 py-1">{navLinks}</div>
      )}
    </header>
  )
}
