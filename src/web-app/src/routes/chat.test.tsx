/**
 * /chat onboarding smoke — verifies the first-use runway that catches
 * users after `agim go` opens the Web console.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ChatRoute from './chat'
import type { ChatMessage, ChatState, UseChat } from '@/hooks/use-chat'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  useChat: vi.fn(),
}))

vi.mock('@/hooks/use-chat', () => ({
  useChat: mocks.useChat,
}))

vi.mock('@/components/chat/native-setup-dialog', () => ({
  NativeSetupDialog: () => null,
}))

function baseState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    messages: [],
    pendingApprovals: [],
    pendingAsks: [],
    runActivities: [],
    activeRunId: null,
    agents: ['claude-code', 'agim'],
    agent: 'claude-code',
    status: 'open',
    currentReplyId: null,
    error: null,
    ...overrides,
  }
}

function userMessage(content: string): ChatMessage {
  return {
    id: 'm-1',
    role: 'user',
    content,
    timestamp: Date.now(),
  }
}

function renderChat(
  state: ChatState = baseState(),
  path = '/',
): ReturnType<typeof render> {
  const hook: UseChat = {
    state,
    send: vi.fn(),
    switchAgent: vi.fn(),
    approvalClick: vi.fn(() => true),
    choiceSubmit: vi.fn(() => true),
    newConversation: vi.fn(),
    switchSession: vi.fn(),
    sessions: [],
    activeSessionId: 'web-test',
    stop: vi.fn(),
    stopSubagent: vi.fn(() => true),
    clearError: vi.fn(),
  }
  mocks.useChat.mockReturnValue(hook)
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('/chat first-use runway', () => {
  beforeEach(() => {
    mocks.useChat.mockReset()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      backends: [],
      roles: {},
      presets: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
  })

  it('renders the first-use runway when the chat is empty and connected', () => {
    renderChat()

    expect(screen.getByRole('heading', { name: 'Get one chat working first' })).toBeInTheDocument()
    expect(screen.getByText('Web ready')).toBeInTheDocument()
    expect(screen.getByText('Current agent: claude-code')).toBeInTheDocument()
    expect(screen.getByText('Web console connected')).toBeInTheDocument()
    expect(screen.getByText('Agent selected: claude-code')).toBeInTheDocument()
    expect(screen.getByText('2 available')).toBeInTheDocument()
  })

  it('fills the composer from a suggested first prompt', async () => {
    const user = userEvent.setup()
    renderChat()

    await user.click(screen.getByRole('button', { name: /Tell me who you are/ }))

    expect(screen.getByPlaceholderText(/Message/)).toHaveValue('Tell me who you are')
  })

  it('links to agent and IM setup from the runway', () => {
    renderChat()

    expect(screen.getByRole('link', { name: /Agent settings/ })).toHaveAttribute('href', '/settings/llm')
    expect(screen.getByRole('link', { name: /Connect IM/ })).toHaveAttribute('href', '/settings/messengers')
  })

  it('does not render the runway once a conversation exists', () => {
    renderChat(baseState({ messages: [userMessage('hello')] }))

    expect(screen.queryByRole('heading', { name: 'Get one chat working first' })).not.toBeInTheDocument()
  })

  it('renders the runway over existing history when welcome=1 is present', () => {
    renderChat(baseState({ messages: [userMessage('hello')] }), '/?welcome=1')

    expect(screen.getByRole('heading', { name: 'Get one chat working first' })).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
  })
})
