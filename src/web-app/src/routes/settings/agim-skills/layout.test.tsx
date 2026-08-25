import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import SettingsAgimSkillsLayout from './layout'
import { useAuth } from '@/stores/auth'
import '@/i18n'

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
      <Routes>
        <Route path="/settings/agim-skills" element={<SettingsAgimSkillsLayout />}>
          <Route index element={<div data-testid="skills-child">overview</div>} />
          <Route path="*" element={<div data-testid="skills-child">child</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  useAuth.getState().clear()
})

describe('/settings/agim-skills layout', () => {
  it('hides injection for members', () => {
    useAuth.getState().setUser({
      id: 'usr_m', username: 'member', displayName: 'member', role: 'user',
    })
    renderAt('/settings/agim-skills')

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/settings/agim-skills')
    expect(screen.getByRole('link', { name: 'Installed' })).toHaveAttribute('href', '/settings/agim-skills/installed')
    expect(screen.queryByRole('link', { name: 'Prompt Injection' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByTestId('skills-child')).toBeInTheDocument()
  })

  it('shows injection for admins', () => {
    useAuth.getState().setUser({
      id: 'usr_a', username: 'op', displayName: 'op', role: 'admin',
    })
    renderAt('/settings/agim-skills')

    expect(screen.queryByText('Library')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Prompt Injection' })).toHaveAttribute('href', '/settings/agim-skills/injection')
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })

  it('marks nested skill routes active for admins', () => {
    useAuth.getState().setUser({
      id: 'usr_a', username: 'op', displayName: 'op', role: 'admin',
    })
    renderAt('/settings/agim-skills/injection')

    const injection = screen.getByRole('link', { name: 'Prompt Injection' })
    expect(injection.className).toContain('text-accent')
    expect(screen.getByRole('link', { name: 'Overview' }).className).not.toContain('text-accent')
  })
})
