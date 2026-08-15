import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import TasksLayout from './layout'
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
          <Route path="/tasks" element={<TasksLayout />}>
            <Route index element={<div data-testid="tasks-child">overview</div>} />
            <Route path="*" element={<div data-testid="tasks-child">child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/tasks layout', () => {
  it('shows task view links without exposing group labels', () => {
    renderAt('/tasks')

    expect(screen.queryByText('Start')).not.toBeInTheDocument()
    expect(screen.queryByText('Work')).not.toBeInTheDocument()
    expect(screen.queryByText('Automation')).not.toBeInTheDocument()
    expect(screen.queryByText('Review')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/tasks')
    expect(screen.getByRole('link', { name: 'Approvals' })).toHaveAttribute('href', '/tasks/approvals')
    expect(screen.getByRole('link', { name: 'Outbox' })).toHaveAttribute('href', '/tasks/outbox')
    expect(screen.getByRole('link', { name: 'Ask User' })).toHaveAttribute('href', '/tasks/asks')
    expect(screen.getByTestId('tasks-child')).toBeInTheDocument()
  })

  it('marks nested routes active in the grouped navigation', () => {
    renderAt('/tasks/a2a')

    const a2a = screen.getByRole('link', { name: 'Agent ↔ Agent' })
    expect(a2a.className).toContain('text-brand-600')
    expect(screen.getByRole('link', { name: 'Overview' }).className).not.toContain('text-brand-600')
  })
})
