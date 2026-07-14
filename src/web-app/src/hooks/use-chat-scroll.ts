/**
 * Keep a chat thread pinned to the latest messages when the soft
 * keyboard opens (visualViewport inset grows) or new content arrives
 * while the user is already near the bottom.
 */

import { useEffect, type RefObject } from 'react'

function scrollToEnd(el: HTMLElement, smooth: boolean): void {
  const top = el.scrollHeight
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
  } else {
    el.scrollTop = top
  }
}

export function useChatKeyboardAnchor(opts: {
  listRef: RefObject<HTMLElement | null>
  inputRef: RefObject<HTMLElement | null>
  keyboardInset: number
}): void {
  const { listRef, inputRef, keyboardInset } = opts

  useEffect(() => {
    if (keyboardInset <= 0) return
    const el = listRef.current
    if (!el) return
    const focused = document.activeElement === inputRef.current
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    if (!focused && dist > 240) return
    requestAnimationFrame(() => scrollToEnd(el, false))
  }, [keyboardInset, listRef, inputRef])
}

/** Scroll to bottom when new messages / streaming chunks arrive (near-bottom only). */
export function useChatFollowBottom(opts: {
  listRef: RefObject<HTMLElement | null>
  messageCount: number
  latestMessageContent: string
  streaming: boolean
}): void {
  const { listRef, messageCount, latestMessageContent, streaming } = opts

  useEffect(() => {
    if (messageCount === 0 && !latestMessageContent && !streaming) return
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (!nearBottom && !streaming) return
    requestAnimationFrame(() => scrollToEnd(el, streaming))
  }, [latestMessageContent, messageCount, streaming, listRef])
}
