import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import SettingsLayout from './layout'
import '@/i18n'

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route path="*" element={<div data-testid="settings-child">child</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('/settings layout', () => {
  it('groups settings entry points by operator intent', () => {
    renderAt('/settings/start')

    expect(screen.getByRole('heading', { name: 'Start' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Core setup' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Operations' })).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /Messengers/i })).toHaveAttribute('href', '/settings/messengers')
    expect(screen.getByRole('link', { name: /Agim Agent/i })).toHaveAttribute('href', '/settings/llm')
    expect(screen.getByRole('link', { name: /MCP Servers/i })).toHaveAttribute('href', '/settings/mcp')
    expect(screen.getByRole('link', { name: /Access Rules/i })).toHaveAttribute('href', '/settings/workspaces')
    expect(screen.getByRole('link', { name: /Service/i })).toHaveAttribute('href', '/settings/service')
    expect(screen.getByTestId('settings-child')).toBeInTheDocument()
  })

  it('keeps nested routes active in the grouped navigation', () => {
    renderAt('/settings/agim-skills/hot')

    const skills = screen.getByRole('link', { name: /agim Skills/i })
    expect(skills.className).toContain('text-accent')
    expect(screen.getByRole('link', { name: /Messengers/i }).className).not.toContain('text-accent')
  })
})
