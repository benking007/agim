import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import SettingsAgimSkillsLayout from './layout'
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

describe('/settings/agim-skills layout', () => {
  it('shows skill view links without exposing category labels', () => {
    renderAt('/settings/agim-skills')

    expect(screen.queryByText('Library')).not.toBeInTheDocument()
    expect(screen.queryByText('Discover')).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/settings/agim-skills')
    expect(screen.getByRole('link', { name: 'Installed' })).toHaveAttribute('href', '/settings/agim-skills/installed')
    expect(screen.getByRole('link', { name: 'Prompt Injection' })).toHaveAttribute('href', '/settings/agim-skills/injection')
    expect(screen.getAllByRole('link')).toHaveLength(3)
    expect(screen.getByTestId('skills-child')).toBeInTheDocument()
  })

  it('marks nested skill routes active', () => {
    renderAt('/settings/agim-skills/injection')

    const injection = screen.getByRole('link', { name: 'Prompt Injection' })
    expect(injection.className).toContain('text-accent')
    expect(screen.getByRole('link', { name: 'Overview' }).className).not.toContain('text-accent')
  })
})
