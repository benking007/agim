/**
 * /memory/persona smoke — verifies:
 *   * Without ?user → friendly empty-state
 *   * With ?user, 404 from /api/memory/persona → "no persona yet"
 *     state (the 404 is mapped to data:null by the hook)
 *   * Existing persona renders into the editor + dirty state
 *     flips border on edit; Save fires PUT /api/memory/persona
 *     { summary }
 *   * Trigger button fires POST /api/memory/consolidate
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import MemoryPersonaRoute from './persona'
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

function renderAt(search: string): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[`/memory/persona${search}`]}>
        <Routes>
          <Route path="/memory/persona" element={<MemoryPersonaRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

describe('/memory/persona', () => {
  it('without ?user → friendly empty-state', () => {
    renderAt('')
    expect(screen.getByText('Pick a user to view their memory')).toBeInTheDocument()
  })

  it('with ?user but no persona (404) → "No persona yet" state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.startsWith('/api/memory/persona')) {
        return jsonResponse({ error: 'no persona' }, 404)
      }
      if (u.startsWith('/api/memory/consolidate/status')) {
        return jsonResponse({ jobs: [] })
      }
      return jsonResponse({})
    })
    renderAt('?user=wechat%3Au1')
    await waitFor(() => {
      expect(screen.getByText('No persona yet')).toBeInTheDocument()
    })
  })

  it('with existing persona → editor pre-fills; dirty save → PUT { summary }', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.match(/^\/api\/memory\/persona\?/) && (init?.method === undefined || init?.method === 'GET')) {
        return jsonResponse({
          user_key: 'wechat:u1', summary: 'curious; prefers concise replies.',
          updated_at: 1700000000000,
        })
      }
      if (u.match(/^\/api\/memory\/persona\?/) && init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ summary: 'curious; prefers concise replies. UPDATED' })
        return jsonResponse({ ok: true })
      }
      if (u.startsWith('/api/memory/consolidate/status')) return jsonResponse({ jobs: [] })
      return jsonResponse({})
    })
    renderAt('?user=wechat%3Au1')
    const textarea = await waitFor(() => {
      const ta = screen.getByLabelText('Persona summary') as HTMLTextAreaElement
      expect(ta.value).toContain('curious; prefers concise replies.')
      return ta
    })
    // Save is disabled when clean.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(textarea, { target: { value: 'curious; prefers concise replies. UPDATED' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => /^\/api\/memory\/persona\?/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toBe(true)
    })
  })

  it('Run consolidation → POST /api/memory/consolidate', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/memory/consolidate' && init?.method === 'POST') {
        return jsonResponse({ ok: true, jobId: 'job-x' }, 202)
      }
      if (u.startsWith('/api/memory/persona')) return jsonResponse({ error: 'no persona' }, 404)
      if (u.startsWith('/api/memory/consolidate/status')) return jsonResponse({ jobs: [] })
      return jsonResponse({})
    })
    renderAt('?user=wechat%3Au1')
    // Both the strip header AND the action button read "Run
    // consolidation"; we click the one inside <button>.
    const btn = await waitFor(() => screen.getByRole('button', { name: 'Run consolidation' }))
    fireEvent.click(btn)
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/memory/consolidate' && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })
})
