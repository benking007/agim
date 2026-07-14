/**
 * Lock document body scroll while a mobile overlay (sheet / modal) is open.
 * Restores previous overflow on close / unmount.
 */

import { useEffect } from 'react'

export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return
    const { body, documentElement } = document
    const prevBody = body.style.overflow
    const prevHtml = documentElement.style.overflow
    body.style.overflow = 'hidden'
    documentElement.style.overflow = 'hidden'
    return () => {
      body.style.overflow = prevBody
      documentElement.style.overflow = prevHtml
    }
  }, [locked])
}
