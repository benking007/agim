/**
 * use-background-tasks — react-query hooks for the P1 follow-up
 * admin panels (heartbeat / goals / asks).
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

// ─── Goals ──────────────────────────────────────────────────────

export interface GoalRow {
  id: number
  platform: string
  channelId: string
  threadId: string
  userId: string
  title: string
  body: string
  status: 'active' | 'paused' | 'completed' | 'cancelled'
  progressLog: Array<{ ts: string; by: string; text: string }>
  progressCount: number
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface GoalsListResponse {
  goals: GoalRow[]
  count: number
  scope: 'all-active' | 'thread'
}

const goalKeys = {
  all:  ['goals'] as const,
  list: ['goals', 'list'] as const,
}

export function useGoalsList() {
  return useQuery<GoalsListResponse>({
    queryKey: goalKeys.list,
    queryFn: () => client.get<GoalsListResponse>('/api/goals'),
    refetchInterval: 30_000,
  })
}

export function useGoalUpdateStatus() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: number; status: GoalRow['status'] }>({
    mutationFn: ({ id, status }) => client.put(
      `/api/goals/${id}/status`, { body: { status } },
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: goalKeys.all }),
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
