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
  | { type: 'approval-card'; messageId: string; prompt: string }
  | { type: 'approval-card-edit'; messageId: string; outcome: 'allow' | 'deny' | 'timeout' }
  | { type: 'metrics'; agents: AgentMetric[]; timestamp: string }

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
