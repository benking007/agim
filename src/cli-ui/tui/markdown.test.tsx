// Tests for the TUI markdown table formatter. We test the pure
// buildTableLines / displayWidth helpers directly (no ink runtime needed,
// and ink-testing-library isn't a dependency). The regression these guard
// against: GFM tables used to be dropped entirely because table tokens have
// no `.text` field.

import { describe, it, expect } from 'bun:test'
import { marked } from 'marked'
import { buildTableLines, displayWidth } from './markdown.js'

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
