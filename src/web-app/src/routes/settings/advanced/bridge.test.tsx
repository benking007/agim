/**
 * /settings/advanced/bridge — the connection settings page renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/i18n'
import SettingsBridgeRoute from './bridge'

afterEach(() => {
  vi.restoreAllMocks()
  void i18n.changeLanguage('en')
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('/settings/advanced/bridge', () => {
  it('renders 连接设置', async () => {
    await i18n.changeLanguage('zh')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/admin/bridge/tokens')) {
        return jsonResponse({ tokens: [], publicBaseUrl: null })
      }
      if (url.startsWith('/api/admin/bridge/peers')) {
        return jsonResponse({ peers: [] })
      }
      return jsonResponse({})
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SettingsBridgeRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('heading', { name: '连接设置' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '桥接令牌' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '已连接的调用方' })).toBeInTheDocument()
    expect(screen.getByLabelText('访问基址')).toBeInTheDocument()
  })
})
