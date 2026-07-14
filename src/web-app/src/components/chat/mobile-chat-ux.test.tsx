import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { MobileChatRedirect } from './mobile-chat-redirect'
import { MobileBottomSheet } from './mobile-bottom-sheet'
import '@/i18n'

function mockMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

describe('MobileChatRedirect', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('redirects narrow viewports to /m/chat', () => {
    mockMatchMedia(true)
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MobileChatRedirect><div>desktop-chat</div></MobileChatRedirect>} />
          <Route path="/m/chat" element={<div>mobile-chat</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('mobile-chat')).toBeInTheDocument()
    expect(screen.queryByText('desktop-chat')).not.toBeInTheDocument()
  })

  it('keeps desktop chat when ?desktop=1', () => {
    mockMatchMedia(true)
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/?desktop=1']}>
        <Routes>
          <Route path="/" element={<MobileChatRedirect><div>desktop-chat</div></MobileChatRedirect>} />
          <Route path="/m/chat" element={<div>mobile-chat</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('desktop-chat')).toBeInTheDocument()
  })

  it('renders children on wide viewports', () => {
    mockMatchMedia(false)
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MobileChatRedirect><div>desktop-chat</div></MobileChatRedirect>} />
          <Route path="/m/chat" element={<div>mobile-chat</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('desktop-chat')).toBeInTheDocument()
  })
})

describe('MobileBottomSheet', () => {
  beforeEach(() => {
    document.body.style.overflow = ''
    document.documentElement.style.overflow = ''
  })

  it('locks body scroll while open and unlocks on close', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { rerender } = render(
      <MobileBottomSheet open onClose={onClose}>
        <div>sheet-body</div>
      </MobileBottomSheet>,
    )
    expect(screen.getByText('sheet-body')).toBeInTheDocument()
    expect(document.body.style.overflow).toBe('hidden')

    await user.click(screen.getByRole('button', { name: /Close|关闭/ }))
    expect(onClose).toHaveBeenCalled()

    rerender(
      <MobileBottomSheet open={false} onClose={onClose}>
        <div>sheet-body</div>
      </MobileBottomSheet>,
    )
    expect(screen.queryByText('sheet-body')).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
  })
})
