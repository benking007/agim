/**
 * MarkdownView — render assistant chat text as GitHub-flavoured markdown
 * inside the chat bubble (v1.2.116).
 *
 * Why a thin wrapper instead of @tailwindcss/typography:
 *   - The chat bubble has tight width / padding constraints; the prose
 *     defaults add their own margins that fight our flex layout.
 *   - We only need a handful of tags (headings ≤h3, tables, lists,
 *     code, links, strong/em). A per-tag className map is ~80 lines
 *     and stays inline with the bubble's design tokens.
 *
 * Why GFM:
 *   - Agent replies often include data tables (`| col | col |`) and
 *     occasional strikethrough / checkbox lists. Vanilla CommonMark
 *     doesn't render any of those.
 *
 * Streaming safety: react-markdown re-parses on each chunk. Partial
 * tokens (e.g. an unclosed `**`) render as literal text until the
 * closing marker arrives — no broken DOM, no warnings.
 *
 * XSS: react-markdown defaults to safe (no raw HTML). We do NOT add
 * rehype-raw; assistant output is untrusted from a web-security POV.
 */

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

export interface MarkdownViewProps {
  content: string
  /** Extra classes on the wrapper div. The chat bubble pads itself
   *  so we just match its text-size + leading. */
  className?: string
}

/** Per-tag class map. Most rules are conservative scale-downs of
 *  browser defaults so headings don't crowd a chat bubble; tables
 *  collapse borders + add a horizontal scroll for wide rows. */
const COMPONENTS: Components = {
  // Headings — chat is conversational, h1 would be absurd; scale all
  // down by one level visually.
  h1: ({ children, ...p }) => <h2 className="mt-2 mb-1 text-base font-semibold" {...p}>{children}</h2>,
  h2: ({ children, ...p }) => <h3 className="mt-2 mb-1 text-sm font-semibold" {...p}>{children}</h3>,
  h3: ({ children, ...p }) => <h4 className="mt-1.5 mb-1 text-sm font-semibold" {...p}>{children}</h4>,
  h4: ({ children, ...p }) => <h5 className="mt-1.5 mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted" {...p}>{children}</h5>,
  h5: ({ children, ...p }) => <h6 className="mt-1.5 mb-0.5 text-xs font-semibold text-text-muted" {...p}>{children}</h6>,
  h6: ({ children, ...p }) => <h6 className="mt-1.5 mb-0.5 text-xs font-medium text-text-muted" {...p}>{children}</h6>,
  // Body
  p: ({ children, ...p }) => <p className="my-1 leading-relaxed" {...p}>{children}</p>,
  strong: ({ children, ...p }) => <strong className="font-semibold text-text" {...p}>{children}</strong>,
  em: ({ children, ...p }) => <em className="italic" {...p}>{children}</em>,
  a: ({ children, ...p }) => (
    <a className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent" target="_blank" rel="noreferrer" {...p}>{children}</a>
  ),
  // Lists — tighter than browser default so bullets don't eat width.
  ul: ({ children, ...p }) => <ul className="my-1 ml-5 list-disc space-y-0.5" {...p}>{children}</ul>,
  ol: ({ children, ...p }) => <ol className="my-1 ml-5 list-decimal space-y-0.5" {...p}>{children}</ol>,
  li: ({ children, ...p }) => <li className="leading-relaxed" {...p}>{children}</li>,
  // Block quote — left bar, dim text. Common in agent reasoning summaries.
  blockquote: ({ children, ...p }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-text-dim" {...p}>{children}</blockquote>
  ),
  // Code — inline vs fenced. The wrapper <pre> sits inside a scrollable
  // block; <code> alone inside <p> is the inline variant.
  code: ({ inline, className, children, ...rest }: {
    inline?: boolean
    className?: string
    children?: React.ReactNode
  }) => {
    if (inline) {
      return (
        <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]" {...rest}>
          {children}
        </code>
      )
    }
    // Fenced — content lives inside the parent <pre>; keep this lean
    // so the <pre> styles do the heavy lifting.
    return <code className={cn('font-mono text-xs', className)} {...rest}>{children}</code>
  },
  pre: ({ children, ...p }) => (
    <pre className="my-2 overflow-x-auto rounded bg-surface-2 p-2 text-xs leading-relaxed" {...p}>{children}</pre>
  ),
  // Tables — agent data dumps. Compact, scroll on overflow.
  table: ({ children, ...p }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...p}>{children}</table>
    </div>
  ),
  thead: ({ children, ...p }) => <thead className="border-b border-border bg-surface-2/50" {...p}>{children}</thead>,
  tbody: ({ children, ...p }) => <tbody {...p}>{children}</tbody>,
  tr: ({ children, ...p }) => <tr className="border-b border-border/40 last:border-b-0" {...p}>{children}</tr>,
  th: ({ children, ...p }) => <th className="px-2 py-1 text-left font-semibold" {...p}>{children}</th>,
  td: ({ children, ...p }) => <td className="px-2 py-1 align-top" {...p}>{children}</td>,
  hr: (p) => <hr className="my-2 border-border" {...p} />,
}

export function MarkdownView({ content, className }: MarkdownViewProps): JSX.Element {
  return (
    <div className={cn('text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
