/**
 * DirtySaveBar — R11 abstraction. Replaces 4 hand-rolled "unsaved
 * changes" rows across /settings/{agents,viewer,service} (plus
 * vector-backend-form, which kept a custom shape). These tests lock
 * the contract:
 *   * Renders nothing when dirty=false (no fragment, so it's safe
 *     inline)
 *   * Renders Discard + Save when dirty
 *   * saveDisabled gates Save but leaves Discard live (so you can
 *     bail out of an invalid form)
 *   * Spinner replaces the Save icon while saving
 *   * Custom labels override the defaults
 *   * hintNode replaces the default Badge (used by service.tsx for
 *     the "restart required" variant)
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@/i18n'
import { DirtySaveBar } from './dirty-save-bar'

describe('DirtySaveBar', () => {
  it('renders nothing when not dirty', () => {
    const { container } = render(
      <DirtySaveBar dirty={false} saving={false} onSave={vi.fn()} onDiscard={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders Discard + Save when dirty', () => {
    render(
      <DirtySaveBar dirty saving={false} onSave={vi.fn()} onDiscard={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument()
  })

  it('Save fires onSave', () => {
    const onSave = vi.fn()
    render(<DirtySaveBar dirty saving={false} onSave={onSave} onDiscard={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('Discard fires onDiscard', () => {
    const onDiscard = vi.fn()
    render(<DirtySaveBar dirty saving={false} onSave={vi.fn()} onDiscard={onDiscard} />)
    fireEvent.click(screen.getByRole('button', { name: /discard/i }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('saving disables both buttons + shows the Saving label', () => {
    render(<DirtySaveBar dirty saving onSave={vi.fn()} onDiscard={vi.fn()} />)
    // Default English saving label
    const saveBtn = screen.getByRole('button', { name: /saving/i })
    expect(saveBtn).toBeDisabled()
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled()
  })

  it('saveDisabled gates Save but leaves Discard live', () => {
    render(
      <DirtySaveBar
        dirty saving={false}
        saveDisabled
        onSave={vi.fn()} onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /discard/i })).not.toBeDisabled()
  })

  it('custom labels override defaults', () => {
    render(
      <DirtySaveBar
        dirty saving={false}
        onSave={vi.fn()} onDiscard={vi.fn()}
        saveLabel="保存"
        discardLabel="放弃改动"
      />,
    )
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '放弃改动' })).toBeInTheDocument()
  })

  it('hintNode replaces the default Badge slot', () => {
    render(
      <DirtySaveBar
        dirty saving={false}
        onSave={vi.fn()} onDiscard={vi.fn()}
        hintNode={<span data-testid="custom-hint">restart needed</span>}
      />,
    )
    expect(screen.getByTestId('custom-hint')).toBeInTheDocument()
    // The default i18n badge text shouldn't be present.
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument()
  })
})
