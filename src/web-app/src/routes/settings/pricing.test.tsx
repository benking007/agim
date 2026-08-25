import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

import SettingsPricingRoute from './pricing'
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

const sampleRows = [
  {
    key: 'llm:deepseek-v4-flash-vision-exp',
    kind: 'llm' as const,
    id: 'deepseek-v4-flash-vision-exp',
    preset: { costPer1kIn: 0.00022, costPer1kOut: 0.00066 },
    current: { costPer1kIn: 0.00022, costPer1kOut: 0.00066 },
    source: 'preset' as const,
  },
  {
    key: 'agent:cursor',
    kind: 'cli' as const,
    id: 'cursor',
    preset: { costPer1kIn: 0.003, costPer1kOut: 0.015 },
    current: { costPer1kIn: 0.003, costPer1kOut: 0.015 },
    source: 'preset' as const,
  },
]

function renderPage(): ReturnType<typeof render> & { fetchSpy: ReturnType<typeof vi.spyOn> } {
  const rows = sampleRows.map((r) => ({ ...r, current: { ...r.current } }))
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    if (u === '/api/admin/model-prices' && method === 'GET') {
      return jsonResponse({ ok: true, rows })
    }
    if (u === '/api/admin/model-prices' && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as {
        overrides: Record<string, { costPer1kIn: number; costPer1kOut: number } | null>
      }
      for (const [key, price] of Object.entries(body.overrides ?? {})) {
        const idx = rows.findIndex((r) => r.key === key)
        const existing = idx >= 0 ? rows[idx] : undefined
        if (price && existing) {
          rows[idx] = { ...existing, current: price, source: 'override' }
        } else if (price && !existing) {
          const kind = key.startsWith('agent:') ? 'cli' as const : 'llm' as const
          const id = key.slice(key.indexOf(':') + 1)
          rows.push({
            key,
            kind,
            id,
            preset: null,
            current: price,
            source: 'override',
          })
        } else if (!price && existing) {
          const preset = existing.preset ?? existing.current
          rows[idx] = { ...existing, current: preset, source: 'preset' }
        }
      }
      return jsonResponse({ ok: true, rows })
    }
    return jsonResponse({})
  })
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/settings/pricing']}>
        <Routes>
          <Route path="/settings/pricing" element={<SettingsPricingRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
  return Object.assign(view, { fetchSpy })
}

describe('/settings/pricing', () => {
  it('lists Agim models and CLI agents with preset rates', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Model pricing' })).toBeInTheDocument()
    expect(await screen.findByTestId('price-row-llm:deepseek-v4-flash-vision-exp')).toHaveTextContent('deepseek-v4-flash-vision-exp')
    expect(screen.getByTestId('price-row-agent:cursor')).toHaveTextContent('cursor')
    expect(screen.getByRole('textbox', { name: 'deepseek-v4-flash-vision-exp input' })).toHaveValue('0.22')
    expect(screen.getByRole('textbox', { name: 'cursor input' })).toHaveValue('3')
  })

  it('saves an override for the vision model', async () => {
    const user = userEvent.setup()
    const { fetchSpy } = renderPage()
    const row = await screen.findByTestId('price-row-llm:deepseek-v4-flash-vision-exp')
    const inn = screen.getByRole('textbox', { name: 'deepseek-v4-flash-vision-exp input' })
    await user.clear(inn)
    await user.type(inn, '0.5')
    await user.click(within(row).getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const put = fetchSpy.mock.calls.find((c) => String(c[0]) === '/api/admin/model-prices' && String(c[1]?.method || '').toUpperCase() === 'PUT')
      expect(put).toBeTruthy()
    })
    const put = fetchSpy.mock.calls.find((c) => String(c[0]) === '/api/admin/model-prices' && String(c[1]?.method || '').toUpperCase() === 'PUT')
    const body = JSON.parse(String(put?.[1]?.body)) as { overrides: Record<string, { costPer1kIn: number }> }
    expect(body.overrides['llm:deepseek-v4-flash-vision-exp']?.costPer1kIn).toBeCloseTo(0.0005)
    expect(await screen.findByText('Override')).toBeInTheDocument()
  })

  it('adds a custom model id as an override', async () => {
    const user = userEvent.setup()
    const { fetchSpy } = renderPage()
    await screen.findByRole('heading', { name: 'Add a custom model id' })
    await user.type(screen.getByRole('textbox', { name: 'Id' }), 'my-private-sku')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => {
      expect(screen.getByTestId('price-row-llm:my-private-sku')).toBeInTheDocument()
    })
    const put = fetchSpy.mock.calls.find((c) => String(c[0]) === '/api/admin/model-prices' && String(c[1]?.method || '').toUpperCase() === 'PUT')
    const body = JSON.parse(String(put?.[1]?.body)) as { overrides: Record<string, { costPer1kIn: number; costPer1kOut: number }> }
    expect(body.overrides['llm:my-private-sku']?.costPer1kIn).toBeCloseTo(0.00022)
    expect(body.overrides['llm:my-private-sku']?.costPer1kOut).toBeCloseTo(0.00066)
  })
})
