/**
 * EmptyState — render contract:
 *   * title always renders (required)
 *   * description renders only when provided
 *   * icon slot renders only when provided
 *   * action slot (children) renders only when provided
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState } from './empty-state'

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState title="No jobs yet" />)
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('No jobs yet')
  })

  it('renders the description when provided', () => {
    render(<EmptyState title="t" description="some helper text" />)
    expect(screen.getByText('some helper text')).toBeInTheDocument()
  })

  it('omits the description when not provided', () => {
    render(<EmptyState title="t" />)
    expect(screen.queryByText(/some helper/i)).not.toBeInTheDocument()
  })

  it('renders icon and action slots when provided', () => {
    render(
      <EmptyState
        title="t"
        icon={<svg data-testid="iconnode" />}
      >
        <button type="button">Create</button>
      </EmptyState>,
    )
    expect(screen.getByTestId('iconnode')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })
})
