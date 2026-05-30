/**
 * MarkdownView — render contract for the chat-bubble markdown surface.
 *
 * Goal: assistant text that the LLM produces in markdown (tables, code,
 * headings, **bold**, lists) renders as DOM tags instead of literal
 * `##` / `**` clutter the user sees in plain-text mode. GFM-only —
 * no raw HTML passthrough (security).
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MarkdownView } from './markdown-view'

describe('MarkdownView', () => {
  it('renders headings, bold, and italics as real DOM tags', () => {
    render(<MarkdownView content={'## Section\n\nThis is **bold** and *italic*.'} />)
    expect(screen.getByRole('heading')).toHaveTextContent('Section')
    expect(screen.getByText('bold').tagName.toLowerCase()).toBe('strong')
    expect(screen.getByText('italic').tagName.toLowerCase()).toBe('em')
  })

  it('renders GFM tables', () => {
    const table = '| col1 | col2 |\n|------|------|\n| a | 1 |\n| b | 2 |'
    render(<MarkdownView content={table} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    // Headers + data cells present.
    expect(screen.getByRole('columnheader', { name: 'col1' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'a' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '2' })).toBeInTheDocument()
  })

  it('renders unordered + ordered lists', () => {
    render(<MarkdownView content={'- alpha\n- beta\n\n1. one\n2. two'} />)
    const lists = screen.getAllByRole('list')
    expect(lists).toHaveLength(2)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('renders fenced code blocks and inline code', () => {
    render(<MarkdownView content={'Run `npm test` then\n\n```\nfoo\n```'} />)
    // Inline <code> inside the paragraph
    expect(screen.getByText('npm test').tagName.toLowerCase()).toBe('code')
    // Fenced code wrapped in <pre>
    const fenced = document.querySelector('pre code')
    expect(fenced?.textContent).toContain('foo')
  })

  it('treats links safely (target=_blank rel=noreferrer)', () => {
    render(<MarkdownView content={'see [docs](https://example.com)'} />)
    const a = screen.getByRole('link', { name: 'docs' }) as HTMLAnchorElement
    expect(a.href).toBe('https://example.com/')
    expect(a.target).toBe('_blank')
    expect(a.rel).toContain('noreferrer')
  })

  it('does NOT render raw HTML (no rehype-raw — XSS safety)', () => {
    // Raw <script> / <img> tags in assistant content must NOT execute
    // or inject DOM. react-markdown's default is text-only for unknown
    // HTML; we rely on that.
    const malicious = 'before <script>alert(1)</script><img src=x onerror=alert(2)> after'
    render(<MarkdownView content={malicious} />)
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('streaming-partial markdown does not crash', () => {
    // Mid-stream chunk: `**bold` (no closing marker yet).
    render(<MarkdownView content={'leading **bold but unclos'} />)
    // The `**` stays as literal text; no thrown error from the parser.
    expect(document.body.textContent).toContain('bold but unclos')
  })
})
