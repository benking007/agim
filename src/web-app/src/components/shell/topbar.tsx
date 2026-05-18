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
  { to: '/reminders',     i18nKey: 'nav.reminders',     mounted: false },
  { to: '/memos',         i18nKey: 'nav.memos',         mounted: false },
  { to: '/memory',        i18nKey: 'nav.memory',        mounted: false },
  { to: '/workspace',     i18nKey: 'nav.workspace',     mounted: false },
  { to: '/observability', i18nKey: 'nav.observability', mounted: false },
  { to: '/settings',      i18nKey: 'nav.settings',      mounted: false },
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
  return (
    <header
      className={cn(
        'sticky top-0 z-20',
        'flex items-center gap-3',
        'border-b border-border bg-surface',
        'px-3 sm:px-4 py-2 pt-safe',
        'shadow-sm',
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

      {children && <div className="flex items-center gap-2">{children}</div>}

      <div className="flex shrink-0 items-center gap-2">
        <ThemeAndLangControls />
      </div>
    </header>
  )
}
