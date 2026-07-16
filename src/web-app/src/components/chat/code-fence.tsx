/**
 * CodeFence — fenced markdown code block with copy + syntax highlight.
 *
 * highlight.js is loaded on first mount (dynamic import) so the SPA
 * entry stays under the bundle budget; unhighlighted text renders
 * immediately as a fallback.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join('')
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return nodeToText(props?.children)
  }
  return ''
}

function langFromClass(className?: string): string | undefined {
  const m = /language-([A-Za-z0-9_+-]+)/.exec(className ?? '')
  return m?.[1]?.toLowerCase()
}

async function highlight(code: string, lang?: string): Promise<string | null> {
  try {
    const hljs = (await import('highlight.js/lib/core')).default
    const mods = await Promise.all([
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/typescript'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/shell'),
      import('highlight.js/lib/languages/python'),
      import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/sql'),
      import('highlight.js/lib/languages/plaintext'),
    ])
    const names = [
      'javascript', 'typescript', 'json', 'bash', 'shell', 'python',
      'xml', 'css', 'markdown', 'yaml', 'sql', 'plaintext',
    ] as const
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const mod = mods[i]
      if (name && mod && !hljs.getLanguage(name)) {
        hljs.registerLanguage(name, mod.default)
      }
    }
    // Aliases agents commonly emit
    if (!hljs.getLanguage('js')) hljs.registerLanguage('js', (await import('highlight.js/lib/languages/javascript')).default)
    if (!hljs.getLanguage('ts')) hljs.registerLanguage('ts', (await import('highlight.js/lib/languages/typescript')).default)
    if (!hljs.getLanguage('tsx')) hljs.registerLanguage('tsx', (await import('highlight.js/lib/languages/typescript')).default)
    if (!hljs.getLanguage('jsx')) hljs.registerLanguage('jsx', (await import('highlight.js/lib/languages/javascript')).default)
    if (!hljs.getLanguage('html')) hljs.registerLanguage('html', (await import('highlight.js/lib/languages/xml')).default)
    if (!hljs.getLanguage('sh')) hljs.registerLanguage('sh', (await import('highlight.js/lib/languages/bash')).default)
    if (!hljs.getLanguage('zsh')) hljs.registerLanguage('zsh', (await import('highlight.js/lib/languages/bash')).default)

    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    }
    return hljs.highlightAuto(code).value
  } catch {
    return null
  }
}

export function CodeFence({
  className,
  children,
}: {
  className?: string
  children?: ReactNode
}): JSX.Element {
  const raw = useMemo(() => nodeToText(children).replace(/\n$/, ''), [children])
  const lang = langFromClass(className)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const codeRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    void highlight(raw, lang).then((value) => {
      if (!cancelled) setHtml(value)
    })
    return () => { cancelled = true }
  }, [raw, lang])

  useEffect(() => {
    const el = codeRef.current
    if (!el) return
    // highlight.js emits escaped HTML for syntax tokens only (no raw user HTML).
    el.innerHTML = html ?? ''
  }, [html])

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="group/code relative my-2 overflow-hidden rounded-xl border border-border/70 bg-surface-2">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1">
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={() => void onCopy()}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-dim transition hover:bg-surface hover:text-text"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="agim-mono overflow-x-auto p-2.5 text-[12px] leading-relaxed">
        {html ? (
          <code ref={codeRef} className={cn('hljs', className)} />
        ) : (
          <code className={cn('agim-mono', className)}>{raw}</code>
        )}
      </pre>
    </div>
  )
}
