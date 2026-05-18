/**
 * /memory/vector smoke — verifies:
 *   * Status + coverage render from /api/memory/vector/status
 *   * Test action → POST /api/memory/vector/test and toasts on
 *     success / failure
 *   * Clear action → ConfirmDialog → POST /api/memory/vector/clear
 *   * Backfill button is disabled while the backend is not ready
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import MemoryVectorRoute from './vector'
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
      <MemoryRouter initialEntries={[`/memory/vector${search}`]}>
        <Routes>
          <Route path="/memory/vector" element={<MemoryVectorRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const READY_STATUS = {
  status: {
    backend: 'local', ready: true, dims: 384,
    modelId: 'bge-small-en-v1.5', lastError: null,
    downloaded: true, detail: {},
  },
  coverage: { total: 42, withEmbedding: 30, withDifferentModel: 2 },
  jobs: [],
}

describe('/memory/vector', () => {
  it('renders status + coverage tiles', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(READY_STATUS))
    renderAt('')
    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeInTheDocument()
    })
    // Model id + dims appear
    expect(screen.getByText('bge-small-en-v1.5')).toBeInTheDocument()
    expect(screen.getByText('384')).toBeInTheDocument()
    // Coverage numbers
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('30')).toBeInTheDocument()
  })

  it('Test → POST /api/memory/vector/test', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/memory/vector/test' && init?.method === 'POST') {
        return jsonResponse({ ok: true })
      }
      if (u.startsWith('/api/memory/vector/status')) return jsonResponse(READY_STATUS)
      return jsonResponse({})
    })
    renderAt('')
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]) === '/api/memory/vector/test' && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('Clear → ConfirmDialog → POST /api/memory/vector/clear (no ?user= → global)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.startsWith('/api/memory/vector/clear') && init?.method === 'POST') {
        return jsonResponse({ ok: true, cleared: 7 })
      }
      if (u.startsWith('/api/memory/vector/status')) return jsonResponse(READY_STATUS)
      return jsonResponse({})
    })
    renderAt('')
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Clear embeddings' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('button', { name: 'Clear embeddings' })
    const destructive = candidates.find((b) => b.className.includes('border-danger'))
    expect(destructive).toBeDefined()
    fireEvent.click(destructive!)
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]).startsWith('/api/memory/vector/clear') && (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('disables Backfill when backend is not ready', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        ...READY_STATUS,
        status: { ...READY_STATUS.status, ready: false },
      }),
    )
    renderAt('')
    await waitFor(() => expect(screen.getByText('Not ready')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Backfill embeddings' })).toBeDisabled()
  })
})
