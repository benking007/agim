// agim TUI markdown renderer — token-walks `marked`'s AST and emits
// Ink <Text> nodes. Intentionally narrow:
//   * paragraphs / bold / italic / inline code / strikethrough
//   * code fence with language label + dim border + naive keyword
//     highlight (no cli-highlight dep; keeps the install lean)
//   * headings → bold + colored
//   * unordered + ordered lists (indent + bullet/number)
//   * blockquotes → dim "│ " prefix
//   * tables → fall back to markdown source (terminal table is fragile
//     under CJK width; keeping plain text is the lesser evil)
//   * links → render text + dim URL inline
//   * images / html → text fallback
//
// Returns a JSX fragment safe to drop inside any Ink <Box>.

import React from 'react'
import { Box, Text } from 'ink'
import { marked } from 'marked'

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
        out.push(<Text key={k}>{tok.text ?? ''}</Text>)
    }
  })
  return out
}

function renderBlock(tok: Token, key: string): React.ReactNode {
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
    case 'hr':
      return <Box key={key} marginBottom={1}><Text dimColor>{'─'.repeat(40)}</Text></Box>
    case 'space':
      return null
    default:
      // Tables / html / footnotes / etc. — fall back to raw text so
      // nothing is silently dropped.
      return (
        <Box key={key} marginBottom={1}>
          <Text dimColor>{(tok as Token).text ?? ''}</Text>
        </Box>
      )
  }
}

/** Render arbitrary markdown source as Ink components. */
export function Markdown({ source }: { source: string }): JSX.Element {
  // Empty body: just nothing.
  if (!source) return <Text />
  let tokens: Token[]
  try {
    tokens = marked.lexer(source) as Token[]
  } catch {
    // Fallback: render as plain text if the lexer chokes (e.g. partial
    // mid-stream content with unbalanced backticks).
    return <Text>{source}</Text>
  }
  return <>{tokens.map((t, i) => renderBlock(t, `b-${i}`))}</>
}
