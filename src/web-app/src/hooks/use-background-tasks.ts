/**
 * use-background-tasks — react-query hooks for the P1 follow-up
 * admin panels (heartbeat / asks).
 *
 * All three sit under the same `/tasks/*` SPA group + share polling
 * intervals because operators tend to flip between them. Each list
 * polls every 10s while foreground so live activity (a new ask
 * landing, a heartbeat tick completing) shows up without a manual
 * refresh.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/api/client'

// ─── Heartbeat ──────────────────────────────────────────────────

export interface HeartbeatRow {
  platform: string
  channelId: string
  threadId: string
  userId: string
  body: string
  intervalMinutes: number
  enabled: boolean
  lastTickAt: string | null
  lastStatus: string
  lastReason: string
  lastTextPreview: string
  createdAt: string
}

export interface HeartbeatListResponse {
  bindings: HeartbeatRow[]
  count: number
}

const hbKeys = {
  all:  ['heartbeat'] as const,
  list: ['heartbeat', 'list'] as const,
}

function bindingKey(r: { platform: string; channelId: string; threadId: string }): string {
  return `${r.platform}:${r.channelId}:${r.threadId}`
}

export function useHeartbeatList() {
  return useQuery<HeartbeatListResponse>({
    queryKey: hbKeys.list,
    queryFn: () => client.get<HeartbeatListResponse>('/api/heartbeat/bindings'),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
}

export function useHeartbeatToggle() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { row: HeartbeatRow; op: 'enable' | 'disable' }>({
    mutationFn: ({ row, op }) => client.post(
      `/api/heartbeat/bindings/${encodeURIComponent(bindingKey(row))}/${op}`,
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: hbKeys.all }),
  })
}

// ─── Pending asks ───────────────────────────────────────────────

export interface PendingAskRow {
  reqId: string
  platform: string
  threadId: string
  question: string
  choices: number
  ageMs: number
}

export interface AsksListResponse {
  pending: PendingAskRow[]
  count: number
  /** Full AskDock payloads (reconnect / half-open WS catch-up). */
  cards?: import('@/lib/pending-ask-cards').PendingAskCardWire[]
}

const askKeys = {
  all:  ['asks'] as const,
  list: ['asks', 'list'] as const,
}

export function useAsksList() {
  return useQuery<AsksListResponse>({
    queryKey: askKeys.list,
    queryFn: () => client.get<AsksListResponse>('/api/asks/pending'),
    refetchInterval: 5_000,  // asks are short-lived; poll faster
  })
}

export function useAskCancel() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, string>({
    mutationFn: (reqId) => client.post(`/api/asks/pending/${encodeURIComponent(reqId)}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: askKeys.all }),
  })
}

// ─── Plan history (v1.2.133) ────────────────────────────────────

export type PlanOutcome = 'approved' | 'rejected' | 'edited' | 'expired'

export interface PlanHistoryRow {
  id: number
  threadKey: string
  planMd: string
  outcome: PlanOutcome
  detail: string | null
  resolvedAt: string
  pendingMs: number | null
}

export interface PlansListResponse {
  plans: PlanHistoryRow[]
  total: number
}

const planKeys = {
  all:  ['plans'] as const,
  list: (threadKey?: string, limit?: number) =>
    ['plans', 'list', threadKey ?? null, limit ?? null] as const,
}

/** GET /api/plans — admin list of native_exit_plan_mode handshakes
 *  with outcome + pending duration + the plan markdown. Filters on
 *  thread_key (optional) and limit (clamped 1..500 server-side). */
export function usePlansList(opts: { threadKey?: string; limit?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.threadKey) params.set('thread_key', opts.threadKey)
  if (opts.limit != null) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return useQuery<PlansListResponse>({
    queryKey: planKeys.list(opts.threadKey, opts.limit),
    queryFn: () => client.get<PlansListResponse>(`/api/plans${qs ? `?${qs}` : ''}`),
  })
}
