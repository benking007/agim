/**
 * Keep a chat thread pinned to the latest messages when the soft
 * keyboard opens (visualViewport inset grows) or new content arrives
 * while the user is already following the bottom.
 *
 * While the user is reading older history (scrolled up), streaming /
 * tool-activity updates must NOT yank the viewport back to the end.
 */

import { useEffect, useRef, type RefObject } from 'react'

/** Distance from the bottom that still counts as "following". */
export const CHAT_NEAR_BOTTOM_PX = 200

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

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
    const dist = distanceFromBottom(el)
    if (!focused && dist > 240) return
    requestAnimationFrame(() => scrollToEnd(el, false))
  }, [keyboardInset, listRef, inputRef])
}

export interface ChatFollowBottomApi {
  /** Re-enable follow and jump to the end (call when the user sends). */
  stickToBottom: () => void
}

/**
 * Scroll to bottom when new messages / streaming chunks / activity arrive,
 * but only while the user is still following the bottom. Scrolling up to
 * read history pauses follow until they return near the end (or send).
 */
export function useChatFollowBottom(opts: {
  listRef: RefObject<HTMLElement | null>
  messageCount: number
  latestMessageContent: string
  streaming: boolean
  /** Extra signal (e.g. activity step count) that should retry follow. */
  followSignal?: unknown
}): ChatFollowBottomApi {
  const { listRef, messageCount, latestMessageContent, streaming, followSignal } = opts
  const followingRef = useRef(true)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const syncFollow = (): void => {
      followingRef.current = distanceFromBottom(el) < CHAT_NEAR_BOTTOM_PX
    }
    syncFollow()
    el.addEventListener('scroll', syncFollow, { passive: true })
    return () => el.removeEventListener('scroll', syncFollow)
  }, [listRef])

  const stickToBottom = (): void => {
    followingRef.current = true
    const el = listRef.current
    if (!el) return
    requestAnimationFrame(() => scrollToEnd(el, false))
  }

  useEffect(() => {
    // followSignal is intentionally a dep-only trigger (e.g. activity steps).
    void followSignal
    if (messageCount === 0 && !latestMessageContent && !streaming) return
    if (!followingRef.current) return
    const el = listRef.current
    if (!el) return
    requestAnimationFrame(() => scrollToEnd(el, streaming))
  }, [latestMessageContent, messageCount, streaming, followSignal, listRef])

  return { stickToBottom }
}
