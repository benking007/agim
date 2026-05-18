/**
 * Pagination — verify:
 *   * Prev / Next emit onPageChange(prev) / onPageChange(next)
 *   * First / Last emit onPageChange(1) / onPageChange(totalPages)
 *   * Disabled state at boundaries
 *   * Range label rendering when totalRows is passed
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Pagination } from './pagination'
import '@/i18n'

describe('Pagination', () => {
  it('clicking Next calls onPageChange(page + 1)', () => {
    const onPageChange = vi.fn()
    render(
      <Pagination
        page={3}
        totalPages={10}
        onPageChange={onPageChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onPageChange).toHaveBeenCalledWith(4)
  })

  it('clicking Previous calls onPageChange(page - 1)', () => {
    const onPageChange = vi.fn()
    render(
      <Pagination
        page={3}
        totalPages={10}
        onPageChange={onPageChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('clicking First / Last jump to extremes', () => {
    const onPageChange = vi.fn()
    render(
      <Pagination
        page={5}
        totalPages={10}
        onPageChange={onPageChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'First page' }))
    expect(onPageChange).toHaveBeenLastCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }))
    expect(onPageChange).toHaveBeenLastCalledWith(10)
  })

  it('disables Prev/First on page 1', () => {
    render(
      <Pagination
        page={1}
        totalPages={10}
        onPageChange={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled()
  })

  it('disables Next/Last on page = totalPages', () => {
    render(
      <Pagination
        page={10}
        totalPages={10}
        onPageChange={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Last page' })).toBeDisabled()
  })

  it('renders the page label', () => {
    render(
      <Pagination
        page={3}
        totalPages={10}
        onPageChange={() => {}}
      />,
    )
    expect(screen.getByText(/Page 3 of 10/)).toBeInTheDocument()
  })

  it('renders the range label when totalRows + perPage given', () => {
    render(
      <Pagination
        page={2}
        totalPages={5}
        totalRows={95}
        perPage={20}
        onPageChange={() => {}}
      />,
    )
    // page 2 with perPage 20 → rows 21–40 of 95
    expect(screen.getByText(/21–40 of 95/)).toBeInTheDocument()
  })

  it('clamps range "to" against totalRows', () => {
    render(
      <Pagination
        page={5}
        totalPages={5}
        totalRows={95}
        perPage={20}
        onPageChange={() => {}}
      />,
    )
    // last page: rows 81–95 of 95 (not 81–100)
    expect(screen.getByText(/81–95 of 95/)).toBeInTheDocument()
  })
})
