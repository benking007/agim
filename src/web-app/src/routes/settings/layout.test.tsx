import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import SettingsLayout from './layout'
import { useAuth } from '@/stores/auth'
import '@/i18n'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  useAuth.getState().clear()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function asAdmin(): void {
  useAuth.getState().setUser({
    id: 'usr_admin',
    username: 'op',
    displayName: 'op',
    role: 'admin',
  })
}

function asMember(): void {
  useAuth.getState().setUser({
    id: 'usr_mem',
    username: 'member',
    displayName: 'member',
    role: 'user',
  })
}

function renderAt(path: string): ReturnType<typeof render> {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === '/api/config') {
      return jsonResponse({ messengers: [], agents: ['claude-code'], defaultAgent: 'claude-code' })
    }
    if (String(input).startsWith('/api/agents/status')) {
      return jsonResponse({ 'claude-code': true })
    }
    return jsonResponse({})
  })
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="*" element={<div data-testid="settings-child">child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/settings layout', () => {
  it('groups settings entry points by operator intent', async () => {
    asAdmin()
    renderAt('/settings/start')

    expect(screen.getByRole('heading', { name: 'Start' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Core setup' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Operations' })).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /Messengers/i })).toHaveAttribute('href', '/settings/messengers')
    expect(screen.getByRole('link', { name: /Agim Agent/i })).toHaveAttribute('href', '/settings/llm')
    expect(screen.getByRole('link', { name: /MCP Servers/i })).toHaveAttribute('href', '/settings/mcp')
    expect(screen.getByRole('link', { name: 'Advanced' })).toHaveAttribute('href', '/settings/advanced')
    expect(screen.getByRole('link', { name: 'Observability' })).toHaveAttribute('href', '/settings/observability')
    expect(screen.getByRole('link', { name: /Access Rules/i })).toHaveAttribute('href', '/settings/workspaces')
    expect(screen.getByRole('link', { name: /Pricing/i })).toHaveAttribute('href', '/settings/pricing')
    expect(screen.getByRole('link', { name: /Service/i })).toHaveAttribute('href', '/settings/service')
    expect(screen.queryByRole('link', { name: /^Web search$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Speech-to-text$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Email \(SMTP\)$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Viewer & Maps$/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-child')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps nested routes active in the grouped navigation', () => {
    asAdmin()
    renderAt('/settings/agim-skills/injection')

    const skills = screen.getByRole('link', { name: /agim Skills/i })
    expect(skills.className).toContain('text-brand-600')
    expect(screen.getByRole('link', { name: /Messengers/i }).className).not.toContain('text-brand-600')
  })

  it('hides admin tabs for members and keeps Account + Skills', () => {
    asMember()
    renderAt('/settings/account')

    expect(screen.getByRole('link', { name: /Account/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /agim Skills/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Messengers/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Pricing/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Start$/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-child')).toBeInTheDocument()
  })

  it('shows no-permission on an admin settings URL without logging the member out', () => {
    asMember()
    const setHref = vi.fn()
    let href = 'http://localhost:3000/settings/messengers'
    vi.stubGlobal('location', {
      pathname: '/settings/messengers',
      search: '',
      get href() { return href },
      set href(v: string) { href = v; setHref(v) },
    } as unknown as Location)
    localStorage.setItem('agim_token', 'user-qr')
    renderAt('/settings/messengers')

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Back to chat/i })).toHaveAttribute('href', '/')
    expect(setHref).not.toHaveBeenCalled()
    expect(localStorage.getItem('agim_token')).toBe('user-qr')
    expect(screen.queryByTestId('settings-child')).not.toBeInTheDocument()
  })
})
