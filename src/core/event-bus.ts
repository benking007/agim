// agim event bus — fan-out for cross-cutting state changes that the
// dashboard / future plugins want to observe in real time.
//
// Why a dedicated bus instead of just exposing each module's
// EventEmitter?
//
//   1. Type uniformity. Subscribers want to handle *any* event with one
//      handler shape; otherwise tasks.html ends up wiring six different
//      EventEmitters by hand.
//   2. Cross-module decoupling. audit-log / approval-bus / job-board
//      should not know that a Web SSE consumer exists. They emit on the
//      bus; whoever wants to listen does.
//   3. Backpressure / fan-out. The /events SSE endpoint multiplexes a
//      single bus subscription out to N browser clients. If a single
//      client is slow we don't want to drag the entire process; the bus
//      only does fan-out, per-connection write-buffering is the SSE
//      handler's responsibility.
//
// IMPORTANT: emit is best-effort. Never throw out of an emit() — the
// caller (audit-log.logInvocation, approvalBus.handleApproval, etc.) is
// in a hot path. We swallow listener errors here so a buggy subscriber
// can't break the originating action.

import { EventEmitter } from 'node:events'

/** Fired by audit-log.logInvocation after a successful (or failed) agent
 *  invocation has been recorded. Mirrors the shape audit-log already
 *  builds, plus a `ts` ISO string for client-side sorting. */
export interface AuditEvent {
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

/** Fired when approval-bus enqueues a new pending or resolves one. The
 *  /api/approvals snapshot is still authoritative; this event lets the
 *  UI refresh that tab (and the in-chat card) without waiting on the
 *  3 s poll. */
export interface ApprovalEvent {
  type: 'approval'
  phase: 'requested' | 'resolved'
  reqId: string
  threadId: string
  platform: string
  toolName: string
  /** Present on resolved events — 'allow' / 'deny' / 'timeout' from the
   *  bus's metrics buckets. Absent on `requested`. */
  outcome?: 'allow' | 'deny' | 'timeout'
}

/** Fired on job-board state transitions. The dashboard subscribes to
 *  refresh the Jobs tab without polling. */
export interface JobEvent {
  type: 'job'
  phase: 'created' | 'started' | 'completed' | 'failed' | 'cancelled'
  jobId: number
  agent: string
}

/** Periodic metrics tick. Different from individual audit events: this
 *  is a snapshot of the full per-agent state (counters + latency
 *  quantiles) so the Health tab's sparkline doesn't have to derive
 *  everything from raw audits. Emitted by an internal interval, not by
 *  any specific call site. */
export interface MetricsEvent {
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

export type AgimEvent = AuditEvent | ApprovalEvent | JobEvent | MetricsEvent

class AgimEventBus extends EventEmitter {
  /** Bounded recent-event log so a freshly-connected SSE client can
   *  catch up on what happened in the last few seconds without needing
   *  a separate REST poll. Cap at 200 entries — enough for the dashboard
   *  to show a meaningful "what just happened" feed without bloating
   *  process memory. */
  private recent: AgimEvent[] = []
  private static readonly RECENT_CAP = 200

  constructor() {
    super()
    // EventEmitter defaults to 10 listeners before warning; we expect one
    // handler per SSE connection plus a few internal subscribers, so 100
    // is a comfortable cap that still flags accidental leaks.
    this.setMaxListeners(100)
  }

  /**
   * Publish a typed event. Listeners are called synchronously inside
   * EventEmitter.emit; errors thrown from a listener are caught here so
   * a bad subscriber can't break audit-log / approval-bus / job-board.
   */
  publish(event: AgimEvent): void {
    this.recent.push(event)
    while (this.recent.length > AgimEventBus.RECENT_CAP) this.recent.shift()
    try {
      this.emit('event', event)
    } catch {
      // EventEmitter normally rethrows — caller is in a hot path so we swallow.
    }
  }

  /** Snapshot of the recent ring buffer. Used by SSE handler on
   *  connection to replay the last N events to a fresh client. */
  getRecent(): AgimEvent[] {
    return this.recent.slice()
  }
}

export const eventBus = new AgimEventBus()
