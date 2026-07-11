/**
 * /tasks/subtasks smoke — verifies the subtasks list renders rows
 * from /api/subtasks and the agent-filter input writes ?agent=.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import SubtasksRoute from './subtasks'
import '@/i18n'

class StubES {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 2
  readyState = StubES.CONNECTING
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = StubES as unknown as typeof EventSource
  localStorage.setItem('agim_token', 'tok')
})

afterEach(() => {
  delete (globalThis as { EventSource?: unknown }).EventSource
  localStorage.clear()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function renderPage(initialPath = '/tasks/subtasks'): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[initialPath]}>
        <Routes>
          <Route path="/tasks/subtasks" element={<SubtasksRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

describe('/tasks/subtasks', () => {
  it('renders subtasks from the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        subtasks: [
          {
            id: 1, agent: 'codex', prompt: 'fix the bug', status: 'completed',
            createdAt: '2026-05-18T08:00:00Z',
            platform: 'wechat', channelId: 'c', threadId: 't',
            parentAgent: 'claude', parentSessionId: 'abcd1234ef',
          },
        ],
      }),
    )
    renderPage()
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
      const table = screen.getByRole('table')
      expect(within(table).getByText('fix the bug')).toBeInTheDocument()
    })
    expect(within(screen.getByRole('table')).getByText('codex')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText('claude')).toBeInTheDocument()
  })

  it('shows the empty state when API returns no subtasks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ subtasks: [] }))
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('No subtasks yet').length).toBeGreaterThan(0)
    })
  })

  it('agent filter writes ?agent= to URL and re-fetches', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValue(jsonResponse({ subtasks: [] }))
    renderPage()
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const input = screen.getByPlaceholderText('Any agent')
    fireEvent.change(input, { target: { value: 'claude' } })
    await waitFor(() => {
      const last = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]?.[0] as string
      expect(last).toContain('agent=claude')
    })
  })
})
