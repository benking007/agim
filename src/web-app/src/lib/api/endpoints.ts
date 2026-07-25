/**
 * Hand-curated, typed SPA facade for backend REST endpoints.
 *
 * `npm run check:contracts` verifies every client call against the route
 * manifest extracted from `src/web/*.ts` domain modules (server.ts only
 * prefixes and delegates). Not every backend route needs a SPA wrapper,
 * but every wrapper must resolve to a real route. Keep request and
 * response types here; this file is never overwritten by a generator.
 */

import { client } from './client'
import type {
  A2AStats,
  ACPDiscoverBody,
  ACPDiscoverResponse,
  ACPTestBody,
  ACPTestResponse,
  AppConfig,
  EmailTestResponse,
  ViewerTunnelStatusResponse,
  AddAdminBody,
  AdminAllowlistResponse,
  AdminMutationResponse,
  AuditResponse,
  BatchJobBody,
  AutoApprovePolicyResponse,
  EnvResponse,
  RemoveAdminBody,
  UpdateAutoApprovePolicyBody,
  WechatQrStartResponse,
  WechatQrStatusResponse,
  WorkspaceConfig,
  ServiceActionResponse,
  ServiceLogTailResponse,
  ServiceStatus,
  UpdateEnvBody,
  CreateJobBody,
  CreateJobResponse,
  HealthSummary,
  ListA2ARecentQuery,
  ListA2ARecentResponse,
  ListApprovalsResponse,
  ListAuditQuery,
  TopNDim,
  TopNMetric,
  ResolveApprovalBody,
  ResolveApprovalResponse,
  MobileQRBody,
  MobileQRResponse,
  SearchProvidersResponse,
  SearchTestBody,
  SearchTestResponse,
  CancelReminderResponse,
  ConsolidateMemoryResponse,
  ConsolidateStatusResponse,
  DistillStatusResponse,
  DistillTriggerResponse,
  DeleteMemoResponse,
  GetBgjobQuery,
  GetBgjobResponse,
  ListBgjobsQuery,
  ListBgjobsResponse,
  ListSkillsResponse,
  RemoteHotSkillsResponse,
  SkillDetail,
  VectorActionResponse,
  VectorClearResponse,
  VectorTestResponse,
  WorkspaceFilesResponse,
  WriteWorkspaceFileBody,
  WriteWorkspaceFileResponse,
  GetJobResponse,
  ListJobsQuery,
  ListJobsResponse,
  DeleteMemoryFactsBody,
  DeleteMemoryFactsResponse,
  ListMemoryFactsQuery,
  ListMemoryFactsResponse,
  ListMemoryUsersResponse,
  ListMemosQuery,
  ListMemosResponse,
  ListOutboxQuery,
  ListOutboxResponse,
  ListRemindersQuery,
  ListRemindersResponse,
  ListSchedulesQuery,
  ListSchedulesResponse,
  ListSubtasksQuery,
  ListSubtasksResponse,
  LoginBody,
  LoginResponse,
  OkResponse,
  OutboxRetryResponse,
  OutboxStats,
  Persona,
  SnoozeReminderBody,
  SnoozeReminderResponse,
  TopNResponse,
  UpdatePersonaBody,
  VectorStatus,
} from '@/types/api'

export const api = {
  /** GET /api/a2a/recent */
  getA2ARecent: (query: ListA2ARecentQuery) =>
    client.get<ListA2ARecentResponse>('/api/a2a/recent', { query }),

  /** GET /api/a2a/stats */
  getA2AStats: () =>
    client.get<A2AStats>('/api/a2a/stats'),

  /** DELETE /api/admin-allowlist */
  removeAdminAllowlist: (body: RemoveAdminBody) =>
    client.delete<AdminMutationResponse>('/api/admin-allowlist', { body }),

  /** GET /api/admin-allowlist */
  listAdminAllowlist: () =>
    client.get<AdminAllowlistResponse>('/api/admin-allowlist'),

  /** POST /api/admin-allowlist */
  addAdminAllowlist: (body: AddAdminBody) =>
    client.post<AdminMutationResponse>('/api/admin-allowlist', { body }),

  /** GET /api/agent-health */
  getAgentHealth: (opts?: { query?: Record<string, string | number | boolean | undefined> }) =>
    client.get<unknown>('/api/agent-health', opts),

  /** POST /api/agents/acp/discover — probe a `<baseUrl>/.well-known/acp`
   *  document. With `register: true` the server also hot-loads the
   *  discovered agents into the in-memory registry; persisting them
   *  across restarts still requires PUT /api/config { acpAgents }. */
  discoverAcpAgents: (body: ACPDiscoverBody) =>
    client.post<ACPDiscoverResponse>('/api/agents/acp/discover', { body }),

  /** POST /api/agents/acp/test — probe a single agent endpoint by
   *  fetching its `/agent/card` manifest. Used by the "Test" buttons
   *  in /settings/agents to validate an ACP entry before saving. */
  testAcpAgent: (body: ACPTestBody) =>
    client.post<ACPTestResponse>('/api/agents/acp/test', { body }),

  /** POST /api/messengers/email/test — run nodemailer.verify() against
   *  the SMTP creds currently in process.env. No mail is sent. Operators
   *  fill the form, Save (PUT /api/env), then click Test. */
  testEmail: () =>
    client.post<EmailTestResponse>('/api/messengers/email/test'),

  /** GET /api/search/providers — list of registered web_search backends
   *  with envKey, current availability, and the resolved chain. */
  getSearchProviders: () =>
    client.get<SearchProvidersResponse>('/api/search/providers'),

  /** POST /api/search/test — ping a single named provider with a small
   *  query and report latency / hit count / error. */
  testSearchProvider: (body: SearchTestBody) =>
    client.post<SearchTestResponse>('/api/search/test', { body }),

  /** POST /api/mobile/qr — admin generates a fresh role=user token +
   *  QR PNG (data URL) pointing the scanner at /m/login. v1.2.129. */
  generateMobileQR: (body?: MobileQRBody) =>
    client.post<MobileQRResponse>('/api/mobile/qr', { body: body ?? {} }),

  /** GET /api/agents/status — agent name → online boolean map */
  getAgentsStatus: () =>
    client.get<Record<string, boolean>>('/api/agents/status'),

  /** GET /api/approvals */
  listApprovals: () =>
    client.get<ListApprovalsResponse>('/api/approvals'),

  /** POST /api/approvals/:reqId/resolve */
  resolveApproval: (reqId: string, body: ResolveApprovalBody) =>
    client.post<ResolveApprovalResponse>(`/api/approvals/${encodeURIComponent(reqId)}/resolve`, { body }),

  /** GET /api/audit */
  getAudit: (query: ListAuditQuery) =>
    client.get<AuditResponse>('/api/audit', { query }),

  /** POST /api/auth/login (public) */
  login: (body: LoginBody) =>
    client.post<LoginResponse>('/api/auth/login', { body }),

  /** POST /api/auth/logout */
  logout: (opts?: { body?: unknown }) =>
    client.post<OkResponse>('/api/auth/logout', opts),

  /** GET /api/bgjobs */
  listBgJobs: (query: ListBgjobsQuery) =>
    client.get<ListBgjobsResponse>('/api/bgjobs', { query }),

  /** GET /api/bgjobs/:id */
  getBgJob: (id: string, query?: GetBgjobQuery) =>
    client.get<GetBgjobResponse>(`/api/bgjobs/${encodeURIComponent(id)}`, { query }),

  /** GET /api/config */
  getConfig: () =>
    client.get<AppConfig>('/api/config'),

  /** PUT /api/config */
  updateConfig: (body: Partial<AppConfig>) =>
    client.put<AppConfig>('/api/config', { body }),

  /** GET /api/workspaces — summary shape by default; pass full: true
   *  for the editor (returns members array, not count). */
  listWorkspacesFull: () =>
    client.get<{ workspaces: WorkspaceConfig[] }>('/api/workspaces', { query: { full: true } }),

  /** POST /api/workspaces — upsert a workspace; backend wipes
   *  members === [] to "open" workspace. */
  upsertWorkspace: (body: WorkspaceConfig) =>
    client.post<{ ok: boolean; workspace: WorkspaceConfig }>('/api/workspaces', { body }),

  /** DELETE /api/workspaces/:id — remove a non-default workspace. */
  deleteWorkspace: (id: string) =>
    client.delete<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(id)}`),

  /** POST /api/messengers/wechat/qr-start — start the WeChat
   *  login QR session. Returns a PNG data: URL of the QR + a
   *  token to poll status with. */
  startWechatQr: () =>
    client.post<WechatQrStartResponse>('/api/messengers/wechat/qr-start'),

  /** GET /api/messengers/wechat/qr-status?token=… — poll for
   *  status. Server persists wechat-ilink to config on `confirmed`. */
  getWechatQrStatus: (query: { token: string }) =>
    client.get<WechatQrStatusResponse>('/api/messengers/wechat/qr-status', { query }),

  /** GET /api/env */
  getEnv: (query: { reveal?: boolean }) =>
    client.get<EnvResponse>('/api/env', { query }),

  /** PUT /api/env */
  updateEnv: (body: UpdateEnvBody) =>
    client.put<EnvResponse>('/api/env', { body }),

  /** GET /api/policy/auto-approve — main-agent auto-approve (any auth / Portal). */
  getAutoApprovePolicy: () =>
    client.get<AutoApprovePolicyResponse>('/api/policy/auto-approve'),

  /** PUT /api/policy/auto-approve */
  updateAutoApprovePolicy: (body: UpdateAutoApprovePolicyBody) =>
    client.put<AutoApprovePolicyResponse>('/api/policy/auto-approve', { body }),

  /** GET /api/health (public) */
  getHealth: (opts?: { query?: Record<string, string | number | boolean | undefined> }) =>
    client.get<{ status: string }>('/api/health', opts),

  /** GET /api/health/summary */
  getHealthSummary: (query: { days?: number }) =>
    client.get<HealthSummary>('/api/health/summary', { query }),

  /** GET /api/health/topn */
  getHealthTopN: (query: { dim: TopNDim; by: TopNMetric; days?: number; limit?: number }) =>
    client.get<TopNResponse>('/api/health/topn', { query }),

  /** GET /api/service/log-tail */
  getServiceLogTail: (query?: { lines?: number }) =>
    client.get<ServiceLogTailResponse>('/api/service/log-tail', { query }),

  /** POST /api/invoke */
  invoke: (opts?: { body?: unknown }) =>
    client.post<unknown>('/api/invoke', opts),

  /** GET /api/jobs */
  listJobs: (query: ListJobsQuery) =>
    client.get<ListJobsResponse>('/api/jobs', { query }),

  /** GET /api/jobs/:id — pass threadId for chat/Portal (role=user) Subagent detail */
  getJob: (id: number, query?: { threadId?: string }) =>
    client.get<GetJobResponse>(`/api/jobs/${id}`, { query }),

  /** POST /api/jobs */
  createJob: (body: CreateJobBody) =>
    client.post<CreateJobResponse>('/api/jobs', { body }),

  /** POST /api/jobs/batch-cancel */
  batchCancelJobs: (body: BatchJobBody) =>
    client.post<OkResponse>('/api/jobs/batch-cancel', { body }),

  /** POST /api/jobs/batch-run */
  batchRunJobs: (body: BatchJobBody) =>
    client.post<OkResponse>('/api/jobs/batch-run', { body }),

  /** POST /api/loc (public) */
  submitLoc: (opts?: { body?: unknown }) =>
    client.post<unknown>('/api/loc', opts),

  /** GET /api/loc/info (public) */
  getLocInfo: (opts?: { query?: Record<string, string | number | boolean | undefined> }) =>
    client.get<unknown>('/api/loc/info', opts),

  /** POST /api/memory/consolidate */
  consolidateMemory: () =>
    client.post<ConsolidateMemoryResponse>('/api/memory/consolidate'),

  /** GET /api/memory/consolidate/status */
  getMemoryConsolidateStatus: () =>
    client.get<ConsolidateStatusResponse>('/api/memory/consolidate/status'),

  /** POST /api/memory/distill — trigger one dream-distillation pass now. */
  triggerMemoryDistill: () =>
    client.post<DistillTriggerResponse>('/api/memory/distill'),

  /** GET /api/memory/distill/status */
  getMemoryDistillStatus: () =>
    client.get<DistillStatusResponse>('/api/memory/distill/status'),

  /** GET /api/memory/export */
  exportMemory: (opts?: { query?: Record<string, string | number | boolean | undefined> }) =>
    client.get<unknown>('/api/memory/export', opts),

  /** DELETE /api/memory/facts (bulk; body specifies ids / category /
   *  max_confidence / confirm_clear). */
  deleteMemoryFacts: (query: { user_key: string }, body: DeleteMemoryFactsBody) =>
    client.delete<DeleteMemoryFactsResponse>('/api/memory/facts', { query, body }),

  /** DELETE /api/memory/facts/:id (single-fact delete; user_key in query). */
  deleteMemoryFactById: (id: number, query: { user_key: string }) =>
    client.delete<OkResponse & { id: number }>(`/api/memory/facts/${id}`, { query }),

  /** GET /api/memory/facts */
  listMemoryFacts: (query: ListMemoryFactsQuery) =>
    client.get<ListMemoryFactsResponse>('/api/memory/facts', { query }),

  /** DELETE /api/memory/persona */
  deleteMemoryPersona: (query: { user_key: string }) =>
    client.delete<{ ok: boolean }>('/api/memory/persona', { query }),

  /** GET /api/memory/persona */
  getMemoryPersona: (query: { user_key: string }) =>
    client.get<Persona>('/api/memory/persona', { query }),

  /** PUT /api/memory/persona */
  updateMemoryPersona: (query: { user_key: string }, body: UpdatePersonaBody) =>
    client.put<{ ok: boolean }>('/api/memory/persona', { query, body }),

  /** GET /api/memory/users */
  listMemoryUsers: () =>
    client.get<ListMemoryUsersResponse>('/api/memory/users'),

  /** POST /api/memory/vector/backfill */
  backfillMemoryVector: (query: { user_key?: string }, body?: { max_rows?: number }) =>
    client.post<VectorActionResponse>('/api/memory/vector/backfill', { query, body }),

  /** POST /api/memory/vector/clear */
  clearMemoryVector: (query: { user_key?: string }) =>
    client.post<VectorClearResponse>('/api/memory/vector/clear', { query }),

  /** POST /api/memory/vector/download */
  downloadMemoryVector: () =>
    client.post<VectorActionResponse>('/api/memory/vector/download'),

  /** GET /api/memory/vector/status */
  getMemoryVectorStatus: (query: { user_key?: string }) =>
    client.get<VectorStatus>('/api/memory/vector/status', { query }),

  /** POST /api/memory/vector/test */
  testMemoryVector: () =>
    client.post<VectorTestResponse>('/api/memory/vector/test'),

  /** GET /api/memos */
  listMemos: (query: ListMemosQuery) =>
    client.get<ListMemosResponse>('/api/memos', { query }),

  /** DELETE /api/memos/:id */
  deleteMemo: (id: number) =>
    client.delete<DeleteMemoResponse>(`/api/memos/${id}`),

  // (WeChat QR start + status are defined earlier with typed responses.)

  /** GET /api/metrics */
  getMetrics: (opts?: { query?: Record<string, string | number | boolean | undefined> }) =>
    client.get<unknown>('/api/metrics', opts),

  /** POST /api/notify */
  notify: (opts?: { body?: unknown }) =>
    client.post<unknown>('/api/notify', opts),

  /** GET /api/outbox */
  listOutbox: (query: ListOutboxQuery) =>
    client.get<ListOutboxResponse>('/api/outbox', { query }),

  /** GET /api/outbox/stats */
  getOutboxStats: () =>
    client.get<OutboxStats>('/api/outbox/stats'),

  /** POST /api/outbox/:id/retry */
  retryOutbox: (id: number) =>
    client.post<OutboxRetryResponse>(`/api/outbox/${id}/retry`),

  /** GET /api/reminders */
  listReminders: (query: ListRemindersQuery) =>
    client.get<ListRemindersResponse>('/api/reminders', { query }),

  /** POST /api/reminders/:id/cancel */
  cancelReminder: (id: number) =>
    client.post<CancelReminderResponse>(`/api/reminders/${id}/cancel`),

  /** POST /api/reminders/:id/snooze */
  snoozeReminder: (id: number, body: SnoozeReminderBody) =>
    client.post<SnoozeReminderResponse>(`/api/reminders/${id}/snooze`, { body }),

  /** GET /api/schedules */
  listSchedules: (query: ListSchedulesQuery) =>
    client.get<ListSchedulesResponse>('/api/schedules', { query }),

  /** POST /api/service/restart */
  restartService: () =>
    client.post<ServiceActionResponse>('/api/service/restart'),

  /** POST /api/service/start */
  startService: () =>
    client.post<ServiceActionResponse>('/api/service/start'),

  /** GET /api/service/status */
  getServiceStatus: () =>
    client.get<ServiceStatus>('/api/service/status'),

  /** POST /api/service/stop */
  stopService: () =>
    client.post<ServiceActionResponse>('/api/service/stop'),

  /** GET /api/skills */
  listSkills: () =>
    client.get<ListSkillsResponse>('/api/skills'),

  /** GET /api/skills/:slug */
  getSkillDetail: (slug: string) =>
    client.get<SkillDetail>(`/api/skills/${encodeURIComponent(slug)}`),

  /** GET /api/skills/remote/hot — proxy to skillhub.cn with 5min
   *  server cache. Per-entry fields are optional in case the upstream
   *  shape changes. */
  getSkillsRemoteHot: () =>
    client.get<RemoteHotSkillsResponse>('/api/skills/remote/hot'),

  /** GET /api/subtasks */
  listSubtasks: (query: ListSubtasksQuery) =>
    client.get<ListSubtasksResponse>('/api/subtasks', { query }),

  /** GET /api/viewer */
  listViewerPastes: (opts?: { query?: Record<string, string | number | boolean | undefined> }) =>
    client.get<unknown>('/api/viewer', opts),

  /** GET /api/viewer/tunnel — combined viewer config + cloudflared
   *  tunnel state (running, URL, binary location, last error). The UI
   *  polls this card whenever the operator clicks Refresh. */
  getViewerTunnel: () =>
    client.get<ViewerTunnelStatusResponse>('/api/viewer/tunnel'),

  /** GET /api/workspace-files — discriminated union response on
   *  ?path= (dir listing vs file content). */
  getWorkspaceFiles: (query: { agent: string; path?: string }) =>
    client.get<WorkspaceFilesResponse>('/api/workspace-files', { query }),

  /** PUT /api/workspace-files */
  writeWorkspaceFile: (query: { agent: string; path: string }, body: WriteWorkspaceFileBody) =>
    client.put<WriteWorkspaceFileResponse>('/api/workspace-files', { query, body }),

} as const
