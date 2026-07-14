/**
 * Blur the chat composer when the user taps empty list chrome or
 * scrolls the thread — matches iOS Messages keyboard dismiss.
 */

import { useEffect, type PointerEvent, type RefObject } from 'react'

const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [role="textbox"], [contenteditable="true"]'

export function blurComposerOnListInteract(
  e: PointerEvent<HTMLElement>,
  inputRef: RefObject<HTMLElement | null>,
): void {
  const target = e.target as HTMLElement | null
  if (!target) return
  if (target.closest(INTERACTIVE)) return
  inputRef.current?.blur()
}

/** Blur on user scroll only (ignore programmatic scrollTo during streaming). */
export function useBlurComposerOnUserScroll(
  listRef: RefObject<HTMLElement | null>,
  inputRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const el = listRef.current
    if (!el) return

    let touching = false
    const onTouchStart = (): void => { touching = true }
    const onTouchEnd = (): void => { touching = false }
    const onWheel = (): void => {
      if (document.activeElement === inputRef.current) inputRef.current?.blur()
    }
    const onScroll = (): void => {
      if (!touching) return
      if (document.activeElement === inputRef.current) inputRef.current?.blur()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', onScroll)
    }
  }, [listRef, inputRef])
}
