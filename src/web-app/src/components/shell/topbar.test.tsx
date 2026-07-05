/**
 * Topbar — verify:
 *   * Brand link always renders
 *   * Only mounted nav entries appear (no /reminders link until PR-12)
 *   * Active route gets the brand workbench style
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
  it('renders brand mark + app name', () => {
    renderAt('/')
    expect(screen.getByText('Agim')).toBeInTheDocument()
    expect(screen.queryByText('Workbench')).not.toBeInTheDocument()
    expect(screen.queryByText('Operator')).not.toBeInTheDocument()
    expect(screen.queryByText('System adaptive')).not.toBeInTheDocument()
  })

  it('renders only the mounted nav links', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Approvals' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Reminders' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Memos' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Memory' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Observability' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
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
})
