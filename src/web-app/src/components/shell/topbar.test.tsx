/**
 * Topbar — verify:
 *   * Brand link always renders and goes to /dashboard
 *   * Primary nav is Chat / Tasks / Memory / Workspace / Settings
 *   * Active route gets the brand workbench style
 *   * children slot renders between nav and theme controls
 */

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { Topbar } from './topbar'
import { useAuth } from '@/stores/auth'
import '@/i18n'

function renderAt(path: string, children?: React.ReactNode): ReturnType<typeof render> {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<Topbar>{children}</Topbar>} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  useAuth.getState().clear()
})

describe('Topbar', () => {
  it('renders brand mark + app name', () => {
    renderAt('/')
    expect(screen.getByText('Agim')).toBeInTheDocument()
    expect(screen.queryByText('Workbench')).not.toBeInTheDocument()
    expect(screen.queryByText('Operator')).not.toBeInTheDocument()
    expect(screen.queryByText('System adaptive')).not.toBeInTheDocument()
  })

  it('renders only the mounted nav links', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: 'Agim' })
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Memory' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Agent Files' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    expect(nav.querySelector('a[href="/dashboard"]')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Home' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Approvals' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Reminders' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Memos' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Observability' })).not.toBeInTheDocument()
  })

  it('sends the brand mark to the dashboard', () => {
    renderAt('/')
    const brand = screen.getByRole('link', { name: 'Agim' })
    expect(brand).toHaveAttribute('href', '/dashboard')
    expect(brand).toHaveAttribute('title', 'Home workbench')
  })

  it('marks the active route with the accent style', () => {
    renderAt('/tasks')
    const tasks = screen.getByRole('link', { name: 'Tasks' })
    expect(tasks.className).toContain('text-brand-600')
    const chat = screen.getByRole('link', { name: 'Chat' })
    expect(chat.className).not.toContain('text-brand-600')
  })

  it('renders the children slot', () => {
    renderAt('/', <div data-testid="page-chrome">page chrome</div>)
    expect(screen.getByTestId('page-chrome')).toBeInTheDocument()
  })

  it('shows the signed-in username on the right', () => {
    useAuth.getState().setUser({
      id: 'usr_1',
      username: 'tester',
      displayName: 'tester',
      role: 'admin',
    })
    renderAt('/')
    expect(screen.getByTestId('signed-in-user')).toHaveTextContent('tester')
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument()
  })
})
