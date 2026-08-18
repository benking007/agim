/**
 * types/ws.ts — typed messages on the /ws WebSocket.
 *
 * Wire shape source: src/web/ws-chat.ts (handleClientMessage /
 * sendToClient). Discriminated unions so the chat reducer can
 * switch on `msg.type` with exhaustive checks.
 *
 * Note: this is the SPA-side schema. If the backend gains a new
 * server→client type we add it here + the reducer; an unknown type
 * is logged + dropped (silently).
 */

/** Client → Server */
export type ChatOutgoing =
  | { type: 'message'; text: string; agent?: string; workspacePath?: string }
  | { type: 'set-workspace'; workspacePath?: string }
  | { type: 'switch-agent'; agent: string }
  | { type: 'get-agents' }
  | { type: 'get-history'; threadId?: string }
  /** Clear messages + per-agent CLI bindings + auto-allow rules. The
   *  server replies with an empty `history` so the UI repaints clear. */
  | { type: 'new-conversation' }
  /** Abort the in-flight web chat run for this thread (Stop button). */
  | { type: 'stop' }
  /** Inject a mid-turn user supplement into the live Agim run. */
  | { type: 'steer'; text: string }
  /** Cancel one live Subagent/A2A inline job; parent turn continues. */
  | { type: 'stop-subagent'; jobId: number }
  /** Approval card button click. `data` MUST be the
   *  `apv:<reqId>:<y|n|a>` callback_data that approval-router's
   *  `parseCallbackData` expects — v2 routes it through unchanged. */
  | { type: 'approval-action'; data: string; messageId: string }
  /** Choice (ask_user) card answer. `data` MUST be one of the
   *  `ask:<reqId>:…` forms ask-user-router parses:
   *  `ask:<reqId>:<index>` (single), `ask:<reqId>:multi:<i,j>` (multi),
   *  or `ask:<reqId>:custom:<base64url>` (free-form). The server fans
   *  this through ask-user-router unchanged. */
  | { type: 'choice-action'; data: string; messageId: string }

/** Server → Client */
export type ChatIncoming =
  | { type: 'init'; agents: string[]; defaultAgent: string; clientId: string }
  | {
      type: 'history'
      messages: HistoryMessage[]
      agent: string
      /** Preferred Loop Subagent (CLI) while Agim parents. Empty = none. */
      preferredWorkerAgent?: string
      planMode?: boolean
      stepReflect?: boolean
      stepReflectDisabled?: boolean
      thinkVariant?: string
      sessionModel?: string
      /** Session compression rate (`auto` | `full` | `balanced` | `frequent`). */
      compactRate?: string
      /**
       * Messages still older than this frame (full `.log` count − tail).
       * Omitted / 0 = this frame is the complete transcript (legacy servers).
       */
      olderCount?: number
      /** False when older turns will follow as `history-prepend`. */
      historyComplete?: boolean
      /** First user line of the full log (not the tail) — session rail title. */
      sessionTitle?: string
      /**
       * Server transcript revision (epoch ms): max(session.lastActivity,
       * last message timestamp). SPA compares this to the localStorage
       * snapshot's `revisionAt` to decide whose copy is newer.
       */
      updatedAt?: number
      /**
       * Owning `web-*` thread. SPA drops the frame when it does not
       * match the tab's current session (stale get-history after switch).
       */
      threadId?: string
    }
  /**
   * Older transcript chunk, prepended in front of the current messages.
   * Sent nearest-to-tail first so there is never a gap.
   */
  | {
      type: 'history-prepend'
      messages: HistoryMessage[]
      /** Messages still older than this chunk (0 = oldest has arrived). */
      remaining?: number
      threadId?: string
    }
  | { type: 'plan-mode'; enabled: boolean; threadId?: string }
  | { type: 'step-reflect-mode'; enabled: boolean; disabled?: boolean; threadId?: string }
  /** Session /think depth (`auto` | `off` | `high` | `max` | …). */
  | { type: 'think-mode'; variant: string; threadId?: string }
  /** Session `/model` backend override (empty = role default). */
  | { type: 'session-model'; model: string; threadId?: string }
  /** Session `/ctx` compression rate. */
  | { type: 'compact-rate'; rate: string; threadId?: string }
  | { type: 'agents'; agents: string[] }
  | { type: 'agent-switched'; agent: string; preferredWorkerAgent?: string; threadId?: string }
  | { type: 'chunk'; text: string; runId?: string; threadId?: string }
  | { type: 'done'; text: string; runId?: string; messageId?: string; threadId?: string }
  | RunStartEvent
  | RunUsageEvent
  | RunFinishEvent
  | ActivityStepEvent
  | ActiveRunEvent
  | { type: 'injected-context'; runId: string; text: string; threadId?: string }
  | { type: 'error'; message: string; threadId?: string }
  /**
   * Replayed after history when this thread has no ActiveRun snapshot.
   * SPA clears stuck currentReplyId / activeRunId so the pet "Running"
   * badge cannot outlive a factually finished turn.
   */
  | { type: 'active-run-gone'; threadId?: string }
  /** Ack that a mid-turn supplement was persisted / handed to the harness. */
  | { type: 'steer-accepted'; text: string; mode: 'live' | 'queued'; threadId?: string }
  /**
   * Server refused rekey to a foreign threadId (owned by another token).
   * SPA must persist `threadId` and continue — history for the new
   * session follows. Not an `error` (chat stays usable).
   */
  | { type: 'thread-reassigned'; threadId: string; reason: 'ownership_mismatch' }
  /** Ack that a per-Subagent cancel was accepted (activity-step follows). */
  | { type: 'subagent-stopped'; jobId: number; threadId?: string }
  | { type: 'approval-text'; text: string; threadId?: string }
  | { type: 'approval-card'; messageId: string; prompt: ApprovalCardPrompt; threadId?: string }
  | { type: 'approval-card-edit'; messageId: string; outcome: ApprovalCardOutcome; threadId?: string }
  | { type: 'choice-card'; messageId: string; prompt: ChoiceCardPrompt; threadId?: string }
  | { type: 'choice-card-edit'; messageId: string; finalText: string; threadId?: string }
  | { type: 'metrics'; agents: AgentMetric[]; timestamp: string }
  /**
   * Nudge: Loop thread snapshot changed (or reconnect bootstrap).
   * SPA re-fetches GET /api/loop (keeps DTO lang on the client).
   */
  | { type: 'loop-changed'; threadId: string }
  | { type: 'loop-schedule-changed'; threadId: string }
  | { type: 'workspace'; ok: boolean; path: string | null; threadId?: string }

/** Run lifecycle events emitted around each web chat request.
 *  These are additive (old servers may not send them) and let the
 *  mobile UI render an execution timeline rather than only final text. */
export interface RunStartEvent {
  type: 'run-start'
  runId: string
  agent: string
  startedAt: string
  threadId?: string
}

/** Lightweight usage snapshot for a run. For now this is duration +
 *  output size; future server versions may add token counts. */
export interface RunUsageEvent {
  type: 'usage'
  runId: string
  durationMs: number
  outputChars: number
  threadId?: string
}

export interface RunFinishEvent {
  type: 'run-finish'
  runId: string
  status: 'success' | 'error'
  finishedAt: string
  durationMs: number
  error?: string
  threadId?: string
}

/** Live tool / skill step for the in-thread activity accordion (P1). */
export interface ActivityStepEvent {
  type: 'activity-step'
  runId: string
  threadId?: string
  step: {
    id: string
    kind: 'tool' | 'skill' | 'status' | 'approval' | 'ask' | 'agent' | 'reflect'
    label: string
    status: 'pending' | 'running' | 'success' | 'error' | 'denied'
    /** Epoch ms (server may also send ISO — SPA normalizes). */
    startedAt: number | string
    finishedAt?: number | string
    preview?: string
    /** Structured checklist for agim_todo_write (chat Todo UI). */
    todoItems?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
    /** Subagent / A2A inline job id when known. */
    jobId?: number
    reflects?: Array<{ stance: 'keep' | 'adjust' | 'stop'; next: string; at: number }>
    lastTool?: {
      label: string
      status: 'pending' | 'running' | 'success' | 'error' | 'denied'
      at: number
    }
  }
}

/**
 * Snapshot of the thread's current (or recently finished) run, replayed
 * after `history` on reconnect / refresh so the accordion + streaming
 * badge survive tab switches.
 */
export interface ActiveRunEvent {
  type: 'active-run'
  runId: string
  agent: string
  startedAt: string
  status: 'running' | 'success' | 'error'
  steps: ActivityStepEvent['step'][]
  partialText: string
  finishedAt?: string
  durationMs?: number
  error?: string
  /** Prompt injection snapshot for the activity accordion viewer. */
  injectedContext?: string
  threadId?: string
}

/** Mirror of src/core/types.ts:ApprovalCardPrompt — the structured
 *  body of an approval-card message. v1 rendered toolName + inputJson
 *  in distinct slots; v2 does the same. */
export interface ApprovalCardPrompt {
  /** Bus-side request id; embedded in callback_data so the button click
   *  can address the right pending approval. Treat as opaque. */
  reqId: string
  toolName: string
  /** Stringified input, already display-capped server-side. */
  inputJson: string
  /** `normal` = ask user with remember option; `explicit` = one-time human
   *  decision; `auto-allow` = grace window before automatic allow. */
  mode: 'normal' | 'explicit' | 'auto-allow'
  /** With `mode: 'explicit'`, show "Auto for similar" (session pin). */
  canPin?: boolean
  /** Auto-allow grace window in seconds, present iff mode = `auto-allow`. */
  graceSeconds?: number
  /** Agent that requested the tool (parent or Subagent). */
  callerAgent?: string
  /** Nested call depth; >0 means a Subagent / A2A callee. */
  callDepth?: number
  /** Preformatted origin label for UI (e.g. "Subagent · agim"). */
  originLabel?: string
}

/** Mirror of src/core/types.ts:ApprovalCardOutcome — five decisions
 *  distinguish "allowed + pinned for the rest of session" and "denied,
 *  also revoked an existing auto-allow rule" from the basic
 *  allow/deny/timeout triplet. */
export interface ApprovalCardOutcome {
  decision:
    | 'allowed'
    | 'allowed-pinned'
    | 'denied'
    | 'denied-revoked'
    | 'expired'
  /** "@user" or first name of the human who decided, if known. */
  byUserDisplay?: string
  /** ISO date — server stringifies the core `atDate: Date` field. */
  atDate?: string
}

/** Mirror of src/core/types.ts:ChoiceCardPrompt — the structured body of
 *  an ask_user `choice-card` message. The server sends the prompt verbatim;
 *  `meta` carries everything the client needs to render single/multi/custom
 *  modes and to construct the `ask:` callback `data` on submit. */
export interface ChoiceCardPrompt {
  /** Optional bold title rendered above the body. */
  title?: string
  /** The question text. */
  body: string
  /** 1-indexed choices. `label` is "1. Foo" style (already prefixed by the
   *  server); `data` is the ready-to-send single-select callback
   *  `ask:<reqId>:<index>`. */
  choices: Array<{ label: string; data: string }>
  /** Optional non-action links (e.g. "📖 查看详情") rendered as anchors
   *  under the choices — context the decision depends on. */
  links?: Array<{ label: string; url: string }>
  /** ask_user rendering hints. Present for `kind === 'ask-user'` cards. */
  meta?: ChoiceCardMeta
}

export interface ChoiceCardMeta {
  kind: 'ask-user'
  /** Bus-side request id; needed to build multi/custom callback data. */
  reqId: string
  selectionMode: 'single' | 'multi'
  /** multi-select lower/upper bounds (both 1 for single). */
  minSelections: number
  maxSelections: number
  /** When true, render a free-form text input in addition to the choices. */
  allowCustomInput: boolean
  /** Display label for the custom-input entry. */
  customInputLabel: string
  /** Seconds the agent will wait before the ask times out. */
  timeoutSec: number
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
  /** Durable server message id when present. */
  id?: string
  agent?: string
  /** Restored thumbs vote from feedback sidecar. */
  feedback?: 'up' | 'down'
  /** Persisted tool/run accordion; restored on refresh / reconnect. */
  activity?: {
    runId: string
    status: 'running' | 'success' | 'error'
    startedAt: number
    finishedAt?: number
    durationMs?: number
    error?: string
    injectedContext?: string
    steps: ActivityStepEvent['step'][]
  }
  /** Absolute index in durable `session.messages` (feedback fallback). */
  serverIndex?: number
}

export interface AgentMetric {
  agent: string
  total: number
  success: number
  failure: number
  p50Ms?: number
  p95Ms?: number
  p99Ms?: number
}
