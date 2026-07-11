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

import type React from 'react'
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

// Per-language comment/string syntax for the highlighter. Keyword lists are
// derived from KEYWORDS (above) so there's a single source of truth.
const LINE_COMMENT: Record<string, string> = { js: '//', ts: '//', go: '//', py: '#', sh: '#' }
const BLOCK_COMMENT_LANGS = new Set(['js', 'ts', 'go'])
const STRING_QUOTES: Record<string, string> = {
  js: '\'"`', ts: '\'"`', go: '"`', py: '\'"', sh: '\'"',
}

const KEYWORD_SET_CACHE: Record<string, Set<string> | undefined> = {}
function keywordSet(canon: string): Set<string> | undefined {
  if (canon in KEYWORD_SET_CACHE) return KEYWORD_SET_CACHE[canon]
  let set: Set<string> | undefined
  const re = KEYWORDS[canon]
  if (re) {
    const m = /\(([^)]*)\)/.exec(re.source)  // pull the alternation out of \b(a|b|c)\b
    if (m) set = new Set(m[1].split('|'))
  }
  KEYWORD_SET_CACHE[canon] = set
  return set
}

const NUM_RE = /(?:0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/y
const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c)
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)

// Single left-to-right scan so categories never overlap: a keyword inside a
// string/comment is not re-coloured (the string/comment is matched first and
// the cursor jumps past it). Best-effort, not a real parser — matches this
// file's "useful visual separation, not correctness" goal.
export function highlightCode(code: string, lang?: string): HighlightedSpan[] {
  const lc = lang?.toLowerCase()
  const canon = lc ? (LANG_ALIASES[lc] ?? lc) : undefined
  if (!canon) return [{ text: code }]
  const kw = keywordSet(canon)
  const line = LINE_COMMENT[canon]
  const block = BLOCK_COMMENT_LANGS.has(canon)
  const quotes = STRING_QUOTES[canon] ?? ''
  if (!kw && !line && !block && !quotes) return [{ text: code }]

  const spans: HighlightedSpan[] = []
  let plain = ''
  const flush = () => { if (plain) { spans.push({ text: plain }); plain = '' } }
  const push = (text: string, kind: HighlightedSpan['kind']) => { flush(); spans.push({ text, kind }) }
  const n = code.length
  let i = 0
  while (i < n) {
    const c = code[i]
    // line comment → to end of line
    if (line && code.startsWith(line, i)) {
      let j = code.indexOf('\n', i); if (j === -1) j = n
      push(code.slice(i, j), 'comment'); i = j; continue
    }
    // block comment → to closing */ (or EOF)
    if (block && c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const j = end === -1 ? n : end + 2
      push(code.slice(i, j), 'comment'); i = j; continue
    }
    // string → to matching unescaped quote (or EOF)
    if (quotes.includes(c)) {
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === c) { j++; break }
        j++
      }
      push(code.slice(i, Math.min(j, n)), 'string'); i = Math.min(j, n); continue
    }
    // identifier → keyword or plain (whole word, so `returns` ≠ `return`)
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentPart(code[j])) j++
      const word = code.slice(i, j)
      if (kw?.has(word)) push(word, 'keyword'); else plain += word
      i = j; continue
    }
    // number (identifiers were handled above, so this is a real literal)
    if (c >= '0' && c <= '9') {
      NUM_RE.lastIndex = i
      const m = NUM_RE.exec(code)
      if (m && m.index === i) { push(m[0], 'number'); i += m[0].length; continue }
    }
    plain += c; i++
  }
  flush()
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
      case 'image':
        out.push(
          <Text key={k}>
            <Text>{tok.text ?? ''}</Text>
            <Text dimColor> ({tok.href ?? ''})</Text>
          </Text>,
        )
        break
      default:
        out.push(<Text key={k}>{tok.text ?? tok.raw ?? ''}</Text>)
    }
  })
  return out
}

// Visible plain text of inline cell tokens — the exact characters
// renderInlineCell will draw (marked's cell `.text` keeps the raw markup, so
// it can't be used for width math). Mirror of renderInlineCell, used to
// compute column widths so styled cells stay aligned.
function collapseNl(s: string): string { return s.replace(/\s*\n\s*/g, ' ') }
export function inlineCellText(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  let s = ''
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong': case 'em': case 'del': case 'link':
        s += inlineCellText(tok.tokens); break
      case 'br': s += ' '; break
      default: s += collapseNl(tok.text ?? '')
    }
  }
  return s
}

// Width-preserving inline renderer for table cells. Mirrors renderInline but
// emits the SAME character content as inlineCellText() (no codespan
// backticks, no link " (url)" expansion) so column padding stays aligned.
export function renderInlineCell(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens) return []
  const out: React.ReactNode[] = []
  tokens.forEach((tok, i) => {
    const k = `${keyPrefix}-c${i}`
    const plain = (tok.text ?? '').replace(/\s*\n\s*/g, ' ')
    switch (tok.type) {
      case 'strong': out.push(<Text key={k} bold>{renderInlineCell(tok.tokens, k)}</Text>); break
      case 'em': out.push(<Text key={k} italic>{renderInlineCell(tok.tokens, k)}</Text>); break
      case 'del': out.push(<Text key={k} strikethrough>{renderInlineCell(tok.tokens, k)}</Text>); break
      case 'codespan': out.push(<Text key={k} color="cyan">{plain}</Text>); break
      case 'link': out.push(<Text key={k} underline>{renderInlineCell(tok.tokens, k)}</Text>); break
      case 'br': out.push(<Text key={k}>{' '}</Text>); break
      default: out.push(<Text key={k}>{plain}</Text>)
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

const cleanCell = (v: string | undefined): string => (v ?? '').replace(/\s*\n\s*/g, ' ').trim()

/** Decide table layout from cleaned cell text. Pure + exported for testing.
 *  'grid' when the columns fit availWidth, else 'list'. `colWidths` are the
 *  per-column display widths used for padding in grid mode. */
export function computeTableLayout(
  header: string[], rows: string[][], availWidth: number,
): { mode: 'grid' | 'list'; colWidths: number[] } {
  const cols = header.length
  const colWidths: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = displayWidth(header[c] ?? '')
    for (const r of rows) w = Math.max(w, displayWidth(r[c] ?? ''))
    colWidths.push(w)
  }
  const total = colWidths.reduce((a, b) => a + b, 0) + 3 * Math.max(0, cols - 1)
  return { mode: cols > 0 && total <= availWidth ? 'grid' : 'list', colWidths }
}

/** Format a GFM table into plain terminal lines. Kept as the pure/plain path
 *  (used by tests and as the basis for the list fallback). The interactive
 *  renderer (renderTable) layers inline styling on top via computeTableLayout. */
export function buildTableLines(
  header: string[], rows: string[][], align: CellAlign[], availWidth: number,
): { mode: 'grid' | 'list'; lines: string[] } {
  const cols = header.length
  const H = header.map(cleanCell)
  const R = rows.map((r) => Array.from({ length: cols }, (_, i) => cleanCell(r[i])))
  const al = (c: number): CellAlign => align[c] ?? 'left'
  const { mode, colWidths } = computeTableLayout(H, R, availWidth)

  if (mode === 'grid') {
    const fmtRow = (cells: string[]) => cells.map((cell, c) => padCell(cell, colWidths[c], al(c))).join(' │ ')
    const sep = colWidths.map((w) => '─'.repeat(w)).join('─┼─')
    return { mode, lines: [fmtRow(H), sep, ...R.map(fmtRow)] }
  }

  const lines: string[] = []
  R.forEach((r, ri) => {
    for (let c = 0; c < cols; c++) lines.push(`${H[c]}: ${r[c]}`)
    if (ri < R.length - 1) lines.push('')
  })
  return { mode, lines }
}

/** Pad parts (leading/trailing spaces) for a styled cell of known display
 *  width, honouring alignment. Lets us pad around JSX inline content. */
function padParts(textWidth: number, colWidth: number, align: CellAlign): { left: string; right: string } {
  const pad = Math.max(0, colWidth - textWidth)
  if (align === 'right') return { left: ' '.repeat(pad), right: '' }
  if (align === 'center') {
    const l = Math.floor(pad / 2)
    return { left: ' '.repeat(l), right: ' '.repeat(pad - l) }
  }
  return { left: '', right: ' '.repeat(pad) }
}

function renderTable(tok: Token, key: string, width: number): React.ReactNode {
  const t = tok as unknown as Tokens.Table
  const headerCells = t.header ?? []
  const rowCells = t.rows ?? []
  const cols = headerCells.length
  const align = (t.align ?? []) as CellAlign[]
  const al = (c: number): CellAlign => align[c] ?? 'left'
  // Visible text (what actually gets drawn) drives width math; marked's
  // cell.text keeps raw markup so it would over-pad styled cells.
  const visible = (c?: Tokens.TableCell): string =>
    c?.tokens?.length ? inlineCellText(c.tokens as Token[]) : cleanCell(c?.text)
  const headerText = headerCells.map(visible)
  const rowsText = rowCells.map((r) => Array.from({ length: cols }, (_, i) => visible(r[i])))
  const avail = Math.max(20, width - 2)  // account for the chat box paddingX
  const { mode, colWidths } = computeTableLayout(headerText, rowsText, avail)

  // A styled cell: inline content (width-preserving) padded to the column.
  const cell = (cc: Tokens.TableCell | undefined, c: number, kkey: string, header: boolean) => {
    const text = visible(cc)
    const { left, right } = padParts(displayWidth(text), colWidths[c], al(c))
    const inner = cc?.tokens?.length ? renderInlineCell(cc.tokens as Token[], kkey) : text
    return (
      <Text key={kkey}>
        {left}
        {header ? <Text bold color="cyan">{inner}</Text> : <Text>{inner}</Text>}
        {right}
      </Text>
    )
  }

  if (mode === 'grid') {
    const sep = colWidths.map((w) => '─'.repeat(w)).join('─┼─')
    const gridRow = (cells: Tokens.TableCell[], rk: string, header: boolean) => (
      <Text key={rk}>
        {Array.from({ length: cols }, (_, c) => {
          const node = cell(cells[c], c, `${rk}-c${c}`, header)
          // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no stable id; position is the key
          return c === 0 ? node : <Text key={`${rk}-s${c}`}><Text dimColor> │ </Text>{node}</Text>
        })}
      </Text>
    )
    return (
      <Box key={key} flexDirection="column" marginBottom={1}>
        {gridRow(headerCells, `${key}-h`, true)}
        <Text dimColor>{sep}</Text>
        {rowCells.map((r, ri) => gridRow(r, `${key}-r${ri}`, false))}
      </Box>
    )
  }

  // list fallback — "Header: value" records, styled value, nothing truncated.
  return (
    <Box key={key} flexDirection="column" marginBottom={1}>
      {rowCells.map((r, ri) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: table rows have no stable id; position is the key
        <Box key={`${key}-r${ri}`} flexDirection="column" marginBottom={ri < rowCells.length - 1 ? 1 : 0}>
          {Array.from({ length: cols }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no stable id; position is the key
            <Box key={`${key}-r${ri}-c${c}`}>
              <Text bold color="cyan">{headerText[c]}: </Text>
              <Text>{r[c]?.tokens?.length ? renderInlineCell(r[c].tokens as Token[], `${key}-r${ri}-c${c}`) : visible(r[c])}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

// Recursively render a list token. Handles:
//   * proper inline formatting of item text (bold/code/links — not the
//     literal `**`/`` ` `` the old flatten-to-text path produced)
//   * nested sub-lists (indented by depth)
//   * task checkboxes (`- [ ]` / `- [x]`)
//   * ordered-list `start` (e.g. a list beginning at "3.")
function renderList(tok: Token, key: string, width: number, depth: number): React.ReactNode {
  const ordered = !!(tok as Token & { ordered?: boolean }).ordered
  const startRaw = (tok as Token & { start?: number | string }).start
  const start = typeof startRaw === 'number' ? startRaw : 1
  const items = ((tok as Token & { items?: Token[] }).items ?? []) as Token[]
  const indent = '  '.repeat(depth)
  return (
    <Box key={key} flexDirection="column" marginBottom={depth === 0 ? 1 : 0}>
      {items.map((item, i) => {
        const it = item as Token & { task?: boolean; checked?: boolean; tokens?: Token[] }
        const marker = it.task
          ? (it.checked ? '☑ ' : '☐ ')
          : (ordered ? `${start + i}. ` : '• ')
        // Split item content: inline-ish leading content (text/paragraph)
        // renders on the marker line; block children (nested lists, code)
        // render beneath, indented one level deeper.
        const inlineNodes: React.ReactNode[] = []
        const childBlocks: Token[] = []
        for (const b of (it.tokens ?? [])) {
          const bt = b as Token
          if (bt.type === 'text' || bt.type === 'paragraph') {
            inlineNodes.push(...renderInline(bt.tokens, `${key}-${i}`))
          } else if (bt.type === 'checkbox') {
            // marker already encodes the checkbox state — skip
          } else {
            childBlocks.push(bt)
          }
        }
        return (
          <Box key={tokenKey(item, key)} flexDirection="column">
            <Box>
              <Text dimColor>{indent}{marker}</Text>
              <Text>{inlineNodes}</Text>
            </Box>
            {childBlocks.map((cb, ci) =>
              cb.type === 'list'
                ? renderList(cb, `${key}-${i}-${ci}`, width, depth + 1)
                : renderBlock(cb, `${key}-${i}-${ci}`, width))}
          </Box>
        )
      })}
    </Box>
  )
}

function renderBlock(tok: Token, key: string, width: number): React.ReactNode {
  switch (tok.type) {
    case 'heading': {
      const depth = Math.min((tok.depth ?? 1) - 1, HEADING_COLORS.length - 1)
      const prefix = `${'#'.repeat(tok.depth ?? 1)} `
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
      // Render inner blocks recursively (paragraphs, nested lists, code)
      // behind a dim "│ " gutter. Previously each inner token went through
      // renderInline, which showed literal markdown for non-paragraph
      // blocks and dropped nested lists entirely.
      return (
        <Box key={key} marginBottom={1} flexDirection="row">
          <Text dimColor>│ </Text>
          <Box flexDirection="column">
            {(tok.tokens ?? []).map((inner, i) =>
              (inner as Token).type === 'list'
                ? renderList(inner as Token, `${key}-${i}`, width, 0)
                : renderBlock(inner as Token, `${key}-${i}`, width))}
          </Box>
        </Box>
      )
    case 'list':
      return renderList(tok, key, width, 0)
    case 'table':
      return renderTable(tok, key, width)
    case 'hr':
      return <Box key={key} marginBottom={1}><Text dimColor>{'─'.repeat(40)}</Text></Box>
    case 'space':
      return null
    case 'def':
      // Link-reference definitions ([id]: https://…) are metadata, not
      // visible content — emit nothing (was dumping raw text).
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
