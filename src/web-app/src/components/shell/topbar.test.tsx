/**
 * Topbar — verify:
 *   * Brand link always renders
 *   * Only mounted nav entries appear (no /reminders link until PR-12)
 *   * Active route gets the accent style
 *   * children slot renders between nav and theme controls
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { Topbar } from './topbar'
import '@/i18n'

function renderAt(path: string, children?: React.ReactNode): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<Topbar>{children}</Topbar>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Topbar', () => {
  it('renders brand emoji + app name', () => {
    renderAt('/')
    expect(screen.getByText('🤖')).toBeInTheDocument()
    expect(screen.getByText('Agim')).toBeInTheDocument()
  })

  it('renders only the mounted nav links', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Approvals' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Reminders' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Memos' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Memory' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Observability' })).toBeInTheDocument()
    // /settings is not yet mounted.
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('marks the active route with the accent style', () => {
    renderAt('/tasks')
    const tasks = screen.getByRole('link', { name: 'Tasks' })
    expect(tasks.className).toContain('text-accent')
    const chat = screen.getByRole('link', { name: 'Chat' })
    expect(chat.className).not.toContain('text-accent')
  })

  it('renders the children slot', () => {
    renderAt('/', <div data-testid="page-chrome">page chrome</div>)
    expect(screen.getByTestId('page-chrome')).toBeInTheDocument()
  })
})
