/**
 * api.ts — manually maintained DTOs that the generated endpoints.ts
 * imports. The goal of this file is to give the SPA real types for
 * the responses it actually consumes; routes that aren't wired in
 * yet stay typed as `unknown` and get tightened as their consuming
 * page lands.
 *
 * Convention: one interface per resource. Types kept narrow on
 * purpose — the backend sometimes returns extra fields (Postel's
 * law); we surface only the ones the SPA cares about, and a
 * future tightening pass with zod (PR-4) will reject anything that
 * drops a known field.
 */

/* ============================================================
 * Common shapes
 * ============================================================ */

export interface OkResponse {
  ok: true
}

export interface ApiError {
  /** Machine-readable code; future server-side migration to enum.
   *  For now legacy backend returns free-form `error` strings —
   *  `lib/api/client.ts` maps known shapes to codes for i18n. */
  code: string
  /** Human-readable fallback (often Chinese in current backend). */
  message: string
  /** HTTP status the server returned. */
  status: number
}

export interface PageQuery {
  limit?: number
  offset?: number
}

/* ============================================================
 * Jobs (tasks) — the largest single domain
 * ============================================================ */

export type JobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'replaced'
  | 'abandoned'

export type JobKind = 'job' | 'inline'

export interface Job {
  id: number
  kind: JobKind
  agent: string
  prompt: string
  status: JobStatus
  result?: string
  error?: string
  parent_id?: number
  call_depth?: number
  created_at: string
  started_at?: string
  completed_at?: string
  duration_ms?: number
  cost?: number
  trace_id?: string
}

export interface ListJobsQuery extends PageQuery {
  status?: JobStatus
  agent?: string
  kind?: JobKind
}

export interface ListJobsResponse {
  jobs: Job[]
  stats?: {
    pending: number
    running: number
    completed: number
    failed: number
    delivered?: number
  }
}

export interface CreateJobBody {
  agent: string
  prompt: string
}

export interface CreateJobResponse extends OkResponse {
  id: number
}

export interface BatchJobBody {
  ids: number[]
}

/* ============================================================
 * Subtasks — flattened view of session.subtasks across all
 * conversations. Read-only.
 * ============================================================ */

export type SubtaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Subtask {
  id: number
  agent: string
  prompt: string
  status: SubtaskStatus
  result?: string
  /** ISO timestamp (Date on the backend; JSON wire format is string). */
  createdAt: string
  completedAt?: string
  /** Parent session context. Useful to navigate back to chat history. */
  platform: string
  channelId: string
  threadId: string
  parentAgent: string
  parentSessionId: string
}

export interface ListSubtasksQuery {
  agent?: string
}

export interface ListSubtasksResponse {
  subtasks: Subtask[]
}

/* ============================================================
 * Background jobs — read-only proxy onto Claude Code / opencode /
 * codex bgjob directories. Defined by src/core/bgjob-reader.ts.
 * ============================================================ */

export interface BgjobRoot {
  /** Stable id — 'claude' / 'opencode' / 'codex' / custom-basename. */
  id: string
  label: string
  path: string
}

export interface BgjobSummary {
  id: string
  name: string
  /** Free-form: running / completed / failed / killed / stale / … */
  status: string
  pid: number | null
  started_at: string | null
  ended_at: string | null
  exit_code: number | null
  restart_generation: number
  rootId: string
}

export interface ListBgjobsQuery {
  /** Filter to a single root id; omit for all roots. */
  root?: string
}

/** Response shape varies based on whether `root` is set:
 *  - With root  : { roots: [oneRoot], jobs: BgjobSummary[] }
 *  - Without    : { roots: [...], groups: [{ rootId, jobs[] }] }
 *  We accept both via optional fields. */
export interface ListBgjobsResponse {
  roots: BgjobRoot[]
  jobs?: BgjobSummary[]
  groups?: Array<{ rootId: string; jobs: BgjobSummary[] }>
}

/* ============================================================
 * Schedules
 * ============================================================ */

export interface Schedule {
  id: number
  name: string
  agent: string
  prompt: string
  cron: string
  enabled: boolean
  next_run: string
  last_run?: string
  notify_url?: string
}

export interface ListSchedulesResponse {
  schedules: Schedule[]
}

/* ============================================================
 * Reminders
 * ============================================================ */

export type ReminderStatus = 'pending' | 'firing' | 'fired' | 'cancelled' | 'failed'

export interface Reminder {
  id: string
  platform: string
  channel_id: string
  thread_id: string
  user_id: string
  text: string
  fire_at: string
  status: ReminderStatus
  recurrence?: string
  recurrence_label?: string
  fired_at?: string
  error?: string
}

export interface ListRemindersQuery extends PageQuery {
  status?: ReminderStatus
}

export interface ListRemindersResponse {
  reminders: Reminder[]
}

export interface SnoozeReminderBody {
  duration: string
}

export interface SnoozeReminderResponse extends OkResponse {
  originalId: string
  newId: string
  duration: string
}

/* ============================================================
 * Memos
 * ============================================================ */

export interface Memo {
  id: string
  platform: string
  userId: string
  what: string
  who?: string
  when_text?: string
  where_label?: string
  why?: string
  where_lat?: number
  where_lng?: number
  mapUrls?: Record<string, string>
  expires_at?: string
  created_at: string
}

export interface ListMemosQuery extends PageQuery {
  query?: string
  who?: string
  what?: string
  has_location?: boolean
}

export interface ListMemosResponse {
  memos: Memo[]
}

/* ============================================================
 * Approvals
 * ============================================================ */

export type ApprovalPhase = 'requested' | 'resolved'
export type ApprovalOutcome = 'allow' | 'deny' | 'timeout'

export interface Approval {
  reqId: string
  toolName: string
  phase: ApprovalPhase
  outcome?: ApprovalOutcome
  threadId: string
  platform: string
  channelId: string
  userId?: string
  input?: unknown
  registeredAt: number
  ageMs?: number
}

export interface ListApprovalsResponse {
  approvals: Approval[]
}

export interface ResolveApprovalBody {
  outcome: 'allow' | 'deny'
}

/* ============================================================
 * Memory
 * ============================================================ */

export type FactCategory = 'fact' | 'preference' | 'goal' | 'history' | 'profile'

export interface Fact {
  id: number
  user_key: string
  what: string
  who?: string
  when_text?: string
  where_label?: string
  why?: string
  category: FactCategory
  confidence: number
  source: string
  created_at: number
  embedded_at?: number
}

export interface ListMemoryFactsQuery {
  user_key: string
  query?: string
  category?: FactCategory
  limit?: number
  offset?: number
}

export interface ListMemoryFactsResponse {
  facts: Fact[]
  total?: number
}

export interface Persona {
  user_key: string
  summary: string
  updated_at: number
}

export interface UpdatePersonaBody {
  persona: string
}

export interface VectorStatus {
  backend: 'off' | 'local' | 'openai'
  ready: boolean
  modelId?: string
  itemCount?: number
  lastSync?: string
}

/* ============================================================
 * Auth
 * ============================================================ */

export interface LoginBody {
  token: string
}

export interface LoginResponse extends OkResponse {
  tokenId: string
}

/* ============================================================
 * Config (read-only DTO; settings page narrows it later)
 * ============================================================ */

export interface AppConfig {
  messengers: string[]
  agents: string[]
  defaultAgent: string
  webPort?: number
  acpPort?: number
  telegram?: { botToken?: string; channelId?: string }
  feishu?: { appId?: string; appSecret?: string; channelId?: string }
  dingtalk?: { clientId?: string; clientSecret?: string; channelId?: string }
  discord?: { botToken?: string; channelId?: string }
  acpAgents?: Array<{
    name: string
    aliases?: string[]
    endpoint: string
    enabled?: boolean
  }>
  agentStatus?: Record<string, boolean>
  /** Open-ended for forward-compat. */
  [key: string]: unknown
}

/* ============================================================
 * Health / Observability
 * ============================================================ */

export interface HealthSummary {
  uptimeSec: number
  agents: Record<string, boolean>
  totalsByDay?: Array<{ date: string; calls: number; cost: number; errors: number; avgLatencyMs: number }>
  kpis?: {
    totalCalls: number
    totalCost: number
    errorRate: number
    avgLatencyMs: number
  }
}

export interface TopNRow {
  rank: number
  name: string
  value: number
}

export interface TopNResponse {
  topN: TopNRow[]
}
