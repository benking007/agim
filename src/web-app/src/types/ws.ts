/**
 * types/ws.ts — typed messages on the /ws WebSocket.
 *
 * Wire shape source: src/web/server.ts handleClientMessage() +
 * sendToClient() calls. Discriminated unions so the chat reducer can
 * switch on `msg.type` with exhaustive checks.
 *
 * Note: this is the SPA-side schema. If the backend gains a new
 * server→client type we add it here + the reducer; an unknown type
 * is logged + dropped (silently).
 */

/** Client → Server */
export type ChatOutgoing =
  | { type: 'message'; text: string; agent?: string }
  | { type: 'switch-agent'; agent: string }
  | { type: 'get-agents' }
  | { type: 'get-history'; threadId?: string }
  /** Clear messages + per-agent CLI bindings + auto-allow rules. The
   *  server replies with an empty `history` so the UI repaints clear. */
  | { type: 'new-conversation' }
  /** Abort the in-flight web chat run for this thread (Stop button). */
  | { type: 'stop' }
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
  | { type: 'history'; messages: HistoryMessage[]; agent: string; planMode?: boolean; thinkVariant?: string }
  | { type: 'plan-mode'; enabled: boolean }
  /** Session /think depth (`auto` | `off` | `high` | `max` | …). */
  | { type: 'think-mode'; variant: string }
  | { type: 'agents'; agents: string[] }
  | { type: 'agent-switched'; agent: string }
  | { type: 'chunk'; text: string; runId?: string }
  | { type: 'done'; text: string; runId?: string }
  | RunStartEvent
  | RunUsageEvent
  | RunFinishEvent
  | ActivityStepEvent
  | ActiveRunEvent
  | { type: 'error'; message: string }
  | { type: 'approval-text'; text: string }
  | { type: 'approval-card'; messageId: string; prompt: ApprovalCardPrompt }
  | { type: 'approval-card-edit'; messageId: string; outcome: ApprovalCardOutcome }
  | { type: 'choice-card'; messageId: string; prompt: ChoiceCardPrompt }
  | { type: 'choice-card-edit'; messageId: string; finalText: string }
  | { type: 'metrics'; agents: AgentMetric[]; timestamp: string }

/** Run lifecycle events emitted around each web chat request.
 *  These are additive (old servers may not send them) and let the
 *  mobile UI render an execution timeline rather than only final text. */
export interface RunStartEvent {
  type: 'run-start'
  runId: string
  agent: string
  startedAt: string
}

/** Lightweight usage snapshot for a run. For now this is duration +
 *  output size; future server versions may add token counts. */
export interface RunUsageEvent {
  type: 'usage'
  runId: string
  durationMs: number
  outputChars: number
}

export interface RunFinishEvent {
  type: 'run-finish'
  runId: string
  status: 'success' | 'error'
  finishedAt: string
  durationMs: number
  error?: string
}

/** Live tool / skill step for the in-thread activity accordion (P1). */
export interface ActivityStepEvent {
  type: 'activity-step'
  runId: string
  step: {
    id: string
    kind: 'tool' | 'skill' | 'status' | 'approval' | 'ask' | 'agent'
    label: string
    status: 'pending' | 'running' | 'success' | 'error' | 'denied'
    /** Epoch ms (server may also send ISO — SPA normalizes). */
    startedAt: number | string
    finishedAt?: number | string
    preview?: string
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
  /** Auto-allow grace window in seconds, present iff mode = `auto-allow`. */
  graceSeconds?: number
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
  agent?: string
  /** Persisted tool/run accordion; restored on refresh / reconnect. */
  activity?: {
    runId: string
    status: 'running' | 'success' | 'error'
    startedAt: number
    finishedAt?: number
    durationMs?: number
    error?: string
    steps: ActivityStepEvent['step'][]
  }
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
