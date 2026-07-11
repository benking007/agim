/**
 * /* (NotFoundRoute) — verifies:
 *   * Renders the 404 title + the typed-in path
 *   * Topbar shows so the user keeps app-level nav
 *   * "Back" link points at /
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import NotFoundRoute from './not-found'
import '@/i18n'

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('NotFoundRoute', () => {
  it('renders 404 + the requested path', () => {
    renderAt('/totally-not-a-real-path')
    expect(screen.getByText('404')).toBeInTheDocument()
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
    expect(screen.getByText('/totally-not-a-real-path')).toBeInTheDocument()
  })

  it('renders the Topbar so app-level nav is reachable', () => {
    renderAt('/nope')
    expect(screen.getByRole('link', { name: 'Agim' })).toBeInTheDocument()
    // Chat nav link
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument()
  })

  it('Back button links to /', () => {
    renderAt('/nope')
    const back = screen.getByRole('link', { name: 'Back' })
    expect(back.getAttribute('href')).toBe('/')
  })
})
