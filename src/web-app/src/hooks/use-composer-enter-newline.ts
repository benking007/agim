/**
 * “Enter inserts newline” for chat composers.
 * Identity is shell/browser (see `lib/composer-enter.ts`) — not viewport width.
 */

import { useState } from 'react'
import { prefersComposerEnterNewline } from '@/lib/composer-enter'

export function useComposerEnterNewline(): boolean {
  // Platform is fixed for the page lifetime (shell inject / UA).
  const [enterNewline] = useState(() => prefersComposerEnterNewline())
  return enterNewline
}
