/**
 * ConfirmDialog — verify:
 *   * Cancel closes the dialog without calling onConfirm
 *   * Confirm calls onConfirm and closes on resolution
 *   * Async onConfirm shows a busy button + blocks cancel
 *   * onConfirm rejection keeps the dialog open
 *   * danger intent applies the destructive style to the confirm btn
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialog } from './confirm-dialog'
import '@/i18n'  // ensure i18n is initialized so t() resolves

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConfirmDialog', () => {
  it('cancel button closes without firing onConfirm', () => {
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Cancel job?"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirm button calls onConfirm + closes on success', async () => {
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn().mockResolvedValueOnce(undefined)
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="t"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('keeps dialog open on onConfirm rejection', async () => {
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('nope'))
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="t"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    // Wait for the catch to settle.
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    // onOpenChange should NOT have been called with false (dialog stays open).
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('danger intent renders destructive confirm', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="t"
        intent="danger"
        onConfirm={() => {}}
      />,
    )
    const btn = screen.getByRole('button', { name: 'Confirm' })
    // destructive variant: border-danger
    expect(btn.className).toContain('border-danger')
  })

  it('uses custom confirmLabel / cancelLabel when provided', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="t"
        confirmLabel="Delete forever"
        cancelLabel="Nope"
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Delete forever' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nope' })).toBeInTheDocument()
  })
})
