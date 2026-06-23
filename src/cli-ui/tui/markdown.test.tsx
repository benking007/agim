// Tests for the TUI markdown table formatter. We test the pure
// buildTableLines / displayWidth helpers directly (no ink runtime needed,
// and ink-testing-library isn't a dependency). The regression these guard
// against: GFM tables used to be dropped entirely because table tokens have
// no `.text` field.

import { describe, it, expect } from 'bun:test'
import { marked } from 'marked'
import { buildTableLines, displayWidth, Markdown, renderInlineCell, inlineCellText, highlightCode } from './markdown.js'

// Walk a React element tree and concatenate all string/number leaves. Lets
// us assert on rendered text without an ink runtime (ink-testing-library is
// not a dependency). We call Markdown() directly to get its element tree.
// biome-ignore lint/suspicious/noExplicitAny: test-only tree walk
function flatten(node: any): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (node.props && 'children' in node.props) return flatten(node.props.children)
  return ''
}
function renderText(md: string, width = 120): string {
  return flatten(Markdown({ source: md, width }))
}

// Helper: tokenize a markdown table and pull header/rows/align like the
// renderer does, so the tests exercise the real marked token shape.
function tableParts(md: string): { header: string[]; rows: string[][]; align: Array<'left' | 'right' | 'center' | null> } {
  const tok = marked.lexer(md).find((t) => t.type === 'table') as {
    header: Array<{ text: string }>; rows: Array<Array<{ text: string }>>; align: Array<'left' | 'right' | 'center' | null>
  }
  return {
    header: tok.header.map((c) => c.text),
    rows: tok.rows.map((r) => r.map((c) => c.text)),
    align: tok.align,
  }
}

const SAMPLE = [
  '| Name | Score |',
  '|------|------:|',
  '| Ann  | 10    |',
  '| Bob  | 7     |',
].join('\n')

describe('displayWidth', () => {
  it('counts ASCII as 1 and CJK as 2', () => {
    expect(displayWidth('a')).toBe(1)
    expect(displayWidth('ab')).toBe(2)
    expect(displayWidth('中')).toBe(2)
    expect(displayWidth('中文')).toBe(4)
    expect(displayWidth('中a')).toBe(3)
  })
})

describe('buildTableLines — grid mode', () => {
  it('renders header, separator and every row when it fits', () => {
    const { header, rows, align } = tableParts(SAMPLE)
    const { mode, lines } = buildTableLines(header, rows, align, 80)
    expect(mode).toBe('grid')
    // header + separator + 2 data rows
    expect(lines.length).toBe(4)
    expect(lines[0]).toContain('Name')
    expect(lines[0]).toContain('Score')
    expect(lines[1]).toMatch(/─.*┼.*─/)
    expect(lines.some((l) => l.includes('Ann') && l.includes('10'))).toBe(true)
    expect(lines.some((l) => l.includes('Bob') && l.includes('7'))).toBe(true)
  })

  it('pads columns to equal display width (rows align)', () => {
    const { header, rows, align } = tableParts(SAMPLE)
    const { lines } = buildTableLines(header, rows, align, 80)
    const widths = lines.map((l) => displayWidth(l))
    // header + all data rows share one width; the separator may differ by
    // the ┼ vs │ glyph, so compare the data rows + header only.
    const dataWidths = [widths[0], ...widths.slice(2)]
    expect(new Set(dataWidths).size).toBe(1)
  })

  it('never drops rows (5-row table keeps all 5)', () => {
    const md = [
      '| K | V |',
      '|---|---|',
      ...Array.from({ length: 5 }, (_, i) => `| k${i} | v${i} |`),
    ].join('\n')
    const { header, rows, align } = tableParts(md)
    const { lines } = buildTableLines(header, rows, align, 80)
    for (let i = 0; i < 5; i++) {
      expect(lines.some((l) => l.includes(`k${i}`) && l.includes(`v${i}`))).toBe(true)
    }
  })
})

describe('buildTableLines — list fallback (too wide)', () => {
  it('degrades to header: value records without dropping data', () => {
    const { header, rows, align } = tableParts(SAMPLE)
    const { mode, lines } = buildTableLines(header, rows, align, 8) // tiny width
    expect(mode).toBe('list')
    const joined = lines.join('\n')
    // every header:value pair present
    expect(joined).toContain('Name: Ann')
    expect(joined).toContain('Score: 10')
    expect(joined).toContain('Name: Bob')
    expect(joined).toContain('Score: 7')
  })
})

describe('list rendering', () => {
  it('renders inline formatting in items WITHOUT literal markdown', () => {
    const text = renderText('- **bold** and `code` here')
    expect(text).toContain('bold')
    expect(text).toContain('code')
    expect(text).not.toContain('**') // no literal asterisks leaking through
  })

  it('keeps nested sub-list items', () => {
    const text = renderText('- parent\n  - nested child\n  - second child')
    expect(text).toContain('parent')
    expect(text).toContain('nested child')
    expect(text).toContain('second child')
  })

  it('shows task checkboxes', () => {
    const text = renderText('- [ ] todo\n- [x] done')
    expect(text).toContain('☐')
    expect(text).toContain('☑')
    expect(text).toContain('todo')
    expect(text).toContain('done')
  })

  it('honours ordered-list start offset', () => {
    const text = renderText('3. third\n4. fourth')
    expect(text).toContain('3.')
    expect(text).toContain('4.')
    expect(text).toContain('third')
    expect(text).toContain('fourth')
  })
})

describe('blockquote rendering', () => {
  it('renders quoted bold without literal markup and keeps a quoted list', () => {
    const text = renderText('> quoted **strong**\n> - quoted item')
    expect(text).toContain('quoted')
    expect(text).toContain('strong')
    expect(text).not.toContain('**')
    expect(text).toContain('quoted item') // nested list inside the quote survives
  })
})

describe('table rendering via <Markdown>', () => {
  it('renders a table (regression: tables used to vanish)', () => {
    const text = renderText('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(text).toContain('A')
    expect(text).toContain('B')
    expect(text).toContain('1')
    expect(text).toContain('2')
  })
})

// Helper: inline tokens of the first paragraph of `md`.
function inlineTokens(md: string): unknown[] {
  const p = marked.lexer(md).find((t) => t.type === 'paragraph') as { tokens: unknown[] }
  return p.tokens
}

describe('renderInlineCell — width-preserving inline (table cells)', () => {
  it('emits styled content with the SAME characters as cell.text (no markup chars)', () => {
    const toks = inlineTokens('**b** `c` [x](http://u)')
    // marked produces a `text` token " " between inline spans; flattened text
    // must equal the visible plain form with NO **, backticks or URL.
    const flat = flatten(renderInlineCell(toks as never, 'k'))
    expect(flat).toBe('b c x')
    expect(flat).not.toContain('*')
    expect(flat).not.toContain('`')
    expect(flat).not.toContain('http')
  })

  it('rendered width matches inlineCellText (keeps columns aligned)', () => {
    const md = '| H |\n|---|\n| **b** `c` |'
    const tok = marked.lexer(md).find((t) => t.type === 'table') as {
      rows: Array<Array<{ text: string; tokens: unknown[] }>>
    }
    const c = tok.rows[0][0]
    // marked keeps raw markup in c.text ("**b** `c`"); the rendered/visible
    // form is "b c" and that is what width math must use.
    expect(flatten(renderInlineCell(c.tokens as never, 'k'))).toBe('b c')
    expect(displayWidth(flatten(renderInlineCell(c.tokens as never, 'k')))).toBe(displayWidth(inlineCellText(c.tokens as never)))
  })
})

describe('styled table via <Markdown>', () => {
  it('renders bold/code cell values fully and without literal markup', () => {
    const text = renderText('| Name | Note |\n|------|------|\n| **Ann** | `ok` |\n| Bob | done |')
    expect(text).toContain('Ann')
    expect(text).toContain('ok')
    expect(text).toContain('Bob')
    expect(text).toContain('done')
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
  })
})

describe('highlightCode — strings / comments / numbers / keywords', () => {
  const kindOf = (spans: ReturnType<typeof highlightCode>, substr: string) =>
    spans.find((s) => s.text.includes(substr))?.kind

  it('does not colour keywords inside strings or comments', () => {
    const spans = highlightCode('const s = "return 1" // return', 'js')
    // the string span carries the inner `return`, not a keyword span
    expect(kindOf(spans, '"return 1"')).toBe('string')
    expect(kindOf(spans, '// return')).toBe('comment')
    expect(kindOf(spans, 'const')).toBe('keyword')
    // no standalone keyword span equal to 'return'
    expect(spans.some((s) => s.kind === 'keyword' && s.text === 'return')).toBe(false)
  })

  it('colours numbers', () => {
    const spans = highlightCode('let x = 42', 'ts')
    expect(spans.some((s) => s.kind === 'number' && s.text === '42')).toBe(true)
  })

  it('python uses # line comments', () => {
    const spans = highlightCode('x = 1  # note', 'py')
    expect(kindOf(spans, '# note')).toBe('comment')
  })

  it('reconstructs the exact source (no characters lost)', () => {
    const src = 'const s = "a" // b\nreturn 3'
    expect(highlightCode(src, 'js').map((s) => s.text).join('')).toBe(src)
  })

  it('unknown language → single plain span', () => {
    const spans = highlightCode('whatever 123', 'made-up-lang')
    expect(spans).toEqual([{ text: 'whatever 123' }])
  })
})

describe('minor token cleanups', () => {
  it('drops link-reference definitions (no raw leak)', () => {
    expect(renderText('[id]: https://example.com').trim()).toBe('')
  })

  it('renders images as alt + url', () => {
    const text = renderText('![alt text](http://u/x.png)')
    expect(text).toContain('alt text')
    expect(text).toContain('http://u/x.png')
  })
})

describe('buildTableLines — robustness', () => {
  it('CJK header/cells align by display width', () => {
    const md = [
      '| 名称 | 值 |',
      '|------|----|',
      '| ab   | x  |',
    ].join('\n')
    const { header, rows, align } = tableParts(md)
    const { mode, lines } = buildTableLines(header, rows, align, 80)
    expect(mode).toBe('grid')
    expect(displayWidth(lines[0])).toBe(displayWidth(lines[2]))
  })

  it('ragged rows (fewer cells than header) do not throw and pad out', () => {
    const { mode, lines } = buildTableLines(['A', 'B', 'C'], [['1']], [null, null, null], 80)
    expect(mode).toBe('grid')
    expect(lines.length).toBe(3) // header, sep, 1 row
    expect(lines[2]).toContain('1')
  })
})
