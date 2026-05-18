/**
 * StatusBadge — verify the variant mapping is a stable contract.
 * The 4 M2 pages all rely on this exact mapping; future devs adding
 * a new variant elsewhere must come back here to register it.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { STATUS_VARIANT, StatusBadge } from './status-badge'

describe('StatusBadge', () => {
  it('falls back to status text when no child given', () => {
    render(<StatusBadge status="running" />)
    expect(screen.getByText('running')).toBeInTheDocument()
  })

  it('renders the i18n child when provided', () => {
    render(<StatusBadge status="running">运行中</StatusBadge>)
    expect(screen.getByText('运行中')).toBeInTheDocument()
  })

  it('case-insensitive lookup', () => {
    render(<StatusBadge status="RUNNING" data-testid="b" />)
    // 'running' → info → bg-info-bg class
    const el = screen.getByTestId('b')
    expect(el.className).toContain('bg-info-bg')
  })

  it('unknown status → default variant', () => {
    render(<StatusBadge status="never-heard-of-it" data-testid="b" />)
    const el = screen.getByTestId('b')
    expect(el.className).toContain('bg-surface-2')
  })

  it('caller-supplied variant overrides auto-mapping', () => {
    render(<StatusBadge status="running" variant="danger" data-testid="b" />)
    const el = screen.getByTestId('b')
    expect(el.className).toContain('bg-danger-bg')
    expect(el.className).not.toContain('bg-info-bg')
  })

  it('STATUS_VARIANT covers the M2 status vocabulary', () => {
    // Smoke test — if any of these aren't covered we want a test to
    // shout, not a silent gray-pill regression.
    const expected = [
      'succeeded', 'completed', 'done', 'approved', 'allowed', 'delivered', 'active',
      'running', 'in_progress', 'pending', 'queued', 'scheduled', 'open',
      'paused', 'awaiting', 'timeout', 'expired',
      'failed', 'error', 'denied', 'rejected', 'cancelled', 'canceled',
      'finished', 'closed', 'archived',
    ]
    for (const status of expected) {
      expect(STATUS_VARIANT[status], `missing variant for: ${status}`).toBeDefined()
    }
  })
})
