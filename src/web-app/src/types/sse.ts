/**
 * types/sse.ts — server-sent events on /events.
 *
 * Wire shape source: src/core/event-bus.ts ImhubEvent union. Replicated
 * here so the SPA has a typed view without importing across the
 * backend/frontend boundary. If the backend's event union grows, add
 * the new type here + a handler slot in useEventStream.
 *
 * Convention: each event carries a `type` discriminator matching the
 * SSE `event:` line. EventSource fires a typed `addEventListener` per
 * type; we don't observe a single 'message' channel.
 */

/** Audit log entry — fired after an agent invocation lands in the
 *  audit table. Drives the observability page's audit timeline. */
export interface SseAuditEvent {
  type: 'audit'
  ts: string
  agent: string
  intent: string
  platform: string
  durationMs: number
  cost: number
  success: boolean
  traceId: string
  userId: string
}

/** Approval bus state change — requested / resolved. The approvals
 *  page refreshes its queue on this; the chat layer also listens to
 *  flash the relevant inline card. */
export interface SseApprovalEvent {
  type: 'approval'
  phase: 'requested' | 'resolved'
  reqId: string
  threadId: string
  platform: string
  toolName: string
  outcome?: 'allow' | 'deny' | 'timeout'
}

/** Job board transition. The tasks page refreshes its jobs sub-tab
 *  whenever any of created / started / completed / failed / cancelled
 *  fires. */
export interface SseJobEvent {
  type: 'job'
  phase: 'created' | 'started' | 'completed' | 'failed' | 'cancelled'
  jobId: number
  agent: string
}

/** Periodic metrics tick. The observability page uses this to refresh
 *  the per-agent sparklines without polling. */
export interface SseMetricsEvent {
  type: 'metrics'
  ts: string
  agents: Array<{
    agent: string
    total: number
    success: number
    failure: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
  }>
}

/** Server-sent `hello` event — fired once after the SSE connection
 *  opens with `{ ts }`. Used as a heartbeat / connection-ready signal
 *  by the hook. Not emitted by event-bus itself; the SSE handler
 *  synthesises it. */
export interface SseHelloEvent {
  type: 'hello'
  ts: string
}

export type SseEvent =
  | SseAuditEvent
  | SseApprovalEvent
  | SseJobEvent
  | SseMetricsEvent
  | SseHelloEvent
