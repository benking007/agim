import { describe, expect, it } from 'bun:test'
import {
  extractTodoItemsFromInput,
  isTodoActivityLabel,
  parseTodoItemsFromMarkdown,
  renderMarkdownChecklist,
  resolveTodoItems,
} from '../../src/core/llm/todo-items.js'

describe('todo-items helpers', () => {
  it('detects todo activity labels', () => {
    expect(isTodoActivityLabel('agim_todo_write')).toBe(true)
    expect(isTodoActivityLabel('native_todo_write')).toBe(true)
    expect(isTodoActivityLabel('mcp__agim__agim_todo_write')).toBe(true)
    expect(isTodoActivityLabel('agim_exec')).toBe(false)
  })

  it('extracts items from tool input', () => {
    expect(extractTodoItemsFromInput({
      items: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
      ],
    })).toEqual([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
    ])
  })

  it('round-trips markdown checklist', () => {
    const items = [
      { content: 'done', status: 'completed' as const },
      { content: 'now', status: 'in_progress' as const },
      { content: 'later', status: 'pending' as const },
    ]
    const md = renderMarkdownChecklist(items)
    expect(md).toContain('1. ☑ done')
    expect(parseTodoItemsFromMarkdown(md)).toEqual(items)
  })

  it('resolveTodoItems prefers input over result text', () => {
    expect(resolveTodoItems({
      input: { items: [{ content: 'from-input', status: 'pending' }] },
      resultText: '1. ☑ from-result',
    })).toEqual([{ content: 'from-input', status: 'pending' }])
  })
})
