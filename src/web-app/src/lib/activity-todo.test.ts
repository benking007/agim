import { describe, expect, it } from 'vitest'
import type { ChatActivity } from '@/hooks/use-chat'
import {
  completeStickyInProgressItems,
  extractLatestTodoItems,
  parseTodoItemsFromPreview,
  summarizeTodoItems,
} from './activity-todo'

describe('parseTodoItemsFromPreview', () => {
  it('parses markdown checklist icons', () => {
    const items = parseTodoItemsFromPreview(
      '1. ☑ 已完成项\n2. ▶ 进行中项\n3. ☐ 待办项',
    )
    expect(items).toEqual([
      { content: '已完成项', status: 'completed' },
      { content: '进行中项', status: 'in_progress' },
      { content: '待办项', status: 'pending' },
    ])
  })

  it('parses JSON items preview', () => {
    const items = parseTodoItemsFromPreview(JSON.stringify({
      items: [
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'pending' },
      ],
    }))
    expect(items).toEqual([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'pending' },
    ])
  })
})

describe('extractLatestTodoItems', () => {
  it('prefers the latest todo step and structured todoItems', () => {
    const activity: ChatActivity = {
      runId: 'r1',
      status: 'running',
      startedAt: 1,
      steps: [
        {
          id: 't1',
          kind: 'tool',
          label: 'agim_todo_write',
          status: 'success',
          startedAt: 1,
          todoItems: [{ content: 'old', status: 'pending' }],
        },
        {
          id: 'r1',
          kind: 'tool',
          label: 'agim_read',
          status: 'success',
          startedAt: 2,
          preview: 'noise',
        },
        {
          id: 't2',
          kind: 'tool',
          label: 'agim_todo_write',
          status: 'running',
          startedAt: 3,
          todoItems: [
            { content: 'one', status: 'completed' },
            { content: 'two', status: 'in_progress' },
          ],
        },
      ],
    }
    expect(extractLatestTodoItems(activity)).toEqual([
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'in_progress' },
    ])
  })

  it('falls back to markdown preview when todoItems missing', () => {
    const activity: ChatActivity = {
      runId: 'r1',
      status: 'success',
      startedAt: 1,
      steps: [{
        id: 't1',
        kind: 'tool',
        label: 'native_todo_write',
        status: 'success',
        startedAt: 1,
        preview: '1. ▶ fetch quotes\n2. ☐ write report',
      }],
    }
    expect(extractLatestTodoItems(activity)).toEqual([
      { content: 'fetch quotes', status: 'in_progress' },
      { content: 'write report', status: 'pending' },
    ])
  })
})

describe('summarizeTodoItems', () => {
  it('counts statuses', () => {
    expect(summarizeTodoItems([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'pending' },
    ])).toEqual({
      total: 4,
      completed: 2,
      inProgress: 1,
      pending: 1,
      allDone: false,
    })
  })
})

describe('completeStickyInProgressItems', () => {
  it('marks the last in_progress item completed', () => {
    expect(completeStickyInProgressItems([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ])).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
    ])
  })

  it('returns null when pending remains', () => {
    expect(completeStickyInProgressItems([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ])).toBeNull()
  })
})
