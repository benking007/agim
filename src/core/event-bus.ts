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

export type ImhubEvent = AuditEvent | ApprovalEvent | JobEvent | MetricsEvent

/** Cap at 200 entries — enough for the dashboard to show a meaningful
 *  "what just happened" feed without bloating process memory. Module-
 *  level so the class's instance-field initializer can reference it
 *  without tripping TS's "used-before-initialization" check on a
 *  static field. */
const RECENT_CAP = 200

class ImhubEventBus extends EventEmitter {
  /** Bounded recent-event log so a freshly-connected SSE client can
   *  catch up on what happened in the last few seconds without needing
   *  a separate REST poll.
   *
   *  Implementation: a fixed-size ring buffer. The previous design used
   *  `push` + `shift` once the cap was reached; `Array.shift()` is O(n)
   *  (it physically rewrites the backing storage) and was a measurable
   *  hot-path cost under approval / audit storms (~1k events / second
   *  bursts during agent boot). Ring write is O(1); the only O(n) work
   *  is in {@link getRecent}, which is rare (once per SSE connect).
   */
  private recent: (ImhubEvent | undefined)[] = new Array(RECENT_CAP)
  /** Next write slot (also = oldest slot when buffer is full). */
  private recentHead = 0
  /** Valid entry count — ramps from 0 to RECENT_CAP then stays there. */
  private recentSize = 0

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
  publish(event: ImhubEvent): void {
    this.recent[this.recentHead] = event
    this.recentHead = (this.recentHead + 1) % RECENT_CAP
    if (this.recentSize < RECENT_CAP) this.recentSize++
    try {
      this.emit('event', event)
    } catch {
      // EventEmitter normally rethrows — caller is in a hot path so we swallow.
    }
  }

  /** Snapshot of the recent ring buffer, oldest-first. Used by SSE
   *  handler on connection to replay recent events to a fresh client. */
  getRecent(): ImhubEvent[] {
    const out: ImhubEvent[] = []
    if (this.recentSize < RECENT_CAP) {
      // Buffer still filling: entries 0..recentHead-1 are valid in order.
      for (let i = 0; i < this.recentHead; i++) {
        const ev = this.recent[i]
        if (ev) out.push(ev)
      }
      return out
    }
    // Full: oldest entry is at recentHead; walk forward, wrapping once.
    for (let i = 0; i < RECENT_CAP; i++) {
      const ev = this.recent[(this.recentHead + i) % RECENT_CAP]
      if (ev) out.push(ev)
    }
    return out
  }

  /** Test-only — reset buffer state. */
  _resetRecent(): void {
    this.recent = new Array(RECENT_CAP)
    this.recentHead = 0
    this.recentSize = 0
  }

  /** Test/diagnostic: capacity of the recent-event ring. */
  static get RECENT_CAP(): number { return RECENT_CAP }
}

export const eventBus = new ImhubEventBus()
