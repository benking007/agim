/**
 * DeferredMarkdownView — parse GFM only when the bubble is near the
 * viewport (or explicitly eager, e.g. the in-flight streaming reply).
 *
 * A large HISTORY commit used to mount MarkdownView for every assistant
 * turn in one frame. remark-gfm on dozens of reports/tables is the
 * dominant first-paint cost; off-screen rows stay as truncated plaintext
 * until they scroll close. Huge visible replies upgrade on idle so the
 * first paint is not blocked on a 100k-character parse.
 */

import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'

const MarkdownView = lazy(async () => {
  const module = await import('@/components/chat/markdown-view')
  return { default: module.MarkdownView }
})

/** Near-viewport margin so scrolling up does not flash plaintext. */
const ROOT_MARGIN = '800px 0px'

/** Plaintext cap while waiting for the parser / intersection. */
const PLAIN_PREVIEW_CHARS = 2_400

/** Visible but huge replies: show plaintext first, parse on idle. */
const LARGE_MD_CHARS = 8_000

export interface DeferredMarkdownViewProps {
  content: string
  className?: string
  /** Streaming / in-viewport-critical — parse without waiting on IO. */
  eager?: boolean
  /** Scroll parent (Portal list). Viewport when omitted. */
  rootRef?: RefObject<HTMLElement | null>
}

function scheduleIdle(fn: () => void, timeout: number): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(() => fn(), { timeout })
    return () => w.cancelIdleCallback?.(id)
  }
  const t = window.setTimeout(fn, 0)
  return () => window.clearTimeout(t)
}

function PlainFallback({
  content,
  className,
}: {
  content: string
  className?: string
}): JSX.Element {
  const text = content.length > PLAIN_PREVIEW_CHARS
    ? `${content.slice(0, PLAIN_PREVIEW_CHARS)}…`
    : content
  return (
    <div
      data-testid="deferred-md-plain"
      className={cn('whitespace-pre-wrap break-words', className)}
    >
      {text}
    </div>
  )
}

export function DeferredMarkdownView({
  content,
  className,
  eager = false,
  rootRef,
}: DeferredMarkdownViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(eager)
  const [parsed, setParsed] = useState(eager && content.length < LARGE_MD_CHARS)

  useEffect(() => {
    if (eager) {
      setNear(true)
      return
    }
    const el = hostRef.current
    if (!el) {
      setNear(true)
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { root: rootRef?.current ?? null, rootMargin: ROOT_MARGIN, threshold: 0 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [eager, rootRef])

  useEffect(() => {
    if (!near || parsed) return
    if (content.length < LARGE_MD_CHARS) {
      setParsed(true)
      return
    }
    return scheduleIdle(() => setParsed(true), 600)
  }, [near, parsed, content.length])

  return (
    <div ref={hostRef}>
      {parsed ? (
        <Suspense fallback={<PlainFallback content={content} className={className} />}>
          <MarkdownView content={content} className={className} />
        </Suspense>
      ) : (
        <PlainFallback content={content} className={className} />
      )}
    </div>
  )
}
