import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatActivityBlock } from './chat-activity-block'
import type { ChatActivity } from '@/hooks/use-chat'
import '@/i18n'

function activity(over: Partial<ChatActivity> = {}): ChatActivity {
  return {
    runId: 'r1',
    status: 'success',
    startedAt: 1,
    finishedAt: 4501,
    durationMs: 4500,
    steps: [
      {
        id: 's1',
        kind: 'tool',
        label: 'agim_read',
        status: 'success',
        startedAt: 1,
        finishedAt: 2,
        preview: '{"path":"a.ts"}',
      },
      {
        id: 's2',
        kind: 'approval',
        label: 'agim_exec',
        status: 'success',
        startedAt: 3,
        finishedAt: 4,
      },
    ],
    ...over,
  }
}

describe('ChatActivityBlock', () => {
  it('shows Worked summary with kind tallies when completed', () => {
    render(<ChatActivityBlock activity={activity()} />)
    const btn = screen.getByRole('button', { name: /Worked|已完成/ })
    expect(btn).toBeInTheDocument()
    expect(btn.textContent).toMatch(/1 tool|1 次工具/)
    expect(btn.textContent).toMatch(/1 approval|1 次审批/)
    // Default collapsed — step labels stay hidden until expand.
    expect(screen.queryByText('agim_read')).not.toBeInTheDocument()
  })

  it('stays collapsed while Running (title only)', () => {
    render(<ChatActivityBlock activity={activity({
      status: 'running',
      finishedAt: undefined,
      durationMs: undefined,
      steps: [{
        id: 's1',
        kind: 'approval',
        label: 'agim_exec',
        status: 'pending',
        startedAt: 1,
      }],
    })}
    />)
    expect(screen.getByRole('button', { name: /Running|执行中/ })).toBeInTheDocument()
    expect(screen.queryByText('agim_exec')).not.toBeInTheDocument()
  })

  it('expands to list tool steps', async () => {
    const user = userEvent.setup()
    render(<ChatActivityBlock activity={activity()} />)
    await user.click(screen.getByRole('button', { name: /Worked|已完成/ }))
    expect(screen.getByText('agim_read')).toBeInTheDocument()
    expect(screen.getByText('agim_exec')).toBeInTheDocument()
  })

  it('shows Running while in progress after expand', async () => {
    const user = userEvent.setup()
    render(<ChatActivityBlock activity={activity({
      status: 'running',
      finishedAt: undefined,
      durationMs: undefined,
      steps: [{
        id: 's1',
        kind: 'approval',
        label: 'agim_exec',
        status: 'pending',
        startedAt: 1,
      }],
    })}
    />)
    expect(screen.getByRole('button', { name: /Running|执行中/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Running|执行中/ }))
    expect(screen.getByText('agim_exec')).toBeInTheDocument()
  })

  it('labels skill steps when expanded', async () => {
    const user = userEvent.setup()
    render(<ChatActivityBlock activity={activity({
      steps: [{
        id: 'sk1',
        kind: 'skill',
        label: 'skill_accessibility',
        status: 'success',
        startedAt: 1,
        finishedAt: 2,
      }],
    })}
    />)
    const btn = screen.getByRole('button', { name: /Worked|已完成/ })
    expect(btn.textContent).toMatch(/1 skill|1 次技能/)
    await user.click(btn)
    expect(screen.getByText('skill_accessibility')).toBeInTheDocument()
    expect(screen.getByText(/^skill$|^技能$/)).toBeInTheDocument()
  })

  it('shows Waiting for subagent while a delegated agent is running', () => {
    render(<ChatActivityBlock activity={activity({
      status: 'running',
      finishedAt: undefined,
      durationMs: undefined,
      steps: [{
        id: 'a2a-1',
        kind: 'agent',
        label: 'claude-code',
        status: 'running',
        startedAt: 1,
      }],
    })}
    />)
    expect(screen.getByRole('button', { name: /Running|执行中/ })).toBeInTheDocument()
    expect(screen.getByText(/Waiting for subagent|等待子 Agent/)).toBeInTheDocument()
    // Collapsed: agent appears in the title, not as an expanded step row.
    expect(screen.getByRole('button', { name: /-> claude-code/ })).toBeInTheDocument()
    expect(screen.queryByText(/^running$|^运行中$/)).not.toBeInTheDocument()
  })

  it('keeps Waiting for subagent even when an approval is also pending', () => {
    render(<ChatActivityBlock activity={activity({
      status: 'running',
      finishedAt: undefined,
      durationMs: undefined,
      steps: [
        {
          id: 'a2a-1',
          kind: 'agent',
          label: 'claude-code',
          status: 'running',
          startedAt: 1,
        },
        {
          id: 'apv-1',
          kind: 'approval',
          label: 'agim_exec',
          status: 'pending',
          startedAt: 2,
        },
      ],
    })}
    />)
    expect(screen.getByText(/Waiting for subagent|等待子 Agent/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /-> claude-code/ })).toBeInTheDocument()
  })

  it('shows completed badge for finished agent steps', async () => {
    const user = userEvent.setup()
    render(<ChatActivityBlock activity={activity({
      steps: [{
        id: 'a2a-2',
        kind: 'agent',
        label: 'codex',
        status: 'success',
        startedAt: 1,
        finishedAt: 2,
      }],
    })}
    />)
    await user.click(screen.getByRole('button', { name: /Worked|已完成/ }))
    expect(screen.getByText(/-> codex/)).toBeInTheDocument()
    const badges = screen.getAllByText(/^completed$|^已完成$/)
    expect(badges.length).toBeGreaterThanOrEqual(1)
  })
})
