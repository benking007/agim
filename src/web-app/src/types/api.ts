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

/** Source of the reminder — how it was created. */
export type ReminderSource = 'slash' | 'mcp' | 'api'

/** 'llm'   — at fire time, treat `text` as a prompt and ask the active
 *            agent to compose the actual delivery.
 *  'literal' — deliver `text` as-is. */
export type ReminderPromptMode = 'llm' | 'literal'

export interface Reminder {
  id: number
  fire_at: string
  text: string
  platform: string
  channel_id: string
  thread_id: string
  user_id: string
  status: ReminderStatus
  created_at: string
  fired_at: string | null
  error: string | null
  source: ReminderSource
  parent_id: number | null
  recurrence: string | null
  last_fired_at: string | null
  prompt_mode: ReminderPromptMode
  /** Server-rendered "every Monday at 9am" style label.
   *  Null when the reminder isn't recurring. */
  recurrence_label?: string | null
}

export interface ListRemindersQuery extends PageQuery {
  status?: ReminderStatus
}

export interface ListRemindersResponse {
  reminders: Reminder[]
}

export interface CancelReminderResponse extends OkResponse {
  id: number
}

export interface SnoozeReminderBody {
  /** Duration string the backend parses ("5m", "30m", "1h",
   *  "tomorrow", ...). The page surfaces a fixed set; the field is
   *  free-form to honor the backend's parseDuration() contract. */
  duration: string
}

export interface SnoozeReminderResponse extends OkResponse {
  originalId: number
  newId: number
  duration: string
}

/* ============================================================
 * Memos
 * ============================================================ */

/** Field naming reflects the WIRE format produced by handleListMemos
 *  in src/web/server.ts (snake_case in the DB, camelCase on the API
 *  for timestamps + ids, but where_* stays snake_case to match the
 *  location bundle the IM-side picker speaks). */
export interface Memo {
  id: number
  platform: string
  userId: string
  what: string
  who: string | null
  whenAt: string | null
  whenText: string | null
  where_lat: number | null
  where_lng: number | null
  where_label: string | null
  how: string | null
  why: string | null
  memo: string | null
  source: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string | null
  /** Present only when both where_lat AND where_lng are non-null.
   *  Provider → URL map (Baidu / Apple / Google / OSM). */
  mapUrls?: Record<string, string>
}

export interface ListMemosQuery extends PageQuery {
  query?: string
  who?: string
  what?: string
  has_location?: boolean
  include_expired?: boolean
}

export interface ListMemosResponse {
  memos: Memo[]
}

export interface DeleteMemoResponse extends OkResponse {
  id: number
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

/** Mirror of src/core/memory.ts:Fact — every field is required on the
 *  wire (the backend stores empty strings, not null, for the
 *  optional-feeling text columns). Timestamps are epoch-ms numbers,
 *  not ISO strings. */
export interface Fact {
  id: number
  user_key: string
  what: string
  who: string
  when_text: string
  where_label: string
  why: string
  category: FactCategory
  confidence: number
  last_referenced_at: number
  source: string
  created_at: number
}

export interface ListMemoryFactsQuery {
  user_key: string
  query?: string
  category?: FactCategory
  limit?: number
  offset?: number
}

/** Mirrors core/memory.ts:FactPage. The backend always returns
 *  `total + limit + offset + facts` (it's a paginated view, not a
 *  flat list). */
export interface ListMemoryFactsResponse {
  total: number
  limit: number
  offset: number
  facts: Fact[]
}

/** Body of DELETE /api/memory/facts — bulk-delete with optional
 *  filters. At least one of `ids` / `category` / `max_confidence`
 *  must be set, OR `confirm_clear: true` for a wipe. The backend
 *  enforces this; the DTO mirrors what it accepts. */
export interface DeleteMemoryFactsBody {
  ids?: number[]
  category?: FactCategory
  /** Drop facts whose confidence is at or below this threshold. */
  max_confidence?: number
  /** Required `true` for a wipe-everything semantic; ignored otherwise. */
  confirm_clear?: boolean
}

export interface DeleteMemoryFactsResponse {
  deleted: number
}

/** Per-user summary returned by GET /api/memory/users. Mirrors
 *  core/memory.ts:UserSummary. */
export interface MemoryUserSummary {
  user_key: string
  fact_count: number
  oldest_fact_at: number | null
  newest_fact_at: number | null
  has_persona: boolean
  persona_updated_at: number | null
}

export interface ListMemoryUsersResponse {
  users: MemoryUserSummary[]
}

export interface Persona {
  user_key: string
  summary: string
  /** Epoch ms. */
  updated_at: number
}

/** POST /api/memory/persona body — the backend's persona table is
 *  a single `summary` column, not a free-form `persona`. */
export interface UpdatePersonaBody {
  summary: string
}

/** Consolidate-job lifecycle row. */
export interface ConsolidateJob {
  id: string
  startedAt: number
  finishedAt: number | null
  phase: 'running' | 'done' | 'failed'
  result: { users?: number; updated?: number; error?: string }
}

export interface ConsolidateMemoryResponse {
  ok: true
  jobId: string
  hint?: string
  alreadyRunning?: boolean
}

export interface ConsolidateStatusResponse {
  jobs: ConsolidateJob[]
}

export type VectorBackendName = 'off' | 'local' | 'openai'

/** Mirror of src/core/memory-vector.ts:BackendStatus. */
export interface VectorBackendStatus {
  backend: VectorBackendName
  ready: boolean
  dims: number
  modelId: string
  lastError: string | null
  /** Local-only: model files present on disk. ready may still be
   *  false if the in-process pipeline hasn't loaded them yet. */
  downloaded?: boolean
  /** Backend-specific extra info — varies by adapter. */
  detail: Record<string, unknown>
}

/** Per-user (or global, when user_key omitted) embedding coverage. */
export interface VectorCoverage {
  total: number
  withEmbedding: number
  withDifferentModel: number
}

/** Async job tracker for backfill / download. */
export interface VectorJob {
  id: string
  kind: 'download' | 'backfill'
  startedAt: number
  finishedAt: number | null
  phase: 'running' | 'done' | 'failed'
  message: string
  details: Record<string, unknown>
}

/** Response shape of GET /api/memory/vector/status. */
export interface VectorStatus {
  status: VectorBackendStatus
  coverage: VectorCoverage
  jobs: VectorJob[]
}

/** Common shape returned by POST /api/memory/vector/{download,
 *  backfill}: 202 with a jobId the client polls via the status
 *  endpoint, or 200 with `alreadyReady` when the action is a no-op. */
export interface VectorActionResponse {
  ok: boolean
  jobId?: string
  alreadyRunning?: boolean
  alreadyReady?: boolean
  hint?: string
}

export interface VectorClearResponse {
  ok: true
  cleared: number
}

export interface VectorTestResponse {
  ok: boolean
  error?: string
  /** Backend-specific extras (latency, sample embedding length, etc.). */
  [extra: string]: unknown
}

/* ============================================================
 * Skills — read-only browse over ~/.claude/skills + opencode dirs.
 * ============================================================ */

export type SkillAgent = 'claude' | 'opencode'

export interface SkillMeta {
  slug: string
  name: string
  description: string
  category: string
  agents: SkillAgent[]
  /** Canonical SKILL.md path — used as the cache key for the
   *  detail fetch, not displayed. */
  path: string
}

export interface ListSkillsResponse {
  total: number
  /** Tally per category for the grouped list view. */
  byCategory: Record<string, number>
  skills: SkillMeta[]
  /** Configured source directories — surfaces empty/missing roots. */
  sources: { claude: string; opencode: string }
}

/** GET /api/skills/:slug response — meta + full markdown body. */
export interface SkillDetail extends SkillMeta {
  content: string
}

/** One entry in the skillhub.cn hot list. The upstream shape changes
 *  over time and not every field is guaranteed; everything is narrowed
 *  to `?` so a missing column doesn't crash the row renderer. */
export interface RemoteSkill {
  slug: string
  name?: string
  description?: string
  version?: string
  category?: string
  stars?: number
  installs?: number
  downloads?: number
}

/** Response shape of GET /api/skills/remote/hot — proxy of
 *  https://api.skillhub.cn/api/v1/showcase/hot with 5-min server cache.
 *  `stale` is set when the upstream call failed and we returned the
 *  last cached payload anyway. */
export interface RemoteHotSkillsResponse {
  skills: RemoteSkill[]
  cached: boolean
  fetchedAt: number
  stale?: boolean
  upstreamStatus?: number
  upstreamError?: string
}

/* ============================================================
 * Workspace files — agent CWD browser + editor.
 * ============================================================ */

export interface WorkspaceFileEntry {
  name: string
  isDir: boolean
  /** Bytes; null when not a regular file. */
  size: number | null
  /** ISO timestamp; null when not a regular file. */
  mtime: string | null
  /** Set when readdir hit an unreadable child. */
  broken?: boolean
  /** Set when a symlink resolves outside the workspace root. The
   *  child stays in the listing so the operator can see + fix it. */
  symlink_escape?: boolean
}

export interface WorkspaceDirListing {
  type: 'dir'
  agent: string
  /** Path relative to the workspace root (empty string for root). */
  path: string
  base: string
  entries: WorkspaceFileEntry[]
}

export interface WorkspaceFileContent {
  type: 'file'
  agent: string
  path: string
  size: number
  /** ISO timestamp. */
  mtime: string
  encoding: 'utf-8' | 'base64'
  /** UTF-8 text when encoding=utf-8; base64 when binary. */
  content: string
  /** True when file > WORKSPACE_FILE_MAX_BYTES (1 MiB) and only the
   *  first MiB was returned. */
  truncated: boolean
}

export type WorkspaceFilesResponse = WorkspaceDirListing | WorkspaceFileContent

export interface WriteWorkspaceFileBody {
  content: string
}

export interface WriteWorkspaceFileResponse {
  ok: true
  agent: string
  path: string
  size: number
  mtime: string
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
  dingtalk?: {
    clientId?: string
    clientSecret?: string
    channelId?: string
    // v1.2.37+ (batch 1)
    dmPolicy?: 'open' | 'pairing' | 'allowlist'
    groupPolicy?: 'open' | 'allowlist' | 'disabled'
    allowFrom?: string[]
    groupAllowFrom?: string[]
    ackReaction?: 'off' | 'emoji' | 'kaomoji'
    // v1.2.40 (batch 4) — multi-account, surfaced read-only in the UI
    // (managed via config.json / CLI for now).
    accounts?: Record<string, {
      name?: string
      clientId?: string
      clientSecret?: string
      dmPolicy?: 'open' | 'pairing' | 'allowlist'
      groupPolicy?: 'open' | 'allowlist' | 'disabled'
      allowFrom?: string[]
      groupAllowFrom?: string[]
      ackReaction?: 'off' | 'emoji' | 'kaomoji'
      enabled?: boolean
    }>
  }
  discord?: { botToken?: string; channelId?: string }
  acpAgents?: ACPAgentConfig[]
  agentStatus?: Record<string, boolean>
  /** Server-side compliance feature flags. The SPA reads these to hide
   *  the corresponding tabs / cards when the deployment is gated. */
  features?: {
    globalIm?: boolean
    remoteAgent?: boolean
    /** v1.2.71 — runtime IMHUB_PLATFORM_BLACKLIST set, alias-expanded
     *  (e.g. ['wechat', 'wechat-ilink', 'telegram']). SPA hides the
     *  corresponding PlatformCard / nav entries. Empty array when the
     *  env is unset. */
    blacklistedPlatforms?: string[]
  }
  /** Open-ended for forward-compat. */
  [key: string]: unknown
}

/* ============================================================
 * Remote ACP (Agent Communication Protocol) agents
 * ============================================================ */

export type ACPAuthType = 'none' | 'apikey' | 'bearer'

export interface ACPAuthConfig {
  type: ACPAuthType
  /** Masked in GET /api/config responses; client should treat strings
   *  that look like masked tokens (`ab****yz`) as "leave unchanged". */
  token?: string
}

export interface ACPAgentConfig {
  name: string
  endpoint: string
  aliases?: string[]
  auth?: ACPAuthConfig
  enabled?: boolean
}

export interface ACPDiscoverBody {
  baseUrl: string
  /** When true, server hot-loads discovered agents into the registry. */
  register?: boolean
}

export interface ACPDiscoverResponse {
  ok: true
  baseUrl: string
  agents: ACPAgentConfig[]
}

export interface ACPTestBody {
  endpoint: string
  auth?: ACPAuthConfig
}

export interface ACPTestResponse {
  ok: true
  name: string
  description?: string
}

/* ============================================================
 * SMTP email — verify-only "Test connection" endpoint
 * ============================================================ */

export interface EmailTestResponse {
  ok: true
  /** Human-readable success line, e.g. `Connected to smtp.gmail.com:465`. */
  message: string
}

/* ============================================================
 * v1.2.126 — web_search provider settings
 * ============================================================ */

/** One row of the search provider table the SPA renders. */
export interface SearchProviderInfo {
  /** Stable id used in IMHUB_WEB_SEARCH_PROVIDERS, e.g. `tavily`. */
  name: string
  /** Env key holding this provider's API key, or null if none required. */
  envKey: string | null
  /** True iff key is present (or none required) — sets the status badge. */
  available: boolean
}

export interface SearchProvidersResponse {
  /** All registered providers (ordered as registered, not by chain). */
  providers: SearchProviderInfo[]
  /** Provider names that the dispatcher will try in order on next call. */
  chain: string[]
}

export interface SearchTestBody {
  provider: string
  query: string
}

export interface SearchTestResponse {
  ok: boolean
  provider: string
  /** Wall-clock from request start to response (or to error). */
  latencyMs: number
  /** Number of hits returned (0 on error). */
  hits: number
  /** Short error string when ok=false. Absent on success. */
  error?: string
}

/* ============================================================
 * v1.2.129 — mobile QR sign-in
 * ============================================================ */

/** Optional overrides — leave both blank to use the admin request's
 *  Host header (cloudflared tunnel friendly). */
export interface MobileQRBody {
  /** "host:port" (no scheme). Server auto-detects scheme from x-fwd-proto. */
  host?: string
  /** Full base URL ("https://…/") overrides host. */
  baseUrl?: string
}

export interface MobileQRResponse {
  ok: boolean
  /** Token id (tk_xxxxxxxx) — surface in revoke instructions. */
  tokenId: string
  /** Human-readable token label written into the token store. */
  label: string
  /** Full URL embedded in the QR (also useful for copy-paste flows). */
  loginUrl: string
  /** PNG data: URL produced by the `qrcode` lib. ~3–5 KB. */
  qrDataUrl: string
  /** SPA path to take the admin to for revoke ("/settings/security/tokens"). */
  revokeHint: string
}

/* ============================================================
 * Viewer + cloudflared tunnel
 * ============================================================ */

/** Mirror of src/core/tunnel.ts:TunnelStatus, plus what
 *  handleViewerTunnelStatus also folds in (viewer config + computed
 *  effective public URL). */
export interface ViewerTunnelStatusResponse {
  /** From IMHUB_VIEWER_ENABLED. */
  enabled: boolean
  /** From IMHUB_VIEWER_TUNNEL_MODE — `off` or `quick`. */
  tunnelMode: 'off' | 'quick'
  /** From IMHUB_VIEWER_PUBLIC_BASE_URL — operator-set static URL. */
  staticPublicUrl: string | null
  /** Computed by viewer-config — the live tunnel URL when quick mode is
   *  connected, else the static URL. This is what `/v/<id>` links use. */
  effectivePublicUrl: string | null
  tunnel: {
    running: boolean
    url: string | null
    binaryFound: boolean
    binaryPath: string | null
    lastError: string | null
    startedAt: number | null
  }
}

/* ============================================================
 * Health / Observability
 * ============================================================ */

/** Mirror of src/core/audit-log.ts:HealthSummary. */
export interface HealthSummary {
  /** Window start (YYYY-MM-DD). */
  since: string
  until: string
  days: number
  totals: {
    calls: number
    cost: number
    errors: number
    errorRate: number
    avgLatencyMs: number
    p95LatencyMs: number
  }
  byDay: Array<{
    date: string
    calls: number
    cost: number
    errors: number
    avgLatencyMs: number
  }>
}

export type TopNDim = 'user' | 'agent' | 'platform' | 'intent'
export type TopNMetric = 'cost' | 'calls' | 'errors' | 'avg_latency'

export interface TopNItem {
  key: string
  calls: number
  cost: number
  errors: number
  avgLatencyMs: number
}

export interface TopNResponse {
  dim: TopNDim
  by: TopNMetric
  days: number
  items: TopNItem[]
}

/** Mirror of src/core/audit-log.ts:InvocationRow. */
export interface InvocationRow {
  id: number
  trace_id: string
  /** ISO timestamp; SQLite stores as TEXT. */
  ts: string
  user_id: string
  platform: string
  agent: string
  intent: string
  prompt_len: number
  response_len: number
  duration_ms: number
  cost: number
  /** Stored as 0/1 in SQLite. */
  success: number
  error: string | null
}

export interface AuditStats {
  total: number
  byAgent: Record<string, number>
  totalCost: number
}

export interface AuditResponse {
  invocations: InvocationRow[]
  stats: AuditStats
}

export interface ListAuditQuery {
  limit?: number
  days?: number
  agent?: string
  platform?: string
  user?: string
  intent?: string
}

/* ============================================================
 * Settings — env file, service control.
 * ============================================================ */

export interface EnvResponse {
  /** Editable env-file values keyed by IMHUB_*. Secrets are masked
   *  unless ?reveal=1 was passed (only last 4 chars visible). */
  env: Record<string, string>
  /** Subset of env keys whose values are treated as secrets — the
   *  UI should hide their values by default and use a Reveal toggle. */
  secretKeys: string[]
}

export interface UpdateEnvBody {
  /** Map of key → new value. Pass `null` to unset a key. Only keys
   *  on the backend's `ENV_EDITABLE_KEYS` allowlist are accepted;
   *  anything else is silently dropped. */
  updates: Record<string, string | null>
}

export type ServiceMode = 'systemd' | 'background' | 'foreground' | 'none'

export interface ServiceStatus {
  mode: ServiceMode
  pid: number | null
  uptimeSec: number | null
  /** Human-rendered uptime (e.g. "3h 12m"). */
  uptime: string | null
  /** Public web endpoint, when known. */
  web: {
    bind: string
    port: number
  } | null
  /** Boot lifecycle phase from core/boot-state.ts. */
  bootPhase: string
  bootMsSinceStart: number
  bootPhaseTimings: Record<string, number>
}

export interface ServiceActionResponse {
  ok: boolean
  mode?: ServiceMode
  pid?: number
  alreadyRunning?: boolean
}

/* ============================================================
 * Admin allowlist — users who can run admin-tier commands.
 * Editor only works when web is bound locally (the backend
 * gates POST + DELETE on isLocalBind).
 * ============================================================ */

export interface AdminEntry {
  platform: string
  userId: string
}

export interface AdminAllowlistResponse {
  admins: AdminEntry[]
  /** True once at least one admin has been set. When false, the
   *  CLI's bootstrap token is the only privileged path. */
  configured: boolean
  /** Bootstrap token file present on disk — operator can use it
   *  to seed the first admin. */
  bootstrapAvailable: boolean
  bootstrapTokenPath: string
}

export interface AddAdminBody {
  platform: string
  userId: string
}

export interface RemoveAdminBody {
  platform: string
  userId: string
}

export interface AdminMutationResponse {
  ok: boolean
  added?: boolean
  removed?: boolean
  admins: AdminEntry[]
}

/* ============================================================
 * WeChat QR login flow (messengers card).
 * ============================================================ */

export interface WechatQrStartResponse {
  qrUrl: string
  qrToken: string
  /** PNG data: URL produced server-side via the `qrcode` lib —
   *  drop into `<img src>` directly. */
  qrImage: string
}

export type WechatQrStatus =
  | 'pending'
  | 'scanned'
  | 'confirmed'
  | 'expired'
  | 'cancelled'

export interface WechatQrStatusResponse {
  status: WechatQrStatus
  /** When status='confirmed', backend has already persisted the
   *  wechat-ilink slot in config.messengers. */
  wxid?: string
  nickname?: string
  expiresIn?: number
}

/* ============================================================
 * Workspaces — multi-tenant registry.
 * ============================================================ */

export interface WorkspaceConfig {
  id: string
  name: string
  /** Whitelist of agent names available in this workspace. Empty
   *  array = unrestricted (any registered agent works). */
  agents: string[]
  /** Per-workspace rate-limit settings; undefined = use defaults. */
  rateLimit?: { rate: number; intervalSec: number; burst: number }
  /** Member userIds (`platform:userId`) with access. Empty array or
   *  undefined = open workspace (any user can use it). */
  members?: string[]
}
