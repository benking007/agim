/**
 * Reactive “Enter inserts newline” preference for chat composers.
 * See `lib/composer-enter.ts` for the desktop vs phone rules.
 */

import { useEffect, useState } from 'react'
import {
  COMPOSER_COARSE_POINTER_MQ,
  COMPOSER_PHONE_MQ,
  prefersComposerEnterNewline,
} from '@/lib/composer-enter'

export function useComposerEnterNewline(): boolean {
  const [enterNewline, setEnterNewline] = useState(() => prefersComposerEnterNewline())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const update = (): void => setEnterNewline(prefersComposerEnterNewline())
    update()
    const mqs: MediaQueryList[] = []
    if (window.matchMedia) {
      try {
        mqs.push(window.matchMedia(COMPOSER_PHONE_MQ))
        mqs.push(window.matchMedia(COMPOSER_COARSE_POINTER_MQ))
      } catch { /* ignore */ }
    }
    for (const mq of mqs) mq.addEventListener('change', update)
    window.addEventListener('resize', update)
    return () => {
      for (const mq of mqs) mq.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return enterNewline
}
