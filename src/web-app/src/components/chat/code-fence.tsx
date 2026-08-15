/**
 * CodeFence — fenced markdown code block with copy + syntax highlight.
 *
 * highlight.js is loaded once (module promise) so the SPA entry stays
 * under the bundle budget; unhighlighted text renders immediately.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
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

type HljsLike = {
  getLanguage: (name: string) => unknown
  registerLanguage: (name: string, def: unknown) => void
  highlight: (code: string, opts: { language: string; ignoreIllegals: boolean }) => { value: string }
  highlightAuto: (code: string) => { value: string }
}

let hljsReady: Promise<HljsLike> | null = null

async function loadHljs(): Promise<HljsLike> {
  if (hljsReady) return hljsReady
  hljsReady = (async () => {
    const hljs = (await import('highlight.js/lib/core')).default as HljsLike
    const specs: Array<[string, () => Promise<{ default: unknown }>]> = [
      ['javascript', () => import('highlight.js/lib/languages/javascript')],
      ['typescript', () => import('highlight.js/lib/languages/typescript')],
      ['json', () => import('highlight.js/lib/languages/json')],
      ['bash', () => import('highlight.js/lib/languages/bash')],
      ['shell', () => import('highlight.js/lib/languages/shell')],
      ['python', () => import('highlight.js/lib/languages/python')],
      ['xml', () => import('highlight.js/lib/languages/xml')],
      ['css', () => import('highlight.js/lib/languages/css')],
      ['markdown', () => import('highlight.js/lib/languages/markdown')],
      ['yaml', () => import('highlight.js/lib/languages/yaml')],
      ['sql', () => import('highlight.js/lib/languages/sql')],
      ['go', () => import('highlight.js/lib/languages/go')],
      ['rust', () => import('highlight.js/lib/languages/rust')],
      ['java', () => import('highlight.js/lib/languages/java')],
      ['c', () => import('highlight.js/lib/languages/c')],
      ['cpp', () => import('highlight.js/lib/languages/cpp')],
      ['csharp', () => import('highlight.js/lib/languages/csharp')],
      ['ruby', () => import('highlight.js/lib/languages/ruby')],
      ['php', () => import('highlight.js/lib/languages/php')],
      ['kotlin', () => import('highlight.js/lib/languages/kotlin')],
      ['swift', () => import('highlight.js/lib/languages/swift')],
      ['diff', () => import('highlight.js/lib/languages/diff')],
      ['dockerfile', () => import('highlight.js/lib/languages/dockerfile')],
      ['ini', () => import('highlight.js/lib/languages/ini')],
      ['plaintext', () => import('highlight.js/lib/languages/plaintext')],
    ]
    await Promise.all(specs.map(async ([name, load]) => {
      if (hljs.getLanguage(name)) return
      const mod = await load()
      hljs.registerLanguage(name, mod.default)
    }))
    return hljs
  })()
  return hljsReady
}

const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  py: 'python',
  rb: 'ruby',
  cs: 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  golang: 'go',
  yml: 'yaml',
  md: 'markdown',
  docker: 'dockerfile',
  text: 'plaintext',
  txt: 'plaintext',
}

function resolveLang(lang?: string): string | undefined {
  if (!lang) return undefined
  return LANG_ALIASES[lang] ?? lang
}

async function highlight(code: string, lang?: string): Promise<string | null> {
  try {
    const hljs = await loadHljs()
    const resolved = resolveLang(lang)
    if (resolved && hljs.getLanguage(resolved)) {
      return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
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
  const { t } = useTranslation()
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
    if (!el || html == null) return
    // highlight.js emits escaped HTML for syntax tokens only (no raw user HTML).
    el.innerHTML = html
  }, [html])

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('chat.copyFailed'))
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
          aria-label={t('chat.copy')}
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          {copied ? t('chat.copied') : t('chat.copy')}
        </button>
      </div>
      <pre className="agim-mono overflow-x-auto p-2.5 text-[12px] leading-relaxed">
        {html ? (
          <code ref={codeRef} className={cn('hljs agim-mono block', className)} />
        ) : (
          <code className={cn('agim-mono block', className)}>{raw}</code>
        )}
      </pre>
    </div>
  )
}
