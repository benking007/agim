/**
 * use-loops — Tasks audit hooks for Loop Engineering history.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getLoopById,
  listLoops,
  type LoopAuditDto,
  type LoopListItemDto,
} from '@/lib/api/loop'

const keys = {
  all: ['loops'] as const,
  list: (q: Record<string, unknown>) => ['loops', 'list', q] as const,
  detail: (id: string) => ['loops', 'detail', id] as const,
}

export function useLoopsList(opts: {
  status?: string
  threadId?: string
  sessionKey?: string
  limit?: number
  lang?: 'zh' | 'en'
} = {}) {
  const query = {
    status: opts.status,
    threadId: opts.threadId,
    sessionKey: opts.sessionKey,
    limit: opts.limit ?? 100,
    lang: opts.lang,
  }
  return useQuery<{ ok: boolean; count: number; loops: LoopListItemDto[] }>({
    queryKey: keys.list(query),
    queryFn: () => listLoops(query),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
}

export function useLoopDetail(id: string | null, lang: 'zh' | 'en' = 'zh') {
  return useQuery<{ ok: boolean; loop: LoopAuditDto }>({
    queryKey: keys.detail(id || ''),
    queryFn: () => getLoopById(id!, { lang }),
    enabled: !!id,
  })
}

export function useInvalidateLoops() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: keys.all })
}
