import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import SettingsLayout from './layout'
import '@/i18n'

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderAt(path: string): ReturnType<typeof render> {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === '/api/config') {
      return jsonResponse({ messengers: [], agents: ['claude-code'], defaultAgent: 'claude-code' })
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
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps nested routes active in the grouped navigation', () => {
    renderAt('/settings/agim-skills/hot')

    const skills = screen.getByRole('link', { name: /agim Skills/i })
    expect(skills.className).toContain('text-brand-600')
    expect(screen.getByRole('link', { name: /Messengers/i }).className).not.toContain('text-brand-600')
  })

  it('surfaces AUTH_ADMIN_REQUIRED instead of a blank messengers/agents shell', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/config') {
        return new Response(JSON.stringify({ code: 'AUTH_ADMIN_REQUIRED', error: 'admin role required' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      }
      return jsonResponse({})
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/settings/messengers']}>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route path="*" element={<div data-testid="settings-child">child</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/admin permission|管理权限/i)
    expect(screen.getByRole('link', { name: /Sign in as admin|管理员 token 登录/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/login?reason=admin'),
    )
  })
})
