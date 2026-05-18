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

export interface ListSchedulesQuery {
  agent?: string
}

export interface ListSchedulesResponse {
  schedules: Schedule[]
}

/* ============================================================
 * Outbox — delivery queue for IM platform replies. Each row
 * represents one outbound message; status moves
 * pending → delivered (or → giving_up on hard failure).
 * ============================================================ */

export type OutboxStatus = 'pending' | 'delivered' | 'giving_up'
export type OutboxKind = 'text' | 'card' | 'typing'
export type OutboxPriority = 'high' | 'normal'

export interface OutboxRow {
  id: number
  job_id: number | null
  thread_key: string
  platform: string
  channel_id: string
  thread_id: string
  payload: string
  kind: OutboxKind
  priority: OutboxPriority
  status: OutboxStatus
  attempts: number
  last_attempt_at: string | null
  last_error: string | null
  delivered_at: string | null
  next_attempt_at: string | null
  created_at: string
}

export interface ListOutboxQuery {
  status?: OutboxStatus
  thread?: string
  limit?: number
}

export interface ListOutboxResponse {
  rows: OutboxRow[]
}

export interface OutboxStats {
  pending: number
  delivered: number
  giving_up: number
  total: number
  /** Last successful delivery timestamp, or null when none. */
  lastDeliveredAt?: string | null
}

export interface OutboxRetryResponse extends OkResponse {
  id: number
}

/* ============================================================
 * Agent-to-Agent (A2A) — inline jobs spawned with parent_id set,
 * representing one agent invoking another. Read-only views over
 * jobs.db.
 * ============================================================ */

export interface A2AStats {
  total: number
  recent24h: number
  maxDepth: number
  byStatus: Array<{ status: string; n: number }>
  byAgent:  Array<{ agent: string; n: number }>
}

export interface A2ARow {
  id: number
  agent: string
  parent_id: number | null
  call_depth: number
  status: string
  /** First 200 chars of the prompt (server-side truncated). */
  prompt: string | null
  /** First 500 chars of the result (server-side truncated). */
  result: string | null
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  delivered_at: string | null
}

export interface ListA2ARecentQuery {
  limit?: number
}

export interface ListA2ARecentResponse {
  rows: A2ARow[]
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

/** Tracks an approval's lifecycle on the SSE channel.
 *  `requested` fires when one enqueues; `resolved` on disposition. */
export type ApprovalPhase = 'requested' | 'resolved'
export type ApprovalOutcome = 'allow' | 'deny' | 'timeout'

/** Pending approval as exposed by GET /api/approvals (approvalBus.
 *  listPending()). Field naming + types match the bus's snapshot
 *  contract — see src/core/approval-bus.ts. */
export interface Approval {
  reqId: string
  runId: string
  threadId: string
  platform: string
  toolName: string
  /** Raw tool input — passed verbatim from the agent. Render via
   *  JsonViewer or a truncated preview; do not interpret. */
  input: Record<string, unknown>
  fingerprint: string
  autoAllow: boolean
  /** Epoch ms when the bus accepted the request. */
  registeredAt: number
  /** Server-computed age at fetch time (ms). The UI shows
   *  `formatDuration(ageMs)` and refreshes via SSE + the next
   *  poll. */
  ageMs: number
}

export interface ApprovalMetrics {
  pending: number
  totalRequests: number
  totalResolved: number
  totalAllowed: number
  totalDenied: number
  totalTimedOut: number
  totalReadonlyAutoAllowed: number
}

export interface ListApprovalsResponse {
  pending: Approval[]
  metrics: ApprovalMetrics
}

export type ApprovalBehavior = 'allow' | 'deny'

/** POST body for /api/approvals/:reqId/resolve.
 *  - `allow`  with `autoAllowFurther: true` whitelists the agent
 *    on this thread for the same tool — caller's choice.
 *  - `deny`   accepts an optional `message` surfaced back to the
 *    agent as the denial reason. */
export interface ResolveApprovalBody {
  behavior: ApprovalBehavior
  autoAllowFurther?: boolean
  message?: string
}

export interface ResolveApprovalResponse extends OkResponse {
  resolved: boolean
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
