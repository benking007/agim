/**
 * Pagination — controlled page navigator. Drives the URL via the
 * `page` / `perPage` callbacks; the caller decides whether to write
 * useSearchParams (recommended), zustand, or just local state.
 *
 * Why controlled: each M2 page wants the page index in the URL so
 * deep-links work ("here's row 42 — share it"). Forcing the component
 * to manage its own state would either duplicate the search-params
 * read or trap callers into useEffect to sync. Controlled keeps the
 * data flow obvious.
 *
 * Mobile behavior:
 *  - The page-size selector hides below sm (no room; default 20 is
 *    fine on phone).
 *  - The first / last buttons hide below sm (the page label keeps
 *    the user oriented; prev / next is enough).
 *  - All buttons have a 44×44 hit target via the `icon` size.
 *
 * Edge cases:
 *  - page count of 0 / 1 → component still renders so the table
 *    footer doesn't jump on the next page-flip; buttons are disabled.
 *  - page > totalPages → clamp on the caller's side (we display the
 *    label as-is so the caller sees the bug instead of us masking it).
 */

import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface PaginationProps {
  /** 1-based current page. */
  page: number
  /** Total number of pages. Pass `Math.max(1, Math.ceil(total / perPage))`. */
  totalPages: number
  /** Optional row count — when present, renders "1–20 of 150" alongside the page label. */
  totalRows?: number
  /** Optional rows-per-page slot. Pass `[10, 20, 50, 100]` to enable. */
  perPage?: number
  perPageOptions?: number[]
  onPageChange: (page: number) => void
  onPerPageChange?: (perPage: number) => void
  className?: string
}

function Pagination({
  page,
  totalPages,
  totalRows,
  perPage,
  perPageOptions,
  onPageChange,
  onPerPageChange,
  className,
}: PaginationProps): JSX.Element {
  const { t } = useTranslation('common')
  const canPrev = page > 1
  const canNext = page < totalPages
  const showPerPage = perPage !== undefined && perPageOptions && perPageOptions.length > 0 && onPerPageChange

  const rangeFrom = perPage ? (page - 1) * perPage + 1 : null
  const rangeTo = perPage && totalRows !== undefined
    ? Math.min(page * perPage, totalRows)
    : null

  return (
    <nav
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 py-2',
        className,
      )}
      aria-label={t('pagination.label')}
    >
      <div className="flex items-center gap-2 text-sm text-text-dim">
        {showPerPage && (
          <div className="hidden sm:flex items-center gap-2">
            <span>{t('pagination.perPage')}</span>
            <Select
              value={String(perPage)}
              onValueChange={(v) => onPerPageChange?.(Number(v))}
            >
              <SelectTrigger className="h-8 w-[80px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {perPageOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {totalRows !== undefined && rangeFrom !== null && rangeTo !== null && (
          <span aria-live="polite">
            {t('pagination.range', {
              from: totalRows === 0 ? 0 : rangeFrom,
              to: rangeTo,
              total: totalRows,
            })}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('pagination.firstPage')}
          disabled={!canPrev}
          onClick={() => onPageChange(1)}
          className="hidden sm:inline-flex"
        >
          <ChevronFirst />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('actions.previous')}
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
        </Button>

        <span className="px-2 text-sm tabular-nums" aria-live="polite">
          {t('pagination.pageOfTotal', { page, totalPages: Math.max(1, totalPages) })}
        </span>

        <Button
          variant="ghost"
          size="icon"
          aria-label={t('actions.next')}
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('pagination.lastPage')}
          disabled={!canNext}
          onClick={() => onPageChange(totalPages)}
          className="hidden sm:inline-flex"
        >
          <ChevronLast />
        </Button>
      </div>
    </nav>
  )
}
Pagination.displayName = 'Pagination'

export { Pagination }
