/**
 * DataTable<T> — generic table for the M2 list pages (jobs /
 * approvals / reminders / memos). Wraps the primitive Table with:
 *
 *  * Type-safe `columns` definition — header label, cell renderer,
 *    optional sortable flag, optional className for both header / cell.
 *  * Loading state — N skeleton rows so layout doesn't jump.
 *  * Empty state — drops in <EmptyState> below the header.
 *  * Row selection (optional) — `selection` + `onSelectionChange`;
 *    caller manages the Set so it can be URL-state or zustand.
 *  * Sort — controlled `sort: { id, dir }` + `onSortChange`. Same
 *    rationale as Pagination: the URL is the source of truth.
 *  * Mobile fallback — below `md` the table swaps to a vertical card
 *    list. Card view uses the same column definitions but stacks
 *    label / value pairs instead of a row.
 *
 * What this deliberately does NOT do:
 *  * No virtualization. Expected row counts at M2 are ≤ 200; if a
 *    page outgrows that, swap the render to react-window from inside
 *    here without changing callers.
 *  * No column resizing / hiding UX. shadcn columns are static.
 *  * No filters. Filters live above the table in a dedicated
 *    FilterBar (next-PR concern).
 *
 * Why hand-rolled instead of @tanstack/table-core:
 *   For the M2 surface area (4 flat-data pages, ≤ 200 rows each),
 *   pulling in a 13 KB head-table dep would add abstraction we don't
 *   use. If virtualisation or column-pinning becomes a need, the
 *   columns prop here maps 1:1 to tanstack's ColumnDef and we can
 *   migrate without changing call sites.
 */

import * as React from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/common/empty-state'
import { cn } from '@/lib/utils'

export type SortDir = 'asc' | 'desc'

export interface SortState {
  id: string
  dir: SortDir
}

export interface DataTableColumn<T> {
  /** Stable id for sort + selection. Usually matches the row key. */
  id: string
  /** Header label. ReactNode so callers can pass <Tooltip> etc. */
  header: React.ReactNode
  /** Cell renderer. Receives the row and its index. */
  cell: (row: T, index: number) => React.ReactNode
  /** When true, the header becomes a sort button. */
  sortable?: boolean
  /** Optional className applied to the <th>. */
  headClassName?: string
  /** Optional className applied to every <td> in this column. */
  cellClassName?: string
  /** Mobile-card variant: when set, this column's value renders
   *  prominently as the card's title row. Only one column should
   *  use this; the rest become label/value pairs. */
  asCardTitle?: boolean
  /** Hide this column on the mobile card view. */
  hideOnMobile?: boolean
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  /** Stable per-row id. Used for selection + React keys. */
  getRowId: (row: T) => string
  loading?: boolean
  /** Number of skeleton rows to show during loading. Default 5. */
  loadingRows?: number
  /** Empty-state slot. When omitted a default EmptyState renders. */
  emptyState?: React.ReactNode
  /** Click handler for the whole row — opens detail drawer, navigates, etc. */
  onRowClick?: (row: T) => void
  /** Controlled selection. When defined, a checkbox column auto-renders. */
  selection?: Set<string>
  onSelectionChange?: (next: Set<string>) => void
  /** Controlled sort. When omitted, sortable headers stay inert. */
  sort?: SortState | null
  onSortChange?: (next: SortState | null) => void
  className?: string
}

function DataTable<T>({
  columns,
  rows,
  getRowId,
  loading = false,
  loadingRows = 5,
  emptyState,
  onRowClick,
  selection,
  onSelectionChange,
  sort,
  onSortChange,
  className,
}: DataTableProps<T>): JSX.Element {
  const { t } = useTranslation('common')
  const selectable = selection !== undefined && onSelectionChange !== undefined
  const desktopSkeletonIds = Array.from(
    { length: loadingRows },
    (_, index) => `desktop-skeleton-${index + 1}`,
  )
  const mobileSkeletonIds = Array.from(
    { length: Math.min(3, loadingRows) },
    (_, index) => `mobile-skeleton-${index + 1}`,
  )

  const allChecked = selectable && rows.length > 0 && rows.every((r) => selection.has(getRowId(r)))
  const someChecked = selectable && rows.some((r) => selection.has(getRowId(r))) && !allChecked

  function toggleAll(): void {
    if (!selectable) return
    const next = new Set(selection)
    if (allChecked) {
      for (const r of rows) next.delete(getRowId(r))
    } else {
      for (const r of rows) next.add(getRowId(r))
    }
    onSelectionChange(next)
  }

  function toggleRow(id: string): void {
    if (!selectable) return
    const next = new Set(selection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }

  function toggleSort(colId: string): void {
    if (!onSortChange) return
    if (!sort || sort.id !== colId) {
      onSortChange({ id: colId, dir: 'asc' })
    } else if (sort.dir === 'asc') {
      onSortChange({ id: colId, dir: 'desc' })
    } else {
      onSortChange(null)
    }
  }

  return (
    <div className={cn('w-full', className)}>
      {/* Desktop / tablet — table view */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label={t('table.selectAll')}
                    aria-checked={someChecked ? 'mixed' : allChecked}
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked
                    }}
                    onChange={toggleAll}
                    disabled={loading || rows.length === 0}
                    className="h-4 w-4 accent-accent cursor-pointer"
                  />
                </TableHead>
              )}
              {columns.map((c) => (
                <TableHead key={c.id} className={c.headClassName}>
                  {c.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.id)}
                      className={cn(
                        'inline-flex items-center gap-1',
                        'uppercase tracking-wide',
                        'hover:text-text transition-colors',
                      )}
                    >
                      {c.header}
                      {sort?.id === c.id ? (
                        sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-50" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? desktopSkeletonIds.map((skeletonId) => (
                  <TableRow key={skeletonId}>
                    {selectable && <TableCell />}
                    {columns.map((c) => (
                      <TableCell key={c.id} className={c.cellClassName}>
                        <div className="h-4 w-3/4 rounded bg-surface-2 animate-pulse" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.length === 0
                ? (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length + (selectable ? 1 : 0)}
                      className="p-0"
                    >
                      {emptyState ?? <EmptyState title={t('states.empty')} />}
                    </TableCell>
                  </TableRow>
                )
                : rows.map((row, i) => {
                    const id = getRowId(row)
                    const isSelected = selectable && selection.has(id)
                    return (
                      <TableRow
                        key={id}
                        data-state={isSelected ? 'selected' : undefined}
                        onClick={onRowClick ? () => onRowClick(row) : undefined}
                        className={onRowClick ? 'cursor-pointer' : undefined}
                      >
                        {selectable && (
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={t('table.selectRow')}
                              checked={isSelected}
                              onChange={() => toggleRow(id)}
                              className="h-4 w-4 accent-accent cursor-pointer"
                            />
                          </TableCell>
                        )}
                        {columns.map((c) => (
                          <TableCell key={c.id} className={c.cellClassName}>
                            {c.cell(row, i)}
                          </TableCell>
                        ))}
                      </TableRow>
                    )
                  })}
          </TableBody>
        </Table>
      </div>

      {/* Mobile — card view */}
      <div className="md:hidden flex flex-col gap-2">
        {loading
          ? mobileSkeletonIds.map((skeletonId) => (
              <div
                key={skeletonId}
                className="rounded-md border border-border bg-surface p-3 space-y-2"
              >
                <div className="h-4 w-1/2 rounded bg-surface-2 animate-pulse" />
                <div className="h-3 w-3/4 rounded bg-surface-2 animate-pulse" />
                <div className="h-3 w-2/3 rounded bg-surface-2 animate-pulse" />
              </div>
            ))
          : rows.length === 0
            ? (emptyState ?? <EmptyState title={t('states.empty')} />)
            : rows.map((row, i) => {
                const id = getRowId(row)
                const isSelected = selectable && selection.has(id)
                const titleCol = columns.find((c) => c.asCardTitle) ?? columns[0]
                const fieldCols = columns.filter((c) => !c.asCardTitle && !c.hideOnMobile && c.id !== titleCol?.id)
                const cardClassName = cn(
                  'rounded-md border bg-surface p-3 text-left',
                  isSelected ? 'border-accent' : 'border-border',
                  onRowClick && 'cursor-pointer active:bg-surface-hover',
                )
                const cardBody = (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      {titleCol && (
                        <div className="font-medium text-text">{titleCol.cell(row, i)}</div>
                      )}
                      {selectable && (
                        <input
                          type="checkbox"
                          aria-label={t('table.selectRow')}
                          checked={!!isSelected}
                          onChange={() => toggleRow(id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 accent-accent cursor-pointer mt-0.5"
                        />
                      )}
                    </div>
                    {fieldCols.length > 0 && (
                      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                        {fieldCols.map((c) => (
                          <React.Fragment key={c.id}>
                            <dt className="text-text-dim">{c.header}</dt>
                            <dd className="text-text">{c.cell(row, i)}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    )}
                  </>
                )

                if (onRowClick) {
                  return (
                    <div
                      key={id}
                      data-state={isSelected ? 'selected' : undefined}
                      role="button"
                      tabIndex={0}
                      onClick={() => onRowClick(row)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onRowClick(row)
                        }
                      }}
                      className={cardClassName}
                    >
                      {cardBody}
                    </div>
                  )
                }

                return (
                  <div
                    key={id}
                    data-state={isSelected ? 'selected' : undefined}
                    className={cardClassName}
                  >
                    {cardBody}
                  </div>
                )
              })}
      </div>
    </div>
  )
}
DataTable.displayName = 'DataTable'

export { DataTable }
