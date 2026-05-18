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
  | { type: 'get-history' }
  /** Clear messages + per-agent CLI bindings + auto-allow rules. The
   *  server replies with an empty `history` so the UI repaints clear. */
  | { type: 'new-conversation' }
  /** Approval card button click. `data` MUST be the
   *  `apv:<reqId>:<y|n|a>` callback_data that approval-router's
   *  `parseCallbackData` expects — v2 routes it through unchanged. */
  | { type: 'approval-action'; data: string; messageId: string }

/** Server → Client */
export type ChatIncoming =
  | { type: 'init'; agents: string[]; defaultAgent: string; clientId: string }
  | { type: 'history'; messages: HistoryMessage[]; agent: string }
  | { type: 'agents'; agents: string[] }
  | { type: 'agent-switched'; agent: string }
  | { type: 'chunk'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }
  | { type: 'approval-text'; text: string }
  | { type: 'approval-card'; messageId: string; prompt: ApprovalCardPrompt }
  | { type: 'approval-card-edit'; messageId: string; outcome: ApprovalCardOutcome }
  | { type: 'metrics'; agents: AgentMetric[]; timestamp: string }

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
  /** `normal` = ask user; `auto-allow` = grace window before automatic
   *  allow (only the deny button is meaningful in that mode). */
  mode: 'normal' | 'auto-allow'
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

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
  agent?: string
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
