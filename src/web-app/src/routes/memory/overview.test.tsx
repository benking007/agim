import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import MemoryOverviewRoute from './overview'
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

function renderAt(search = ''): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[`/memory${search}`]}>
        <Routes>
          <Route path="/memory" element={<MemoryOverviewRoute />} />
          <Route path="/" element={<div>Chat route</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function mockFetch(opts: {
  users?: Record<string, unknown>
  consolidate?: Record<string, unknown>
  distill?: Record<string, unknown>
  vector?: Record<string, unknown>
} = {}) {
  const users = opts.users ?? {
    users: [
      {
        user_key: 'wechat:u1',
        fact_count: 8,
        oldest_fact_at: 1700000000000,
        newest_fact_at: 1700000100000,
        has_persona: false,
        persona_updated_at: null,
      },
      {
        user_key: 'feishu:u2',
        fact_count: 3,
        oldest_fact_at: 1700000000000,
        newest_fact_at: 1700000100000,
        has_persona: true,
        persona_updated_at: 1700000100000,
      },
    ],
  }
  const consolidate = opts.consolidate ?? { jobs: [] }
  const distill = opts.distill ?? {
    enabled: true,
    running: false,
    pendingTotal: 3,
    lastRunAt: 1700000100000,
    lastProcessed: 2,
    lastError: null,
  }
  const vector = opts.vector ?? {
    status: {
      backend: 'openai',
      ready: true,
      dims: 1536,
      modelId: 'text-embedding-3-small',
      lastError: null,
      detail: {},
    },
    coverage: { total: 8, withEmbedding: 6, withDifferentModel: 0 },
    jobs: [],
  }

  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const u = String(input)
    if (u === '/api/memory/users') return jsonResponse(users)
    if (u === '/api/memory/consolidate/status') return jsonResponse(consolidate)
    if (u === '/api/memory/distill/status') return jsonResponse(distill)
    if (u.startsWith('/api/memory/vector/status')) return jsonResponse(vector)
    return jsonResponse({})
  })
}

describe('/memory overview', () => {
  it('summarizes the selected user and prioritizes missing persona', async () => {
    mockFetch()
    renderAt('?user=wechat%3Au1')

    expect(screen.getByRole('heading', { name: 'Memory overview' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('11 facts · 1 personas')).toBeInTheDocument())
    expect(screen.getByText('wechat:u1 has facts but no persona yet.')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('6/8 facts embedded.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Generate or edit the persona/i })).toHaveAttribute('href', '/memory/persona?user=wechat%3Au1')
  })

  it('routes empty memory banks to chat as the first action', async () => {
    mockFetch({
      users: { users: [] },
      distill: { enabled: true, running: false, pendingTotal: 0, lastRunAt: null, lastProcessed: 0, lastError: null },
      vector: {
        status: { backend: 'off', ready: false, dims: 0, modelId: '', lastError: null, detail: {} },
        coverage: { total: 0, withEmbedding: 0, withDifferentModel: 0 },
        jobs: [],
      },
    })
    renderAt()

    await waitFor(() => expect(screen.getByText('Create the first memory')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Create the first memory/i })).toHaveAttribute('href', '/?welcome=1')
  })
})
