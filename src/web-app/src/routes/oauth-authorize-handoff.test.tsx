/**
 * Login used to client-navigate to /bridge/oauth/authorize, and the SPA
 * catch-all rendered 什么也没找到. That path must reload the server page.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reloadServerPage = vi.hoisted(() => vi.fn())

vi.mock('@/lib/full-navigation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/full-navigation')>('@/lib/full-navigation')
  return { ...actual, reloadServerPage }
})

describe('/bridge/oauth/authorize', () => {
  afterEach(() => {
    reloadServerPage.mockClear()
    window.history.pushState({}, '', '/')
  })

  it('is not swallowed by the SPA 404', async () => {
    window.history.pushState({}, '', '/bridge/oauth/authorize?response_type=code&state=abc')
    vi.resetModules()
    const { AppRouter } = await import('@/router')
    render(<AppRouter />)
    expect(screen.queryByText('什么也没找到。')).not.toBeInTheDocument()
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(reloadServerPage).toHaveBeenCalledWith('/bridge/oauth/authorize?response_type=code&state=abc')
    })
  })
})
