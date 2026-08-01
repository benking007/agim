// v1.2.124 — agim_todo_write tool:
//   - items validated (object array, content non-empty, status enum)
//   - tool result is a markdown checklist (☐/▶/☑)
//   - per-thread isolation: writes to thread A don't leak to thread B
//   - clearTodoForThread removes the row
//   - empty items array is valid (clears the list)
//   - getTodoTools advertises the tool with timeoutMs

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  buildTodoDispatcher,
  getTodoTools,
  isTodoToolName,
  getTodoForThread,
  getTodoSnapshot,
  clearTodoForThread,
} from '../../src/core/llm/todo-dispatcher.js'

const SIG = new AbortController().signal

describe('todo-dispatcher (v1.2.124)', () => {
  beforeEach(() => {
    clearTodoForThread('thread-a')
    clearTodoForThread('thread-b')
  })

  describe('getTodoTools / isTodoToolName', () => {
    it('exposes agim_todo_write with timeoutMs', () => {
      const tools = getTodoTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('agim_todo_write')
      expect(tools[0]!.timeoutMs).toBe(5000)
      expect(tools[0]!.description).toMatch(/immediately after finishing each item/i)
      expect(tools[0]!.description).toMatch(/Do NOT wait until the whole task finishes/i)
    })

    it('isTodoToolName recognises the tool', () => {
      expect(isTodoToolName('agim_todo_write')).toBe(true)
      expect(isTodoToolName('agim_echo')).toBe(false)
    })
  })

  describe('write + read', () => {
    it('writes items, returns markdown checklist with status icons', async () => {
      const d = buildTodoDispatcher('thread-a')
      const r = await d({
        id: 't1',
        name: 'agim_todo_write',
        arguments: {
          items: [
            { content: 'Fetch data', status: 'in_progress' },
            { content: 'Analyse', status: 'pending' },
            { content: 'Reply', status: 'pending' },
          ],
        },
      }, SIG)
      expect(r.isError).toBe(false)
      expect(r.source).toBe('todo')
      expect(r.text).toContain('▶ Fetch data')
      expect(r.text).toContain('☐ Analyse')
      expect(r.text).toContain('☐ Reply')
    })

    it('renders ☑ for completed', async () => {
      const d = buildTodoDispatcher('thread-a')
      const r = await d({
        id: 't2',
        name: 'agim_todo_write',
        arguments: { items: [{ content: 'Done step', status: 'completed' }] },
      }, SIG)
      expect(r.text).toContain('☑ Done step')
    })

    it('getTodoForThread reads back the stored list', async () => {
      const d = buildTodoDispatcher('thread-a')
      await d({
        id: 't3',
        name: 'agim_todo_write',
        arguments: { items: [{ content: 'Step 1', status: 'completed' }] },
      }, SIG)
      const list = getTodoForThread('thread-a')
      expect(list).toEqual([{ content: 'Step 1', status: 'completed' }])
      expect(getTodoSnapshot('thread-a')).toEqual({
        status: 'present',
        items: [{ content: 'Step 1', status: 'completed' }],
      })
    })

    it('empty items array clears the list and reports it', async () => {
      const d = buildTodoDispatcher('thread-a')
      await d({
        id: 't4a',
        name: 'agim_todo_write',
        arguments: { items: [{ content: 'X', status: 'pending' }] },
      }, SIG)
      const r = await d({
        id: 't4b',
        name: 'agim_todo_write',
        arguments: { items: [] },
      }, SIG)
      expect(r.isError).toBe(false)
      expect(r.text).toMatch(/cleared|no items/)
      expect(getTodoForThread('thread-a')).toEqual([])
    })
  })

  describe('per-thread isolation', () => {
    it('writes to thread-a do not leak to thread-b', async () => {
      const da = buildTodoDispatcher('thread-a')
      const db = buildTodoDispatcher('thread-b')
      await da({
        id: 't5a',
        name: 'agim_todo_write',
        arguments: { items: [{ content: 'A only', status: 'pending' }] },
      }, SIG)
      await db({
        id: 't5b',
        name: 'agim_todo_write',
        arguments: { items: [{ content: 'B only', status: 'pending' }] },
      }, SIG)
      expect(getTodoForThread('thread-a')).toEqual([{ content: 'A only', status: 'pending' }])
      expect(getTodoForThread('thread-b')).toEqual([{ content: 'B only', status: 'pending' }])
    })
  })

  describe('validation', () => {
    it('rejects non-array items', async () => {
      const d = buildTodoDispatcher('thread-a')
      const r = await d({
        id: 't6',
        name: 'agim_todo_write',
        arguments: { items: 'not an array' },
      }, SIG)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/must be an array/)
    })

    it('rejects empty content', async () => {
      const d = buildTodoDispatcher('thread-a')
      const r = await d({
        id: 't7',
        name: 'agim_todo_write',
        arguments: { items: [{ content: '   ', status: 'pending' }] },
      }, SIG)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/content is required/)
    })

    it('rejects invalid status', async () => {
      const d = buildTodoDispatcher('thread-a')
      // `done` / `complete` alias to completed; use a truly unknown token.
      const r = await d({
        id: 't8',
        name: 'agim_todo_write',
        arguments: { items: [{ content: 'X', status: 'bogus' }] },
      }, SIG)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/status must be one of/)
    })

    it('aliases done → completed', async () => {
      const d = buildTodoDispatcher('thread-a')
      const r = await d({
        id: 't8b',
        name: 'agim_todo_write',
        arguments: { items: [{ content: 'X', status: 'done' }] },
      }, SIG)
      expect(r.isError).toBeFalsy()
      expect(r.text).toMatch(/☑/)
    })

    it('rejects content > 500 chars', async () => {
      const d = buildTodoDispatcher('thread-a')
      const r = await d({
        id: 't9',
        name: 'agim_todo_write',
        arguments: { items: [{ content: 'x'.repeat(501), status: 'pending' }] },
      }, SIG)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/too long/)
    })
  })

  describe('unknown name falls through', () => {
    it('returns source=unknown so combineDispatchers can fall through', async () => {
      const d = buildTodoDispatcher('thread-a')
      const r = await d({ id: 'tu', name: 'not_a_todo_tool', arguments: {} }, SIG)
      expect(r.source).toBe('unknown')
      expect(r.isError).toBe(true)
    })
  })
})
