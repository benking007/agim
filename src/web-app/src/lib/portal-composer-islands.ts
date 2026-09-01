/**
 * Per-thread Portal composer state. The visible textarea is one DOM node,
 * but drafts / attachments / queued steers live in a Map keyed by web-*
 * thread id so switching sessions does not leak the previous input.
 */

import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useRef, useState } from 'react'

import type { PendingAttachment } from '@/components/m-portal/portal-composer-attachments'
import type { PendingSendItem } from '@/components/m-portal/portal-steer-queue'
import { isWebThreadId } from '@/lib/web-sessions'

export const MAX_COMPOSER_ISLANDS = 24

export interface ComposerIsland {
  input: string
  attachments: PendingAttachment[]
  pendingSends: PendingSendItem[]
}

export function emptyComposerIsland(): ComposerIsland {
  return { input: '', attachments: [], pendingSends: [] }
}

const islands = new Map<string, ComposerIsland>()
const lru: string[] = []

function touch(threadId: string): void {
  const i = lru.indexOf(threadId)
  if (i >= 0) lru.splice(i, 1)
  lru.unshift(threadId)
  while (lru.length > MAX_COMPOSER_ISLANDS) {
    const evict = lru.pop()
    if (evict && evict !== threadId) islands.delete(evict)
  }
}

export function getComposerIsland(threadId: string): ComposerIsland {
  const id = threadId.trim()
  if (!id || !isWebThreadId(id)) return emptyComposerIsland()
  const existing = islands.get(id)
  if (existing) {
    touch(id)
    return existing
  }
  const created = emptyComposerIsland()
  islands.set(id, created)
  touch(id)
  return created
}

export function patchComposerIsland(
  threadId: string,
  patch: Partial<ComposerIsland>,
): ComposerIsland {
  const id = threadId.trim()
  if (!id || !isWebThreadId(id)) return emptyComposerIsland()
  const next = { ...getComposerIsland(id), ...patch }
  islands.set(id, next)
  touch(id)
  return next
}

export function clearComposerIslands(): void {
  islands.clear()
  lru.length = 0
}

function applySet<T>(prev: T, update: SetStateAction<T>): T {
  return typeof update === 'function' ? (update as (p: T) => T)(prev) : update
}

export function useComposerIsland(threadId: string | null): {
  inputMessage: string
  setInputMessage: Dispatch<SetStateAction<string>>
  attachments: PendingAttachment[]
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>
  pendingSends: PendingSendItem[]
  setPendingSends: Dispatch<SetStateAction<PendingSendItem[]>>
} {
  const id = threadId && isWebThreadId(threadId) ? threadId : ''
  const [, bump] = useState(0)
  const idRef = useRef(id)
  idRef.current = id
  const row = id ? getComposerIsland(id) : emptyComposerIsland()

  const setInputMessage = useCallback((update: SetStateAction<string>) => {
    const tid = idRef.current
    if (!tid) return
    const cur = getComposerIsland(tid)
    patchComposerIsland(tid, { input: applySet(cur.input, update) })
    bump((n) => n + 1)
  }, [])

  const setAttachments = useCallback((update: SetStateAction<PendingAttachment[]>) => {
    const tid = idRef.current
    if (!tid) return
    const cur = getComposerIsland(tid)
    patchComposerIsland(tid, { attachments: applySet(cur.attachments, update) })
    bump((n) => n + 1)
  }, [])

  const setPendingSends = useCallback((update: SetStateAction<PendingSendItem[]>) => {
    const tid = idRef.current
    if (!tid) return
    const cur = getComposerIsland(tid)
    patchComposerIsland(tid, { pendingSends: applySet(cur.pendingSends, update) })
    bump((n) => n + 1)
  }, [])

  return {
    inputMessage: row.input,
    setInputMessage,
    attachments: row.attachments,
    setAttachments,
    pendingSends: row.pendingSends,
    setPendingSends,
  }
}
