/**
 * chat-types.ts — shared type declarations and constants for the chat subsystem.
 *
 * Extracted from use-chat.ts to allow the reducer, WS handlers, and hook
 * to import a single source of truth without circular deps.
 */

import type { WsStatus } from '@/lib/api/ws'
import type { WebSessionEntry } from '@/lib/web-sessions'
import type { ApprovalCardOutcome, ApprovalCardPrompt, ChoiceCardPrompt } from '@/types/ws'

/** How long a resolved approval/ask card lingers in the dock before auto-dismiss. */
export const APPROVAL_DISMISS_AFTER_MS = 1200

export type MessageRole = 'user' | 'assistant' | 'system'

/** Three click outcomes the chat surface sends back. Maps 1:1 to the
 *  callback_data trailing letter that approval-router expects:
 *    `y` → allow
 *    `n` → deny
 *    `a` → allow + auto-allow further (the "Auto for similar" button) */
export type ApprovalChoice = 'y' | 'n' | 'a'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  agent?: string
  timestamp: number
  /** In-thread run accordion (tool/approval steps) for this assistant turn. */
  activity?: ChatActivity
  /** Thumbs vote restored from server sidecar / local submit. */
  feedback?: 'up' | 'down'
  /**
   * Index into durable `session.messages` when known (from HISTORY).
   * Used as feedback API fallback for legacy rows without server ids.
   */
  serverIndex?: number
  /** Approval cards land here as a system message with embedded data.
   *  `prompt` is the full structured payload from the server (toolName,
   *  inputJson, mode, graceSeconds, reqId). `text` is a plain string
   *  used for the legacy approval-text fallback path. */
  approval?: {
    messageId: string
    prompt?: ApprovalCardPrompt
    /** Legacy `approval-text` body (no buttons, no tool input). */
    text?: string
    outcome?: ApprovalCardOutcome
  }
}

/** One step inside a ChatActivity accordion (tool / approval / ask). */
export interface ChatActivityStep {
  id: string
  kind: 'tool' | 'approval' | 'ask' | 'skill' | 'status' | 'agent' | 'reflect'
  label: string
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  startedAt: number
  finishedAt?: number
  preview?: string
  /** Structured checklist when this step is agim_todo_write. */
  todoItems?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
  /** Subagent / A2A inline job id when known. */
  jobId?: number
  /** Step Reflect carousel on a same-family Agim Subagent row. */
  reflects?: Array<{ stance: 'keep' | 'adjust' | 'stop'; next: string; at: number }>
}

/** Cursor-style "Worked ›" block bound to an assistant reply. */
export interface ChatActivity {
  runId: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  outputChars?: number
  error?: string
  steps: ChatActivityStep[]
}

/**
 * v1.2.115 — approval cards moved out of the chat message stream into a
 * floating dock above the input. PendingApproval is the dock's row
 * shape: messageId + prompt + optional outcome (set when the server's
 * approval-card-edit lands; triggers a toast and a brief auto-dismiss).
 */
export interface PendingApproval {
  messageId: string
  prompt: ApprovalCardPrompt
  /** Set when the bus resolves. Holding the outcome briefly (vs
   *  immediate removal) gives the user a visible state flip
   *  (✅/❌/⏱) before the row fades. */
  outcome?: ApprovalCardOutcome
  /** Bookkeeping for the timed dismiss. Optional — managed in the
   *  reducer's APPROVAL_EDIT branch via setTimeout. */
  resolvedAt?: number
}

/**
 * ask_user (choice) cards share the approval dock's lifecycle: shown while
 * pending, briefly flipped to a resolved state, then auto-dismissed. Unlike
 * approvals, the resolution carries a short `finalText` receipt rather than a
 * structured outcome.
 */
export interface PendingAsk {
  messageId: string
  prompt: ChoiceCardPrompt
  /** Set when the bus resolves (answer accepted, or timed out). Holding it
   *  briefly gives the user a visible "已发送 / 已失效" flip before the row
   *  fades. */
  finalText?: string
  resolvedAt?: number
}

export interface RunActivity {
  runId: string
  agent: string
  startedAt: number
  status: 'running' | 'success' | 'error'
  finishedAt?: number
  durationMs?: number
  outputChars?: number
  error?: string
}

export interface ChatState {
  messages: ChatMessage[]
  /** Active approval cards rendered in the dock (NOT in `messages`).
   *  v1.2.115 — previously approvals lived inline as system messages,
   *  but resolved cards lingered in history clutter. Dock approach:
   *  show only while pending → toast on resolve → dismiss. */
  pendingApprovals: PendingApproval[]
  /** Active ask_user (choice) cards rendered in the dock alongside
   *  approvals. Same show-while-pending → flip → dismiss lifecycle. */
  pendingAsks: PendingAsk[]
  /** Timeline rows for recent run lifecycle updates (run-start →
   *  usage → run-finish). Newest first, bounded list. */
  runActivities: RunActivity[]
  /** Current in-flight run id, if any. */
  activeRunId: string | null
  agents: string[]
  agent: string                  // currently selected
  /** Preferred Loop Subagent while Agim is parent (e.g. codex). */
  preferredWorkerAgent: string
  status: WsStatus
  /** When non-null, an assistant message is being streamed; chunks
   *  accumulate into messages[currentReplyId].content. */
  currentReplyId: string | null
  error: string | null
  /** Live session plan-mode flag (from history / plan-mode events). */
  planMode: boolean
  /** Live session Step Reflect flag (from history / step-reflect-mode). */
  stepReflect: boolean
  /** Ops kill switch AGIM_STEP_REFLECT=disabled — hide the composer chip. */
  stepReflectDisabled: boolean
  /** Live session /think variant (from history / think-mode events). */
  thinkVariant: string
  /** Live session `/model` backend name (empty = native-chat role default). */
  sessionModel: string
  /** Live session `/ctx` compression rate (`auto` | `full` | `balanced` | `frequent`). */
  compactRate: string
  /** WebSocket thread id (web-…). Used for media upload subdir. */
  clientId: string | null
  /**
   * Last applied **server** history revision (session `lastActivity` /
   * last message time, epoch ms). Compared with the next `history.updatedAt`
   * so a localStorage snapshot is not treated as fresh when the cloud
   * transcript moved forward on another device / tab.
   */
  historyRevisionAt: number | null
}

export interface UseChat {
  state: ChatState
  send: (text: string) => void
  /** Inject a mid-turn supplement into the live Agim run (no new placeholder). */
  steer: (text: string) => void
  /** Abort the in-flight web run (composer Stop button). */
  stop: () => void
  /** Cancel one live Subagent/A2A job; parent turn continues with partial. */
  stopSubagent: (jobId: number) => boolean
  switchAgent: (name: string) => void
  /** Approval card button click. The hook composes the
   *  `apv:<reqId>:<y|n|a>` callback_data that approval-router expects;
   *  callers only pass the messageId + reqId + the user's choice.
   *  Returns whether the WS send actually went out — false means the
   *  socket was reconnecting and the click should be re-tried. The
   *  hook also dispatches an ERROR for the chat surface to render. */
  approvalClick: (messageId: string, reqId: string, choice: ApprovalChoice) => boolean
  /** ask_user (choice) card answer. `data` is the fully-formed
   *  `ask:<reqId>:…` callback the AskDock built (single/multi/custom).
   *  Returns whether the WS send went out; on success the hook
   *  optimistically resolves + dismisses the dock row, since the bus
   *  doesn't push a card edit back for asks. */
  choiceSubmit: (messageId: string, data: string) => boolean
  /** Mint a new `web-*` thread (previous sessions stay in the rail).
   *  Loads empty history via `get-history` — does not wipe the old log. */
  newConversation: () => void
  /** Reload a previously opened thread via `get-history`. */
  switchSession: (threadId: string) => void
  /** Newest-first index of this browser's web threads. */
  sessions: WebSessionEntry[]
  /** Active `web-*` id (same as `state.clientId` once bootstrapped). */
  activeSessionId: string
  clearError: () => void
}
