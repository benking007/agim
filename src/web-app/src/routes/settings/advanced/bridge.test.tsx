/**
 * /settings/advanced/bridge — the connection settings page renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
      if (url.startsWith('/api/admin/bridge/enabled')) {
        return jsonResponse({ enabled: false })
      }
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
    expect(screen.getByRole('switch', { name: '打开桥接' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('heading', { name: '桥接令牌' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '已连接的调用方' })).toBeInTheDocument()
    expect(screen.getByLabelText('访问基址')).toBeInTheDocument()
  })

  it('edits an existing caller and leaves a blank key unchanged', async () => {
    await i18n.changeLanguage('zh')
    const seen: Array<{ url: string; method: string; body: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      seen.push({ url, method, body })
      if (url.startsWith('/api/admin/bridge/enabled')) return jsonResponse({ enabled: true })
      if (url.startsWith('/api/admin/bridge/tokens')) {
        return jsonResponse({ tokens: [], publicBaseUrl: 'https://calls.example' })
      }
      if (url.startsWith('/api/admin/bridge/peers')) {
        if (method === 'PATCH') return jsonResponse({ ok: true })
        return jsonResponse({
          peers: [{
            peerId: 'caller-1',
            tokenId: 'tok',
            agents: ['agim'],
            callbackMode: 'webhook',
            callbackUrl: 'https://1.1.1.1/hook',
            webhookKeySet: true,
            enabled: true,
            maxConcurrent: 1,
            workspaceId: 'default',
          }],
        })
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
    const user = userEvent.setup()
    expect(await screen.findByRole('cell', { name: 'Webhook' })).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('回调方式', { selector: '#bridge-edit-callback-mode' })).toHaveValue('webhook')
    const url = screen.getByLabelText('Webhook URL', { selector: '#bridge-edit-webhook-url' })
    expect(url).toHaveValue('https://1.1.1.1/hook')
    expect(screen.getByLabelText('Key', { selector: '#bridge-edit-webhook-key' })).toHaveValue('')
    expect(screen.getByText('留空则不修改已有 Key。')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /去掉 Key/ })).toBeInTheDocument()
    await user.clear(url)
    await user.type(url, 'https://8.8.8.8/hook')
    await user.click(screen.getByRole('button', { name: '保存' }))
    const patch = seen.find((row) => row.method === 'PATCH')
    expect(patch?.body.includes('https://8.8.8.8/hook')).toBe(true)
    expect(patch?.body.includes('webhookKey')).toBe(false)

    await user.click(await screen.findByRole('button', { name: '编辑' }))
    const again = screen.getByLabelText('Webhook URL', { selector: '#bridge-edit-webhook-url' })
    await user.clear(again)
    await user.click(screen.getByRole('checkbox', { name: /去掉 Key/ }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    const cleared = seen.filter((row) => row.method === 'PATCH').at(-1)
    const body = cleared ? JSON.parse(cleared.body) as { callbackUrl?: string; webhookKey?: string | null } : {}
    expect(body.callbackUrl).toBe('')
    expect(body.webhookKey).toBeNull()
  })

  it('does not call an empty MCP Events URL poll-only', async () => {
    await i18n.changeLanguage('zh')
    const longUrl = 'https://api2.cursor.sh/automations/webhook/very-long-path-that-should-not-stretch-the-column'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/admin/bridge/enabled')) return jsonResponse({ enabled: true })
      if (url.startsWith('/api/admin/bridge/tokens')) {
        return jsonResponse({ tokens: [], publicBaseUrl: 'https://calls.example' })
      }
      if (url.startsWith('/api/admin/bridge/peers')) {
        return jsonResponse({
          peers: [
            {
              peerId: 'mcp-1',
              tokenId: 'tok-mcp',
              agents: ['agim'],
              callbackMode: 'mcp_events',
              callbackUrl: null,
              webhookKeySet: false,
              enabled: true,
              maxConcurrent: 1,
              workspaceId: 'default',
            },
            {
              peerId: 'hook-1',
              tokenId: 'tok-hook',
              agents: ['agim'],
              callbackMode: 'webhook',
              callbackUrl: longUrl,
              webhookKeySet: true,
              enabled: true,
              maxConcurrent: 1,
              workspaceId: 'default',
            },
          ],
        })
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
    expect(await screen.findByRole('cell', { name: 'MCP Events' })).toBeInTheDocument()
    expect(screen.getByText('空（订阅自带地址）')).toBeInTheDocument()
    expect(screen.queryByText(/只轮询/)).not.toBeInTheDocument()
    const shown = screen.getByTitle(longUrl)
    expect(shown).toHaveClass('truncate')
    expect(shown).toHaveTextContent(longUrl)
  })
})
