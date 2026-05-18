/**
 * DataTable — covers the key contracts the 4 M2 pages depend on:
 *   * Renders rows + cells via the columns config
 *   * Loading shows N skeleton rows
 *   * Empty rows + not loading → renders the empty-state slot
 *   * onRowClick fires when row clicked, not when checkbox clicked
 *   * Selection: select-all toggles, individual checkbox toggles,
 *     indeterminate when partial
 *   * Sort: click sortable header → asc → desc → cleared
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { DataTable, type DataTableColumn } from './data-table'
import '@/i18n'

interface Row { id: string; name: string; n: number }

const rows: Row[] = [
  { id: 'a', name: 'Alpha', n: 1 },
  { id: 'b', name: 'Bravo', n: 2 },
  { id: 'c', name: 'Charlie', n: 3 },
]

const columns: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortable: true },
  { id: 'n',    header: 'N',    cell: (r) => String(r.n) },
]

function getDesktopTable(): HTMLElement {
  // Both desktop + mobile views render simultaneously (CSS toggles
  // them); the desktop table is the only `<table>` element.
  return screen.getByRole('table')
}

describe('DataTable', () => {
  it('renders rows via columns config (desktop)', () => {
    render(<DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />)
    const table = getDesktopTable()
    expect(within(table).getByText('Alpha')).toBeInTheDocument()
    expect(within(table).getByText('Bravo')).toBeInTheDocument()
    expect(within(table).getByText('Charlie')).toBeInTheDocument()
  })

  it('loading shows skeleton rows (no data rows)', () => {
    render(<DataTable columns={columns} rows={[]} getRowId={(r) => r.id} loading loadingRows={4} />)
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    // Each skeleton row contains a div.animate-pulse — count them.
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(4)
  })

  it('empty + not loading → default empty state visible', () => {
    render(<DataTable columns={columns} rows={[]} getRowId={(r) => r.id} />)
    // Two empty messages render (desktop + mobile views both visible to jsdom).
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0)
  })

  it('custom emptyState slot replaces the default', () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        getRowId={(r) => r.id}
        emptyState={<div data-testid="custom-empty">nothing here</div>}
      />,
    )
    expect(screen.getAllByTestId('custom-empty').length).toBeGreaterThan(0)
  })

  it('onRowClick fires on row click', () => {
    const onRowClick = vi.fn()
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        onRowClick={onRowClick}
      />,
    )
    const row = within(getDesktopTable()).getByText('Alpha').closest('tr')!
    fireEvent.click(row)
    expect(onRowClick).toHaveBeenCalledWith(rows[0]!)
  })

  it('select-all checkbox toggles all rows in the page', () => {
    const onSelectionChange = vi.fn()
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        selection={new Set()}
        onSelectionChange={onSelectionChange}
      />,
    )
    const allCb = within(getDesktopTable()).getByRole('checkbox', { name: 'Select all rows' })
    fireEvent.click(allCb)
    const next: Set<string> = onSelectionChange.mock.calls[0]![0]
    expect(Array.from(next).sort()).toEqual(['a', 'b', 'c'])
  })

  it('individual checkbox toggles one row', () => {
    const onSelectionChange = vi.fn()
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        selection={new Set()}
        onSelectionChange={onSelectionChange}
      />,
    )
    const rowCbs = within(getDesktopTable()).getAllByRole('checkbox', { name: 'Select row' })
    fireEvent.click(rowCbs[0]!)
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['a']))
  })

  it('click on selection checkbox does NOT trigger onRowClick', () => {
    const onRowClick = vi.fn()
    const onSelectionChange = vi.fn()
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        selection={new Set()}
        onSelectionChange={onSelectionChange}
        onRowClick={onRowClick}
      />,
    )
    const rowCbs = within(getDesktopTable()).getAllByRole('checkbox', { name: 'Select row' })
    fireEvent.click(rowCbs[0]!)
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('select-all is indeterminate when only some rows are selected', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        selection={new Set(['b'])}
        onSelectionChange={() => {}}
      />,
    )
    const allCb = within(getDesktopTable()).getByRole('checkbox', { name: 'Select all rows' }) as HTMLInputElement
    expect(allCb.indeterminate).toBe(true)
  })

  it('sort cycles asc → desc → null', () => {
    const onSortChange = vi.fn()
    const { rerender } = render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        sort={null}
        onSortChange={onSortChange}
      />,
    )
    const nameHeader = within(getDesktopTable()).getByRole('button', { name: /Name/ })

    // first click: null → asc
    fireEvent.click(nameHeader)
    expect(onSortChange).toHaveBeenLastCalledWith({ id: 'name', dir: 'asc' })

    // simulate parent applying state, click again: asc → desc
    rerender(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        sort={{ id: 'name', dir: 'asc' }}
        onSortChange={onSortChange}
      />,
    )
    fireEvent.click(within(getDesktopTable()).getByRole('button', { name: /Name/ }))
    expect(onSortChange).toHaveBeenLastCalledWith({ id: 'name', dir: 'desc' })

    // desc → null
    rerender(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        sort={{ id: 'name', dir: 'desc' }}
        onSortChange={onSortChange}
      />,
    )
    fireEvent.click(within(getDesktopTable()).getByRole('button', { name: /Name/ }))
    expect(onSortChange).toHaveBeenLastCalledWith(null)
  })

  it('non-sortable header is a plain th, not a button', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        sort={null}
        onSortChange={() => {}}
      />,
    )
    // The 'N' column is not sortable.
    expect(within(getDesktopTable()).queryByRole('button', { name: /^N$/ })).not.toBeInTheDocument()
  })
})
