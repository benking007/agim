import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import MemoryLayout from './layout'
import '@/i18n'

beforeEach(() => {
  localStorage.setItem('agim_token', 'tok')
})

afterEach(() => {
  localStorage.clear()
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
    const u = String(input)
    if (u === '/api/memory/users') {
      return jsonResponse({
        users: [
          {
            user_key: 'wechat:u1',
            fact_count: 8,
            oldest_fact_at: 1700000000000,
            newest_fact_at: 1700000100000,
            has_persona: true,
            persona_updated_at: 1700000100000,
          },
        ],
      })
    }
    return jsonResponse({})
  })
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/memory" element={<MemoryLayout />}>
            <Route index element={<div data-testid="memory-child">overview</div>} />
            <Route path="*" element={<div data-testid="memory-child">child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/memory layout', () => {
  it('shows memory view links without exposing group labels', () => {
    renderAt('/memory?user=wechat%3Au1')

    expect(screen.queryByText('Start')).not.toBeInTheDocument()
    expect(screen.queryByText('User memory')).not.toBeInTheDocument()
    expect(screen.queryByText('Processing')).not.toBeInTheDocument()
    expect(screen.queryByText('Recall')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/memory?user=wechat%3Au1')
    expect(screen.getByRole('link', { name: 'Facts' })).toHaveAttribute('href', '/memory/facts?user=wechat%3Au1')
    expect(screen.getByRole('link', { name: 'Persona' })).toHaveAttribute('href', '/memory/persona?user=wechat%3Au1')
    expect(screen.getByRole('link', { name: 'Distillation' })).toHaveAttribute('href', '/memory/distill?user=wechat%3Au1')
    expect(screen.getByRole('link', { name: 'Vector' })).toHaveAttribute('href', '/memory/vector?user=wechat%3Au1')
    expect(screen.getByTestId('memory-child')).toBeInTheDocument()
  })

  it('marks nested memory routes active', () => {
    renderAt('/memory/vector?user=wechat%3Au1')

    const vector = screen.getByRole('link', { name: 'Vector' })
    expect(vector.className).toContain('text-accent')
    expect(screen.getByRole('link', { name: 'Overview' }).className).not.toContain('text-accent')
  })
})
