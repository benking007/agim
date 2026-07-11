/**
 * ErrorBoundary — verify:
 *   * Catches a synchronous render error and renders the fallback
 *     with the error message visible
 *   * Lets normal children through unmolested
 *
 * `componentDidCatch` logs to console.error by default — silence it
 * for the test so the suite output stays clean.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ErrorBoundary } from './error-boundary'
import '@/i18n'

let consoleSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleSpy.mockRestore()
})

function Bomb({ when }: { when: boolean }): JSX.Element {
  if (when) throw new Error('intentional explosion')
  return <div>peaceful</div>
}

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ErrorBoundary>
          <Bomb when={false} />
        </ErrorBoundary>
      </MemoryRouter>,
    )
    expect(screen.getByText('peaceful')).toBeInTheDocument()
  })

  it('catches a synchronous render error and renders the fallback', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ErrorBoundary>
          <Bomb when={true} />
        </ErrorBoundary>
      </MemoryRouter>,
    )
    // Fallback title + error message
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument()
    expect(screen.getByText(/intentional explosion/)).toBeInTheDocument()
    // Reload + Home action buttons present
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument()
  })
})
