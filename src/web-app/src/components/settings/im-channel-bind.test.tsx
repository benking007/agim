import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ImChannelBindCard } from './im-channel-bind'
import '@/i18n'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  localStorage.setItem('agim_token', 'tok')
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('ImChannelBindCard', () => {
  it('claims an IM identity for the signed-in user and shows rebound copy', async () => {
    const posts: unknown[] = []
    let bindings: Array<{ platform: string; imUserId: string; userId: string; createdAt: number }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = String(input)
      const method = init?.method ?? 'GET'
      if (u === '/api/me/im-bindings' && method === 'GET') {
        return jsonResponse({ bindings })
      }
      if (u === '/api/me/im-bindings' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { platform: string; imUserId: string }
        posts.push(body)
        bindings = [{
          platform: body.platform,
          imUserId: body.imUserId,
          userId: 'usr_me',
          createdAt: Date.now(),
        }]
        return jsonResponse({
          ok: true,
          replacedUserId: 'usr_old',
          binding: bindings[0],
        })
      }
      return jsonResponse({})
    })

    render(<ImChannelBindCard />)
    await waitFor(() => expect(screen.getByPlaceholderText('12345')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('12345'), { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('button', { name: /绑定到当前账号|bind to this account/i }))

    await waitFor(() => expect(posts).toEqual([{ platform: 'telegram', imUserId: '12345' }]))
    await waitFor(() => expect(screen.getByText('telegram:12345')).toBeInTheDocument())
  })
})
