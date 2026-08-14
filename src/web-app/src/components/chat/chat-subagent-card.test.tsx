import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatSubagentCard, formatSubagentElapsed } from './chat-subagent-card'
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

describe('formatSubagentElapsed', () => {
  it('formats ms / seconds / minutes', () => {
    expect(formatSubagentElapsed(0)).toBe('0ms')
    expect(formatSubagentElapsed(420)).toBe('420ms')
    expect(formatSubagentElapsed(2300)).toBe('2.3s')
    expect(formatSubagentElapsed(12_400)).toBe('12s')
    expect(formatSubagentElapsed(65_000)).toBe('1m 5s')
  })
})

describe('ChatSubagentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows live elapsed time next to the SUBAGENT badge', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T10:00:10.000Z'))
    try {
      render(<ChatSubagentCard activity={activity({
        steps: [{
          id: 'a2a-9',
          kind: 'agent',
          label: 'codex',
          status: 'running',
          startedAt: Date.parse('2026-07-27T10:00:00.000Z'),
          jobId: 9,
          preview: 'Objective: fix bugs',
        }],
      })}
      />)
      const elapsed = screen.getByTestId('subagent-elapsed-live')
      expect(elapsed).toHaveTextContent('10s')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(screen.getByTestId('subagent-elapsed-live')).toHaveTextContent('11s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show live elapsed on completed rows', () => {
    render(<ChatSubagentCard activity={activity({
      status: 'success',
      steps: [{
        id: 'a2a-10',
        kind: 'agent',
        label: 'codex',
        status: 'success',
        startedAt: 1,
        finishedAt: 2,
        jobId: 10,
        preview: '439.9s · 4501 chars',
      }],
    })}
    />)
    // Expand collapsed done card.
    const header = screen.getByRole('button', { name: /Subagents · 1|子代理 · 1/ })
    expect(header).toBeInTheDocument()
    expect(screen.queryByTestId('subagent-elapsed-live')).not.toBeInTheDocument()
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

  it('labels denied Subagent rows as blocked (not failed)', () => {
    render(<ChatSubagentCard activity={activity({
      steps: [{
        id: 'a2a-9',
        kind: 'agent',
        label: 'agim',
        status: 'denied',
        startedAt: 1,
        finishedAt: 2,
        jobId: 9,
        preview: 'denied by policy: agim_exec',
      }],
    })}
    />)
    expect(screen.getByText(/blocked|已拒绝|被阻止/)).toBeInTheDocument()
    expect(screen.queryByText(/^failed$/i)).not.toBeInTheDocument()
  })

  it('does not list loop-parent-wait gate denials as Subagents', () => {
    const { container } = render(<ChatSubagentCard activity={activity({
      steps: [{
        id: 'tc-1',
        kind: 'agent',
        label: 'mcp__agim__call_agents',
        status: 'denied',
        startedAt: 1,
        finishedAt: 2,
        preview: 'loop-parent-wait: after dispatch this round, parent must ONLY wait',
      }],
    })}
    />)
    expect(container.firstChild).toBeNull()
  })

  it('wraps long Objective preview instead of single-line truncate', () => {
    const long = `Objective: ${'研究识别美股牛熊周期拐点的宏观与估值类指标，'.repeat(4)}用中文输出`
    render(<ChatSubagentCard activity={activity({
      steps: [{
        id: 'a2a-9',
        kind: 'agent',
        label: 'agim',
        status: 'running',
        startedAt: 1,
        jobId: 9,
        preview: long,
      }],
    })}
    />)
    const preview = screen.getByText(/Objective: 研究识别/)
    expect(preview.className).toMatch(/break-words/)
    expect(preview.className).toMatch(/whitespace-normal/)
    expect(preview.className).not.toMatch(/\btruncate\b/)
  })

  it('exposes Stop on live rows and calls onStopSubagent with jobId', async () => {
    const user = userEvent.setup()
    const onStopSubagent = vi.fn(() => true)
    render(<ChatSubagentCard activity={activity()} onStopSubagent={onStopSubagent} />)
    const stopBtn = screen.getByRole('button', { name: /^(Stop|停止)$/ })
    expect(stopBtn).toBeInTheDocument()
    // Completed row must not show Stop.
    expect(screen.getAllByRole('button', { name: /^(Stop|停止)$/ })).toHaveLength(1)
    await user.click(stopBtn)
    expect(onStopSubagent).toHaveBeenCalledWith(9)
    expect(screen.getByRole('button', { name: /Stopping|停止中/ })).toBeInTheDocument()
  })

  it('opens composer-docked sheet with parent prompt and result', async () => {
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
    // Sheet chrome: expand + close affordances (Cursor-style half-float).
    expect(screen.getByRole('button', { name: /Expand sheet|扩大浮层/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Close|关闭/ })).toBeInTheDocument()
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
      const calls = vi.mocked(api.getJob).mock.calls
      expect(calls.some((c) => c[0] === 42)).toBe(true)
      expect(screen.getByText('PARENT_PROMPT_FOR_42')).toBeInTheDocument()
    })
  })

  it('reserves a one-line step-reflect slot on live Agim rows when enabled', () => {
    render(<ChatSubagentCard
      stepReflectEnabled
      activity={activity({
        steps: [{
          id: 'a2a-9',
          kind: 'agent',
          label: 'agim/cheap',
          status: 'running',
          startedAt: 1,
          jobId: 9,
          preview: 'Objective: search',
        }],
      })}
    />)
    const slot = screen.getByTestId('step-reflect-slot')
    expect(slot.className).toMatch(/\bh-5\b/)
    expect(slot.textContent).toMatch(/Thinking|思考中|Step reflect|一步一想/)
  })

  it('does not show the slot on CLI workers', () => {
    render(<ChatSubagentCard
      stepReflectEnabled
      activity={activity({
        steps: [{
          id: 'a2a-10',
          kind: 'agent',
          label: 'claude-code',
          status: 'running',
          startedAt: 1,
          jobId: 10,
          preview: 'CLI work',
        }],
      })}
    />)
    expect(screen.queryByTestId('step-reflect-slot')).toBeNull()
  })

  it('shows a child tool on the slot instead of Thinking…', () => {
    render(<ChatSubagentCard
      stepReflectEnabled
      activity={activity({
        steps: [{
          id: 'a2a-11',
          kind: 'agent',
          label: 'agim:deepseek-v4-pro',
          status: 'running',
          startedAt: 1,
          jobId: 11,
          lastTool: { label: 'agim_web_search', status: 'running', at: 2 },
        }],
      })}
    />)
    const slot = screen.getByTestId('step-reflect-slot')
    expect(slot.textContent).toContain('web_search')
    expect(slot.textContent).not.toMatch(/Thinking|思考中/)
  })

  it('keeps the last reflect after the row completes', async () => {
    const user = userEvent.setup()
    render(<ChatSubagentCard
      stepReflectEnabled
      activity={activity({
        status: 'success',
        steps: [{
          id: 'a2a-9',
          kind: 'agent',
          label: 'agim',
          status: 'success',
          startedAt: 1,
          finishedAt: 2,
          jobId: 9,
          reflects: [{ stance: 'keep', next: 'Summarize the links', at: 2 }],
        }],
      })}
    />)
    await user.click(screen.getByRole('button', { name: /Subagents · 1|子代理 · 1/ }))
    const slot = screen.getByTestId('step-reflect-slot')
    expect(slot.className).toMatch(/\bh-5\b/)
    expect(slot.textContent).toContain('Summarize the links')
  })
})
