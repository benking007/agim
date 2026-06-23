// agim TUI markdown renderer — token-walks `marked`'s AST and emits
// Ink <Text> nodes. Intentionally narrow:
//   * paragraphs / bold / italic / inline code / strikethrough
//   * code fence with language label + dim border + naive keyword
//     highlight (no cli-highlight dep; keeps the install lean)
//   * headings → bold + colored
//   * unordered + ordered lists (indent + bullet/number)
//   * blockquotes → dim "│ " prefix
//   * tables → real grid when they fit the terminal width, else a
//     vertical "header: value" record layout (CJK-aware widths). Never
//     drops cells/rows. (Pre-v1.3.7 this fell through to `tok.text`,
//     which is undefined for table tokens, so tables silently vanished.)
//   * links → render text + dim URL inline
//   * images / html → text fallback
//
// Returns a JSX fragment safe to drop inside any Ink <Box>.

import React from 'react'
import { Box, Text } from 'ink'
import { marked, type Tokens } from 'marked'

type Token = ReturnType<typeof marked.lexer>[number] & { tokens?: Token[]; items?: Token[]; text?: string; raw?: string; lang?: string; depth?: number; href?: string; title?: string; ordered?: boolean }

const HEADING_COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red'] as const

// Tiny, dependency-free token-class colorizer for common languages.
// Goal: useful visual separation, NOT correctness. Anything we don't
// recognise renders unstyled.
const KEYWORDS: Record<string, RegExp> = {
  js: /\b(const|let|var|function|return|if|else|for|while|class|new|await|async|import|export|from|as|of|in|typeof|instanceof|this|super|extends|throw|try|catch|finally|switch|case|break|continue|null|undefined|true|false)\b/g,
  ts: /\b(const|let|var|function|return|if|else|for|while|class|new|await|async|import|export|from|as|of|in|typeof|instanceof|this|super|extends|throw|try|catch|finally|switch|case|break|continue|null|undefined|true|false|interface|type|enum|public|private|protected|readonly|implements|namespace)\b/g,
  py: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|None|True|False|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|pass|break|continue|async|await)\b/g,
  sh: /\b(if|then|fi|else|elif|for|while|do|done|case|esac|in|function|return|exit|break|continue|local|export|readonly|set|unset)\b/g,
  bash: /\b(if|then|fi|else|elif|for|while|do|done|case|esac|in|function|return|exit|break|continue|local|export|readonly|set|unset)\b/g,
  go: /\b(func|var|const|type|struct|interface|return|if|else|for|range|switch|case|default|break|continue|go|defer|chan|select|package|import|map|nil|true|false)\b/g,
}

interface HighlightedSpan {
  text: string
  kind?: 'keyword' | 'string' | 'comment' | 'number'
}

// marked emits `language-foo` from fences; common spellings to canonical
// keys above. Without this, ```typescript ``` blocks didn't colour
// because the lookup was for `typescript` not `ts`.
const LANG_ALIASES: Record<string, string> = {
  javascript: 'js', jsx: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts',
  python: 'py', python3: 'py',
  shell: 'sh', bash: 'sh', zsh: 'sh',
  golang: 'go',
}

function highlightCode(code: string, lang?: string): HighlightedSpan[] {
  const lc = lang?.toLowerCase()
  const canon = lc ? (LANG_ALIASES[lc] ?? lc) : undefined
  const kw = canon ? KEYWORDS[canon] : undefined
  if (!kw) return [{ text: code }]
  const spans: HighlightedSpan[] = []
  let last = 0
  // Reset lastIndex since we use the same RegExp instance.
  kw.lastIndex = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
  while ((m = kw.exec(code)) !== null) {
    if (m.index > last) spans.push({ text: code.slice(last, m.index) })
    spans.push({ text: m[0], kind: 'keyword' })
    last = m.index + m[0].length
  }
  if (last < code.length) spans.push({ text: code.slice(last) })
  return spans
}

function spanColor(kind: HighlightedSpan['kind']): string | undefined {
  if (kind === 'keyword') return 'magenta'
  if (kind === 'string')  return 'green'
  if (kind === 'comment') return 'gray'
  if (kind === 'number')  return 'yellow'
  return undefined
}

function tokenKey(tok: Token, prefix: string): string {
  const raw = tok.raw ?? tok.text ?? ''
  return `${prefix}-${tok.type}-${raw.length}-${raw.slice(0, 64)}`
}

function renderInline(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens) return []
  const out: React.ReactNode[] = []
  tokens.forEach((tok, i) => {
    const k = `${keyPrefix}-${i}`
    switch (tok.type) {
      case 'text':
        out.push(<Text key={k}>{tok.text ?? ''}</Text>)
        break
      case 'strong':
        out.push(<Text key={k} bold>{renderInline(tok.tokens, k)}</Text>)
        break
      case 'em':
        out.push(<Text key={k} italic>{renderInline(tok.tokens, k)}</Text>)
        break
      case 'del':
        out.push(<Text key={k} strikethrough>{renderInline(tok.tokens, k)}</Text>)
        break
      case 'codespan':
        out.push(<Text key={k} color="cyan">`{tok.text ?? ''}`</Text>)
        break
      case 'link':
        out.push(
          <Text key={k}>
            <Text underline>{renderInline(tok.tokens, k)}</Text>
            <Text dimColor> ({tok.href ?? ''})</Text>
          </Text>,
        )
        break
      case 'br':
        out.push(<Text key={k}>{'\n'}</Text>)
        break
      default:
        out.push(<Text key={k}>{tok.text ?? tok.raw ?? ''}</Text>)
    }
  })
  return out
}

// ── Table rendering ──────────────────────────────────────────────────
// A `marked` table token carries no `.text` field (only raw/align/header/
// rows), so the old default fall-through rendered an empty string and the
// whole table disappeared. We render it ourselves instead.

type CellAlign = 'left' | 'right' | 'center' | null

/** CJK-aware display width: East-Asian wide / fullwidth code points (and
 *  most emoji) occupy 2 terminal columns, everything else 1. Iterating with
 *  for..of so astral chars (surrogate pairs) count once. Dependency-free —
 *  matches this file's "lean install" ethos. */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    w += isWideCodePoint(cp) ? 2 : 1
  }
  return w
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana/CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & symbols (wide)
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK Ext B+
  )
}

function padCell(s: string, width: number, align: CellAlign): string {
  const pad = Math.max(0, width - displayWidth(s))
  if (align === 'right') return ' '.repeat(pad) + s
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + s + ' '.repeat(pad - left)
  }
  return s + ' '.repeat(pad)
}

/** Format a GFM table into terminal lines. Pure + exported for testing.
 *  - 'grid' mode (fits availWidth): aligned columns separated by " │ ".
 *  - 'list' mode (too wide): "header: value" records, one cell per line,
 *    blank line between rows. Never truncates — wide data degrades to a
 *    readable record layout rather than dropping cells. */
export function buildTableLines(
  header: string[], rows: string[][], align: CellAlign[], availWidth: number,
): { mode: 'grid' | 'list'; lines: string[] } {
  const cols = header.length
  const clean = (v: string | undefined) => (v ?? '').replace(/\s*\n\s*/g, ' ').trim()
  const H = header.map(clean)
  const R = rows.map((r) => Array.from({ length: cols }, (_, i) => clean(r[i])))
  const al = (c: number): CellAlign => align[c] ?? 'left'

  const colW: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = displayWidth(H[c])
    for (const r of R) w = Math.max(w, displayWidth(r[c]))
    colW.push(w)
  }
  const total = colW.reduce((a, b) => a + b, 0) + 3 * Math.max(0, cols - 1)

  if (cols > 0 && total <= availWidth) {
    const fmtRow = (cells: string[]) => cells.map((cell, c) => padCell(cell, colW[c], al(c))).join(' │ ')
    const sep = colW.map((w) => '─'.repeat(w)).join('─┼─')
    return { mode: 'grid', lines: [fmtRow(H), sep, ...R.map(fmtRow)] }
  }

  const lines: string[] = []
  R.forEach((r, ri) => {
    for (let c = 0; c < cols; c++) lines.push(`${H[c]}: ${r[c]}`)
    if (ri < R.length - 1) lines.push('')
  })
  return { mode: 'list', lines }
}

function renderTable(tok: Token, key: string, width: number): React.ReactNode {
  const t = tok as unknown as Tokens.Table
  const header = (t.header ?? []).map((c) => c.text)
  const rows = (t.rows ?? []).map((r) => r.map((c) => c.text))
  const align = (t.align ?? []) as CellAlign[]
  const avail = Math.max(20, width - 2)  // account for the chat box paddingX
  const { mode, lines } = buildTableLines(header, rows, align, avail)
  return (
    <Box key={key} flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => {
        const lk = `${key}-l${i}`
        if (mode === 'grid') {
          if (i === 0) return <Text key={lk} bold color="cyan">{line}</Text>
          if (i === 1) return <Text key={lk} dimColor>{line}</Text>
          return <Text key={lk}>{line}</Text>
        }
        if (line === '') return <Text key={lk}>{' '}</Text>
        const idx = line.indexOf(': ')
        if (idx === -1) return <Text key={lk}>{line}</Text>
        return (
          <Text key={lk}>
            <Text bold color="cyan">{line.slice(0, idx)}</Text>{line.slice(idx)}
          </Text>
        )
      })}
    </Box>
  )
}

function renderBlock(tok: Token, key: string, width: number): React.ReactNode {
  switch (tok.type) {
    case 'heading': {
      const depth = Math.min((tok.depth ?? 1) - 1, HEADING_COLORS.length - 1)
      const prefix = '#'.repeat(tok.depth ?? 1) + ' '
      return (
        <Box key={key} marginBottom={1}>
          <Text bold color={HEADING_COLORS[depth]}>{prefix}</Text>
          <Text bold color={HEADING_COLORS[depth]}>{renderInline(tok.tokens, key)}</Text>
        </Box>
      )
    }
    case 'paragraph':
      return (
        <Box key={key} marginBottom={1}>
          <Text>{renderInline(tok.tokens, key)}</Text>
        </Box>
      )
    case 'code': {
      const lang = (tok as Token & { lang?: string }).lang || ''
      const spans = highlightCode(tok.text ?? '', lang)
      let offset = 0
      return (
        <Box key={key} flexDirection="column" marginBottom={1} borderStyle="round" borderColor="gray" paddingX={1}>
          {lang && <Text dimColor>{lang}</Text>}
          <Text>
            {spans.map((s) => {
              const start = offset
              offset += s.text.length
              return <Text key={`${s.kind ?? 'plain'}-${start}-${s.text.length}`} color={spanColor(s.kind)}>{s.text}</Text>
            })}
          </Text>
        </Box>
      )
    }
    case 'blockquote':
      return (
        <Box key={key} marginBottom={1} flexDirection="column">
          {(tok.tokens ?? []).map((inner, i) => (
            <Box key={tokenKey(inner as Token, key)}>
              <Text dimColor>│ </Text>
              <Text dimColor>{renderInline((inner as Token).tokens, `${key}-${i}`)}</Text>
            </Box>
          ))}
        </Box>
      )
    case 'list': {
      const ordered = !!(tok as Token & { ordered?: boolean }).ordered
      const items = ((tok as Token & { items?: Token[] }).items ?? []) as Token[]
      return (
        <Box key={key} flexDirection="column" marginBottom={1}>
          {items.map((item, i) => {
            const marker = ordered ? `${i + 1}. ` : '• '
            // list_item tokens have nested tokens; flatten to inline text.
            const itemTokens = (item as Token).tokens ?? []
            return (
              <Box key={tokenKey(item, key)}>
                <Text dimColor>{marker}</Text>
                <Text>{renderInline(itemTokens, `${key}-${i}`)}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }
    case 'table':
      return renderTable(tok, key, width)
    case 'hr':
      return <Box key={key} marginBottom={1}><Text dimColor>{'─'.repeat(40)}</Text></Box>
    case 'space':
      return null
    default:
      // html / footnotes / etc. — fall back to RAW markdown source so
      // nothing is silently dropped. (`tok.text` is undefined for several
      // token types; `tok.raw` always holds the matched source.)
      return (
        <Box key={key} marginBottom={1}>
          <Text dimColor>{tok.raw ?? tok.text ?? ''}</Text>
        </Box>
      )
  }
}

/** Render arbitrary markdown source as Ink components. `width` is the
 *  available terminal column count for this block (used to decide table
 *  grid vs. record layout); defaults to the current stdout width. */
export function Markdown({ source, width }: { source: string; width?: number }): JSX.Element {
  // Empty body: just nothing.
  if (!source) return <Text />
  const cols = width ?? process.stdout?.columns ?? 80
  let tokens: Token[]
  try {
    tokens = marked.lexer(source) as Token[]
  } catch {
    // Fallback: render as plain text if the lexer chokes (e.g. partial
    // mid-stream content with unbalanced backticks).
    return <Text>{source}</Text>
  }
  return <>{tokens.map((t, i) => renderBlock(t, `b-${i}`, cols))}</>
}
