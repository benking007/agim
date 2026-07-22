import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatTodoList } from './chat-todo-list'
import type { ChatActivity } from '@/hooks/use-chat'
import '@/i18n'

function activity(over: Partial<ChatActivity> = {}): ChatActivity {
  return {
    runId: 'r1',
    status: 'running',
    startedAt: 1,
    steps: [{
      id: 't1',
      kind: 'tool',
      label: 'agim_todo_write',
      status: 'success',
      startedAt: 1,
      todoItems: [
        { content: '获取科技板块指数', status: 'completed' },
        { content: '获取龙头行情', status: 'in_progress' },
        { content: '输出报告', status: 'pending' },
      ],
    }],
    ...over,
  }
}

describe('ChatTodoList', () => {
  it('renders nothing without todo steps', () => {
    const { container } = render(
      <ChatTodoList activity={{
        runId: 'r',
        status: 'success',
        startedAt: 1,
        steps: [{
          id: 'x',
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

  it('shows checklist items and progress title', () => {
    render(<ChatTodoList activity={activity()} />)
    expect(screen.getByRole('button', { name: /Plan|计划/ })).toBeInTheDocument()
    expect(screen.getByText('获取科技板块指数')).toBeInTheDocument()
    expect(screen.getByText('获取龙头行情')).toBeInTheDocument()
    expect(screen.getByText('输出报告')).toBeInTheDocument()
  })

  it('collapses and expands on header click', async () => {
    const user = userEvent.setup()
    render(<ChatTodoList activity={activity({
      status: 'success',
      steps: [{
        id: 't1',
        kind: 'tool',
        label: 'agim_todo_write',
        status: 'success',
        startedAt: 1,
        todoItems: [
          { content: '完成项甲', status: 'completed' },
          { content: '完成项乙', status: 'completed' },
        ],
      }],
    })}
    />)
    // all done → starts collapsed
    expect(screen.queryByText('完成项甲')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Plan|计划/ }))
    expect(screen.getByText('完成项甲')).toBeInTheDocument()
    expect(screen.getByText('完成项乙')).toBeInTheDocument()
  })
})
