import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  buildTodoDispatcher,
  clearTodoForThread,
  getTodoForThread,
  reconcileTodoOnSuccessfulTurn,
} from '../../src/core/llm/todo-dispatcher.js'

const KEY = 'web:web:todo-reconcile-turn'

describe('reconcileTodoOnSuccessfulTurn', () => {
  beforeEach(() => clearTodoForThread(KEY))
  afterEach(() => clearTodoForThread(KEY))

  it('persists all-completed when only the last item is in_progress', async () => {
    const write = buildTodoDispatcher(KEY)
    await write({
      id: '1',
      name: 'agim_todo_write',
      arguments: {
        items: [
          { content: '1', status: 'completed' },
          { content: '2', status: 'completed' },
          { content: 'last', status: 'in_progress' },
        ],
      },
    }, new AbortController().signal)

    const next = reconcileTodoOnSuccessfulTurn(KEY)
    expect(next?.every((it) => it.status === 'completed')).toBe(true)
    expect(getTodoForThread(KEY)?.at(-1)?.status).toBe('completed')
  })

  it('no-ops when pending items remain', async () => {
    const write = buildTodoDispatcher(KEY)
    await write({
      id: '1',
      name: 'agim_todo_write',
      arguments: {
        items: [
          { content: '1', status: 'completed' },
          { content: '2', status: 'in_progress' },
          { content: '3', status: 'pending' },
        ],
      },
    }, new AbortController().signal)

    expect(reconcileTodoOnSuccessfulTurn(KEY)).toBeNull()
    expect(getTodoForThread(KEY)?.at(-1)?.status).toBe('pending')
  })
})
