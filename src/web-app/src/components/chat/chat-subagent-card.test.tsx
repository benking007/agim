import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatSubagentCard } from './chat-subagent-card'
import type { ChatActivity } from '@/hooks/use-chat'
import '@/i18n'

vi.mock('@/lib/api/endpoints', () => ({
  api: {
    getJob: vi.fn(async (id: number) => ({
      job: {
        id,
        kind: 'inline',
        agent: 'agim',
        prompt: `PARENT_PROMPT_FOR_${id}`,
        status: 'completed',
        result: `RESULT_BODY_${id}`,
        created_at: '2026-07-24T00:00:00Z',
      },
    })),
  },
}))

function activity(over: Partial<ChatActivity> = {}): ChatActivity {
  return {
    runId: 'r1',
    status: 'running',
    startedAt: 1,
    steps: [
      {
        id: 'a2a-9',
        kind: 'agent',
        label: 'agim/cheap',
        status: 'running',
        startedAt: 1,
        jobId: 9,
        preview: 'Objective: search the codebase',
      },
      {
        id: 'a2a-10',
        kind: 'agent',
        label: 'claude-code',
        status: 'success',
        startedAt: 2,
        finishedAt: 3,
        jobId: 10,
        preview: '0.2s · 120 chars',
      },
    ],
    ...over,
  }
}

describe('ChatSubagentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing without agent steps', () => {
    const { container } = render(
      <ChatSubagentCard activity={{
        runId: 'r',
        status: 'success',
        startedAt: 1,
        steps: [{
          id: 't',
          kind: 'tool',
          label: 'agim_read',
          status: 'success',
          startedAt: 1,
        }],
      }}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows live Subagent rows with status + preview', () => {
    render(<ChatSubagentCard activity={activity()} />)
    expect(screen.getByRole('button', { name: /Subagents · 1 waiting|子代理 · 等待 1 个/ })).toBeInTheDocument()
    expect(screen.getByText('→ agim/cheap')).toBeInTheDocument()
    expect(screen.getByText('→ claude-code')).toBeInTheDocument()
    expect(screen.getByText(/Objective: search the codebase/)).toBeInTheDocument()
    expect(screen.getAllByText(/Waiting for subagent|等待子代理/).length).toBeGreaterThanOrEqual(1)
  })

  it('opens detail dialog with parent prompt and result', async () => {
    const user = userEvent.setup()
    render(<ChatSubagentCard activity={activity({
      status: 'success',
      steps: [{
        id: 'a2a-10',
        kind: 'agent',
        label: 'claude-code',
        status: 'success',
        startedAt: 1,
        finishedAt: 2,
        jobId: 10,
        preview: '0.2s · 120 chars',
      }],
    })}
    />)
    // Expand if collapsed after success.
    const header = screen.getByRole('button', { name: /Subagents · 1|子代理 · 1/ })
    await user.click(header)
    await user.click(screen.getByRole('button', { name: /→ claude-code/ }))
    await waitFor(() => {
      expect(screen.getByText('PARENT_PROMPT_FOR_10')).toBeInTheDocument()
      expect(screen.getByText('RESULT_BODY_10')).toBeInTheDocument()
    })
  })

  it('resolves jobId from a2a-<id> when jobId field missing', async () => {
    const user = userEvent.setup()
    const { api } = await import('@/lib/api/endpoints')
    render(<ChatSubagentCard activity={activity({
      status: 'success',
      steps: [{
        id: 'a2a-42',
        kind: 'agent',
        label: 'agim',
        status: 'success',
        startedAt: 1,
        finishedAt: 2,
        preview: 'done',
      }],
    })}
    />)
    const header = screen.getByRole('button', { name: /Subagents · 1|子代理 · 1/ })
    await user.click(header)
    await user.click(screen.getByRole('button', { name: /→ agim/ }))
    await waitFor(() => {
      expect(api.getJob).toHaveBeenCalledWith(42)
      expect(screen.getByText('PARENT_PROMPT_FOR_42')).toBeInTheDocument()
    })
  })
})
