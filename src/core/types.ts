// agim core types

import type { Logger } from 'pino'

/**
 * Message received from a messenger platform
 */
export interface Message {
  id: string
  threadId: string
  userId: string
  text: string
  timestamp: Date
  channelId: string
}

/**
 * Chat message for conversation history
 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  /**
   * Durable message id (minted on append). Used by thumbs up/down sidecar
   * and SPA restore; optional on legacy JSONL rows written before ids existed.
   */
  id?: string
  /** Sticky agent label for web history replay (optional). */
  agent?: string
  /**
   * Web chat tool/run accordion snapshot. Persisted so refresh / tab
   * switch can restore every turn's activity — not only the latest
   * in-memory ActiveRun.
   */
  activity?: PersistedChatActivity
}

/** Durable copy of the web chat activity accordion (epoch-ms timestamps). */
export interface PersistedChatActivity {
  runId: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  error?: string
  /**
   * Wire-only prompt injection snapshot for this turn (system + ephemeral
   * headers). Shown in the activity accordion; not part of chat history.
   */
  injectedContext?: string
  steps: Array<{
    id: string
    kind: 'tool' | 'skill' | 'status' | 'approval' | 'ask' | 'agent' | 'reflect'
    label: string
    status: 'pending' | 'running' | 'success' | 'error' | 'denied'
    startedAt: number
    finishedAt?: number
    preview?: string
    /** Structured checklist when label is agim_todo_write (chat Todo UI). */
    todoItems?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
    /** Step Reflect carousel on a Subagent (`kind: 'agent'`) row. */
    reflects?: Array<{ stance: 'keep' | 'adjust' | 'stop'; next: string; at: number }>
    /** Latest child tool/skill on a Subagent row (not a parent accordion row). */
    lastTool?: {
      label: string
      status: 'pending' | 'running' | 'success' | 'error' | 'denied'
      at: number
    }
  }>
}

/**
 * Discriminated union for parsed messages
 * Each variant has a unique `type` field for type-safe pattern matching
 */
export type ParsedMessage =
  | { type: 'default'; prompt: string }
  | { type: 'command'; command: 'start' | 'help' | 'agents' | 'new'; args?: string }
  | { type: 'agentCommand'; command: string; prompt: string }
  | { type: 'agent'; agent: string; prompt: string }
  | { type: 'audit'; args: string }
  | { type: 'router'; args: string }
  | { type: 'workspaces'; args: string }
  | { type: 'cron'; args: string; legacy?: boolean }
  | { type: 'remind'; args: string }
  | { type: 'memo'; args: string }
  | { type: 'heartbeat'; args: string }
  | { type: 'focus'; args: string }
  | { type: 'loop'; args: string }
  | { type: 'cronloop'; args: string }
  | { type: 'skill'; args: string }
  | { type: 'job'; args: string }
  | { type: 'outbox'; args: string }
  | { type: 'a2a'; args: string }
  | { type: 'model'; args: string }
  | { type: 'think'; args: string }
  | { type: 'ctx'; args: string }
  | { type: 'stats'; args: string }
  | { type: 'sessions'; args: string }
  | { type: 'approval'; args: string }
  | { type: 'plan'; args: string }
  | { type: 'step-reflect'; args: string }
  | { type: 'service'; action: 'restart' | 'stop' | 'status'; args: string }
  | { type: 'setup'; args: string }
  | { type: 'web'; args: string }
  | { type: 'coord'; system: 'wgs84' | 'gcj02' | 'bd09' }
  // Batch 2 (#2) — abort the currently-running agent run on this thread.
  // Distinct from { type: 'service', action: 'stop' } which stops the
  // whole agim daemon. Triggered by `/stop`, `停止`, `中止`, `esc`.
  | { type: 'stopAgent' }
  // Batch 2 (#5) — bypass the per-thread queue and dispatch a one-shot
  // sub-thread run for a quick parallel question. Triggered by `/btw …`.
  | { type: 'btw'; prompt: string }
  | { type: 'error'; prompt: string; error: string }

/**
 * Message context passed through the processing pipeline
 */
export interface MessageContext {
  message: Message
  platform: string
  channelId: string
  agent?: string
  session?: Session
  /** Unique trace id generated at message ingestion */
  traceId?: string
  /** Child logger bound to this request's traceId */
  logger?: Logger
  /** Phase 3 recovery hand-off: when the cli intercepts a retry reply
   *  ("1") for an interrupted job, it pre-creates the replacement inline
   *  job row (so replaced_by can be stamped immediately) and stashes the
   *  new id here. handleMessage sees this and skips its own createInlineJob
   *  so the row machinery doesn't double-count. -1 / undefined = no
   *  hand-off; handleMessage takes the normal path. */
  inlineJobId?: number
}

/**
 * Session state for a conversation
 * Keyed by `${platform}:${channelId}:${threadId}` for uniqueness
 */
export interface Session {
  id: string
  channelId: string
  threadId: string
  platform: string
  agent: string
  /**
   * Preferred Loop Subagent / worker (usually a CLI like `codex`).
   * Agim remains the Loop parent; this steers `call_agents` task.agent.
   * Updated when the user picks a non-Agim sticky agent, or when switching
   * that CLI → Agim. Cleared by /new.
   */
  preferredWorkerAgent?: string
  createdAt: Date
  lastActivity: Date
  ttl: number
  messages: ChatMessage[]
  /** Current model (provider/model format) */
  model?: string
  /** Thinking depth variant */
  variant?: string
  /**
   * Session-scoped compression rate (压缩率): auto | full | balanced | frequent.
   * Omitted / auto = window-scaled global defaults. Cleared by /new.
   */
  compactRate?: 'auto' | 'full' | 'balanced' | 'frequent'
  /** Per-session usage roll-up. Updated by callAgentWithHistory after every
   *  successful agent invocation. Persisted with the session metadata so
   *  /stats survives restart. */
  usage?: SessionUsage
  /** Active subtask id for /switch routing */
  activeSubtaskId?: number | null
  subtasks?: SubtaskMeta[]
  subtaskCounter?: number
  /** UUID we pre-allocate for the claude-code adapter so multiple turns in
   *  the same agim conversation share one resumable claude session
   *  (`claude --resume <uuid>`). Persists across restarts. */
  claudeSessionId?: string
  /** Set to true after the first successful claude-code run on this session.
   *  cli uses it to decide between `--session-id` (fresh, allowed once) and
   *  `--resume` (subsequent turns). Cleared by /new. */
  claudeSessionPrimed?: boolean
  /** opencode session id (`ses_…`) discovered from opencode's first JSON event
   *  on a fresh run. Subsequent turns pass `--session <id>` so opencode
   *  resumes the same conversation from its own DB and agim no longer needs
   *  to stitch the history into the prompt. Cleared by /new. */
  opencodeSessionId?: string
  /** codex thread id (UUID) discovered from codex's `thread.started` event on
   *  a fresh run. Subsequent turns spawn `codex exec resume <id> …` so codex
   *  continues the same session from its own ~/.codex/sessions store. Cleared
   *  by /new. */
  codexSessionId?: string
  /** Antigravity (Google `agy`) conversation UUID discovered from
   *  ~/.gemini/antigravity-cli/conversations/<uuid>.pb the CLI writes
   *  after the first turn. Subsequent calls pass `--conversation <uuid>`
   *  so we continue the same session and history. Cleared by /new. */
  antigravitySessionId?: string
  /** Kimi Code session id discovered from ~/.kimi-code/session_index.jsonl
   *  after the first `kimi -p` run (or surfaced in stream events when the CLI
   *  includes it). Subsequent calls pass `--session <id>`. Cleared by /new. */
  kimiSessionId?: string
  /** Qoder CLI session id surfaced in stream-json events. Subsequent turns
   *  pass `--resume <id>` so Qoder continues the same conversation from its
   *  own session store. Cleared by /new. */
  qoderSessionId?: string
  /** PI session id surfaced in JSON mode's first `session` event. Subsequent
   *  turns pass `--session <id>` so PI resumes the same session from its
   *  own session store. Cleared by /new. */
  piSessionId?: string
  /** MiMo Code session id surfaced in JSON events. Subsequent turns pass
   *  `--session <id>` so MiMo resumes the same session from its own store.
   *  Cleared by /new. */
  mimoSessionId?: string
  /** GitHub Copilot CLI session UUID preallocated by Agim and passed via
   *  `--session-id <uuid>`. Cleared by /new. */
  copilotSessionId?: string
  /** Cursor (`cursor-agent`) chat id surfaced from stream-json
   *  `system.init.session_id`. Subsequent turns pass `--resume <id>`.
   *  Cleared by /new. */
  cursorSessionId?: string
  /**
   * Portal workspace directory for this web thread. Absolute path the
   * agent should use as cwd. Omitted = default agent workspace.
   */
  workspacePath?: string
  /** Plan mode flag — toggled by /plan on / /plan off. When true:
   *    • claude-code adapter spawns with `--permission-mode plan` and bypasses
   *      the IM approval bus (plan mode is read-only, no mutations to gate).
   *    • opencode adapter routes through the built-in `plan` agent and skips
   *      the medium-gate ruleset PATCH (plan agent's deny-edit policy is
   *      already stricter than the IM gate).
   *  Persists across turns and `/oc`↔`/cc` agent switches; cleared by /new. */
  planMode?: boolean
  /** 执行过程 — DeepSeek-style per-hop think-then-act. Default on.
   *  /step-reflect on|off still persists a per-session override. Cleared by /new. */
  stepReflect?: boolean
}

export interface SessionUsage {
  turns: number
  costUsd: number
  tokensInput?: number
  tokensOutput?: number
  unknownCostTurns?: number
  promptChars: number
  responseChars: number
  durationMsTotal: number
  /** ISO string of first invocation */
  startedAt: string
}

/** Lightweight subtask metadata stored in parent session */
export interface SubtaskMeta {
  id: number
  agent: string
  prompt: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  result?: string
  createdAt: Date
  completedAt?: Date
}

/**
 * Adapter interface for messenger platforms (WeChat, Feishu, Telegram)
 */
export interface MessengerAdapter {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (ctx: MessageContext) => Promise<void>): void
  sendMessage(threadId: string, text: string): Promise<void>
  /**
   * Send typing indicator to show the bot is processing
   * @param threadId - The conversation thread ID
   * @param isTyping - true to start typing indicator, false to stop
   */
  sendTyping?(threadId: string, isTyping: boolean): Promise<void>
  /**
   * Send an interactive card (Feishu only)
   * @param threadId - The conversation thread ID
   * @param card - The card JSON object
   */
  sendCard?(threadId: string, card: unknown): Promise<void>
  /**
   * Send a "thinking" placeholder message (e.g. 🤔 思考中…) and return a
   * dismiss handle. Adapters that can delete or update their own messages
   * (Feishu) should return a callable that removes the placeholder before
   * the real response is sent. Adapters that cannot recall (WeChat iLink)
   * should still send the placeholder and return undefined — the placeholder
   * lingers in the chat but at least gives the user immediate feedback.
   * Adapters that prefer their native typing indicator can omit this method.
   */
  sendThinking?(threadId: string, text: string): Promise<ThinkingHandle | undefined>
  /**
   * Subscribe to inline-button (callback_query) events. Adapters that support
   * native interactive buttons (Telegram inline keyboard, Feishu card actions
   * once we wire them) call the handler when a user taps a button. Adapters
   * without native button support simply omit this method — approval-router
   * falls back to its text/y-n flow.
   *
   * Idempotent: re-registering replaces the previous handler.
   */
  onButtonCallback?(handler: (cb: ButtonCallback) => Promise<void>): void
  /**
   * Send an approval prompt as a rich card with action buttons. When this
   * method is implemented, approval-router prefers it over plain
   * sendMessage. The returned messageId is later passed to editApprovalCard
   * so the card can be replaced with the outcome (✅ / ❌ / ⏱).
   *
   * Adapters that don't implement this fall back to sendMessage(text) — the
   * text path remains the canonical approval channel for Feishu / WeChat /
   * any IM that doesn't have native button support.
   */
  sendApprovalCard?(threadId: string, prompt: ApprovalCardPrompt): Promise<{ messageId: string }>
  /**
   * Replace the body of an approval card after the request has been resolved
   * (allowed / denied / timed out). Best-effort: failure is logged and
   * swallowed by the router, since the underlying approval has already
   * resolved on the bus side.
   */
  editApprovalCard?(threadId: string, messageId: string, outcome: ApprovalCardOutcome): Promise<void>
  /**
   * v1.2 — generic choice card: a short prompt body + 1-3 action buttons.
   * Used for confirm flows that aren't full tool-use approvals (e.g. job
   * recovery "重发 / 取消", reminder snooze list, /memo confirm).
   *
   * `prompt.choices[*].data` is opaque to the adapter; consumers parse it
   * out of ButtonCallback.data inside their onButtonCallback handler.
   * Adapters that have native inline buttons (Telegram / Discord / Feishu)
   * SHOULD implement this; adapters that don't (WeChat-iLink, DingTalk
   * text-mode) may omit it and the caller falls back to plain text with
   * "回 1 / 回 2" instructions.
   */
  sendChoiceCard?(threadId: string, prompt: ChoiceCardPrompt): Promise<{ messageId: string }>
  /**
   * Replace a choice card's body after a button has been tapped (or the
   * card has otherwise expired). Mirrors editApprovalCard. Best-effort.
   * Strips the buttons (terminal state).
   */
  editChoiceCard?(threadId: string, messageId: string, finalText: string): Promise<void>
  /**
   * Re-render a choice card IN PLACE keeping its buttons — body + inline
   * keyboard are rebuilt from `prompt`. Distinct from editChoiceCard, which
   * clears the keyboard for a terminal state. Used for stateful interactions
   * such as multi-select checkmark toggling on Telegram, where each tap edits
   * the keyboard without resolving the ask. Adapters that implement this
   * advertise "server-side stateful card" support (see ask-user-rpc's
   * canSendChoiceCard gate). Best-effort.
   */
  updateChoiceCard?(threadId: string, messageId: string, prompt: ChoiceCardPrompt): Promise<void>
}

/**
 * Inline-button tap event surfaced by adapters that implement
 * onButtonCallback. The data field is opaque to the adapter; consumers
 * (approval-router, future button consumers) parse it.
 *
 * ack MUST be called within ~1s on Telegram or the client shows a stuck
 * "loading" spinner — adapters wrap their platform-native ack so callers
 * can stay platform-agnostic.
 */
export interface ButtonCallback {
  /** Raw callback_data string (Telegram caps at 64 bytes UTF-8). */
  data: string
  threadId: string
  userId: string
  /** Display name for the user who tapped (e.g. "@benking" or first_name).
   *  Used for "已批准 by @benking" rendering. Optional — adapters that
   *  can't easily resolve a display name should leave it undefined. */
  userDisplay?: string
  /** ID of the message that owned the button — passed back to
   *  editApprovalCard for in-place updates. */
  messageId: string
  /** Acknowledge the button tap to the platform. Optional toast text
   *  (Telegram shows it briefly above the chat). Errors are swallowed. */
  ack: (text?: string) => Promise<void>
}

/**
 * Payload handed to sendApprovalCard. inputJson is already truncated to a
 * display-safe length by the caller (router) — adapters should render it
 * as-is in a code block.
 */
export interface ApprovalCardPrompt {
  /** Bus-side request id; embedded in callback_data so the button click
   *  knows which approval to resolve. Adapters must not depend on its
   *  internal format. */
  reqId: string
  toolName: string
  /** Stringified input, already length-capped. May contain newlines. */
  inputJson: string
  /** 'normal' = ask user with optional remember action; 'explicit' = one-time
   *  human decision only; 'auto-allow' = grace window before automatic allow
   *  (only the deny button is meaningful). */
  mode: 'normal' | 'explicit' | 'auto-allow'
  /** When true with `mode: 'explicit'`, still show "Auto for similar" so the
   *  operator can pin a per-thread remembered rule (unconfined agim_exec). */
  canPin?: boolean
  /** Auto-allow grace window in seconds, present iff mode === 'auto-allow'. */
  graceSeconds?: number
  /** Agent that requested the tool (parent or Subagent). */
  callerAgent?: string
  /** Nested call depth; >0 means a Subagent / A2A callee. */
  callDepth?: number
  /** Preformatted origin label for UI (e.g. "Subagent · agim/cheap"). */
  originLabel?: string
}

/**
 * Generic choice-card prompt. The card renders `body` (and optional `title`)
 * with one button per `choices` entry. When the user taps, the adapter fires
 * an onButtonCallback event with `data` set to the matching choice's `data`
 * — the caller parses that to figure out what to do.
 *
 * Total UTF-8 byte length of any `data` MUST stay under 64 (Telegram cap).
 * Adapters that round-trip via JSON-RPC may have stricter limits — pick a
 * compact discriminator like `rec:JOB_ID:y` or `snz:REM_ID:5m`.
 */
export interface ChoiceCardPrompt {
  /** Optional title rendered above the body (bold / header style per platform). */
  title?: string
  /** Body text. May contain newlines. Platform may sanitize HTML / markdown. */
  body: string
  /** 1-3 buttons (rows). Each row holds 1-2 buttons depending on platform. */
  choices: Array<{ label: string; data: string }>
  /**
   * Optional non-action links rendered alongside the choices (e.g. a
   * "📖 查看详情" entry pointing at context the decision depends on). On
   * Telegram these become inline URL buttons; on web an anchor; adapters
   * that can't render links may show them as a text line or ignore them.
   */
  links?: Array<{ label: string; url: string }>
  /**
   * Optional opaque metadata for adapter-specific rendering. Callers should
   * treat this as best-effort hinting; adapters that don't understand it
   * must ignore it and rely on title/body/choices only.
   */
  meta?: Record<string, unknown>
}

/**
 * Outcome rendered into a card after the approval is resolved. The card's
 * action buttons are removed during this edit so the user can no longer
 * tap a stale button.
 */
export interface ApprovalCardOutcome {
  decision:
    | 'allowed'           // user said yes
    | 'allowed-pinned'    // user said yes + auto-allow this kind in session
    | 'denied'            // user said no
    | 'denied-revoked'    // user said no while a previous auto-allow rule was in effect
    | 'expired'           // approval-bus timed out before any decision
  /** "@user" or first name of the human who decided, if known. */
  byUserDisplay?: string
  atDate: Date
}

/** Optional callback returned by sendThinking; invoked once the real response
 *  is ready, to remove or otherwise hide the placeholder. */
export type ThinkingHandle = () => Promise<void>

export interface AgentTurnOutcome {
  status: 'success' | 'partial' | 'aborted' | 'timeout' | 'error'
  /** True only when provider health should affect the circuit breaker. User
   *  cancellation, policy denial, and local watchdog expiry are neutral. */
  providerFailure?: boolean
  error?: string
  /** Guard / terminal stop code when known (e.g. stuck_loop, length, max_iter). */
  stopReason?: string
  /** Provider/model turns observed this run (before_provider_request count). */
  modelTurns?: number
  /** Tool calls that passed preflight and were dispatched. */
  toolCalls?: number
  /** Auxiliary model calls observed this run (goal critic, compaction estimate). */
  auxModelCalls?: number
  /** Aggregated usage when available (main loop + observed aux). */
  usage?: {
    tokensInput?: number
    tokensOutput?: number
    costUsd?: number
  }
  /** Agim Agent context-budget activity for this turn (omitted when idle). */
  contextBudget?: {
    /** L1 tool-result clearing applications (includes emergency). */
    clearCount: number
    /** Subset of clears that used the emergency keep≤2 path. */
    emergencyClearCount: number
    /** Successful L2 transcript compactions (pre-turn + mid-turn). */
    compactSuccess: number
    /** Compaction attempts that threw / timed out (turn still continues). */
    compactFail: number
    /** tokensBefore from the last successful compaction this turn. */
    tokensBefore?: number
  }
}

/**
 * Optional per-call context piped from the IM router into the agent. Lets
 * adapters (e.g. ClaudeCodeAdapter) route side-channel events back to the
 * originating IM conversation — for instance, permission prompts surfaced
 * via approval-bus.
 *
 * All fields optional so non-IM call sites (web, scheduler, intent-llm) can
 * keep calling sendPrompt without adornment.
 */
export interface AgentSendOpts {
  model?: string
  variant?: string
  threadId?: string
  platform?: string
  userId?: string
  channelId?: string
  /** Portal / web workspace directory. Beats the IM default cwd. */
  workspacePath?: string
  /**
   * Session-scoped compression rate overlay for Agim Agent context budget.
   * `auto` / omitted → env + window defaults; otherwise replaces reserve/keep.
   */
  compactRate?: 'auto' | 'full' | 'balanced' | 'frequent'
  /** Request-only context (goal/persona/reminders/viewer hints). Adapters that
   *  support it inject this at provider context time without persisting it as
   *  part of the user's durable message. */
  ephemeralContext?: string
  /** Optional UUID to bind to the agent's own resumable-session concept.
   *  Currently honoured by the claude-code adapter (passed as
   *  `--session-id` for first call, `--resume` for subsequent calls) so
   *  multi-turn IM conversations share one resumable claude session and
   *  the user can later `claude --resume <uuid>` to continue from their
   *  terminal. Other adapters ignore this. */
  agentSessionId?: string
  /** When true, the adapter should resume an existing session under
   *  `agentSessionId` rather than create a new one. claude-code translates
   *  this to `--resume <uuid>` instead of `--session-id <uuid>`. */
  agentSessionResume?: boolean
  /** Optional one-shot callback for adapters whose CLI generates the session
   *  id itself (rather than letting agim pre-allocate). opencode emits
   *  `sessionID` in every JSON event; the adapter calls this when it sees
   *  the id so cli can persist it on the agim session row for next turn.
   *  Idempotent: same id may fire multiple times per spawn. */
  onAgentSessionId?: (id: string) => void
  /** Optional callback for adapters that surface usage data inline (cost +
   *  tokens). opencode's `step_finish` event carries this; cli accumulates
   *  the deltas to feed `recordUsage` so /stats reflects opencode cost. */
  onUsage?: (delta: {
    costUsd?: number
    tokensInput?: number
    tokensOutput?: number
  }) => void
  /** Reports whether adapter cost is backed by known model metadata. Kept
   *  separate from numeric usage for compatibility with existing callbacks. */
  onCostMetadata?: (metadata: { known: boolean }) => void
  /** Structured terminal state. Adapters that report friendly error text must
   *  still call this so routers/jobs do not mistake that text for success. */
  onOutcome?: (outcome: AgentTurnOutcome) => void
  /** When true, the adapter should run the agent in plan / read-only mode.
   *  claude-code translates this to `--permission-mode plan`; opencode
   *  translates it to `--agent plan` (stdio) or `agent: 'plan'` in the HTTP
   *  body. Other adapters ignore this. See Session.planMode for lifecycle. */
  planMode?: boolean
  /** 执行过程 — Agim Agent forces per-hop thinking and surfaces
   *  the trace as reflect activity (DeepSeek-style). Other adapters ignore this. */
  stepReflect?: boolean
  /** Parent Subagent activity step id. Nested Agim workers attach reflects
   *  here instead of inserting `kind: 'reflect'` into the parent accordion. */
  parentActivityStepId?: string
  /** A2A-L1: the inline-jobs row id that's tracking THIS run. Adapters
   *  forward it into RunContext.parentJobId so that any
   *  mcp__agim__call_agent invocation from inside the run stamps the
   *  new callee row with parent_id = this id. */
  parentJobId?: number
  /** A2A-L1: this run's call_depth (0 = user-originated; +1 per nested
   *  call_agent hop). Adapters forward it into RunContext.callDepth so
   *  the bus can enforce AGIM_A2A_MAX_DEPTH on the next hop. */
  callDepth?: number
  /**
   * Subtree A2A depth ceiling inherited from call_agent `maxDepth`
   * (already clamped to AGIM_A2A_MAX_DEPTH). Nested call_agent uses this
   * instead of the global cap alone.
   */
  a2aMaxDepth?: number
  /**
   * Same-family Subagent tool allowlist. Advertised tools are filtered and
   * tool_call blocks names outside the list.
   */
  allowedTools?: readonly string[]
  /** Optional AbortSignal. CLI adapters terminate their child process;
   *  in-process adapters abort provider/tool work and settle their session
   *  before releasing it. A2A and inline jobs wire this from timeout/user
   *  cancellation so work cannot continue after Agim reports it stopped. */
  signal?: AbortSignal
  /** The inbound turn's trace id (ADR-0002). Adapters that mint their own
   *  audit rows (notably the in-process native agent) should use this so the
   *  audit / invocations rows correlate back to the originating IM message
   *  in SIEM joins, rather than minting a disconnected id. CLI adapters that
   *  don't self-audit can ignore it. */
  traceId?: string
  /** Web chat run id (`run-…`) minted by the WS handler. Adapters that emit
   *  per-tool activity steps should include this so the SPA can attach them
   *  to the matching ChatActivityBlock. Optional — IM / scheduler omit it. */
  webRunId?: string
  /** Live tool / skill activity for the web chat accordion. Fired by adapters
   *  that observe tool dispatch (currently Agim Agent / native harness). */
  onToolActivity?: (step: ToolActivityStep) => void
  /**
   * Snapshot of prompt injection for this turn (system prompt + ephemeral
   * headers). Web chat stores it on the run accordion for operator inspection.
   */
  onInjectedContext?: (text: string) => void
}

/** One live activity step pushed to the web chat UI (P1 activity-step). */
export interface ToolActivityStep {
  id: string
  /** `agent` = A2A / call_agent / Subagent delegation. */
  kind: 'tool' | 'skill' | 'status' | 'agent' | 'reflect'
  label: string
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  /** Epoch ms */
  startedAt: number
  finishedAt?: number
  preview?: string
  /** Structured checklist for `agim_todo_write` (avoids preview truncation). */
  todoItems?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
  /** Inline job id for Subagent / A2A steps (`a2a-${jobId}`). */
  jobId?: number
  /** Step Reflect beats on a Subagent row (same-family Agim workers). */
  reflects?: Array<{ stance: 'keep' | 'adjust' | 'stop'; next: string; at: number }>
  /** Latest child tool/skill folded onto this Subagent card. */
  lastTool?: {
    label: string
    status: 'pending' | 'running' | 'success' | 'error' | 'denied'
    at: number
  }
}

/**
 * Adapter interface for AI coding agents (Claude Code, Codex, OpenCode)
 *
 * sendPrompt returns an AsyncGenerator for streaming responses.
 * Each yielded string is a complete message chunk.
 * The generator throws on error — caller catches and handles.
 */
/**
 * Implementation flavor of an AgentAdapter. agim treats every adapter as
 * a peer 'agent backend' — `kind` is a hint for the operator-facing UI
 * (e.g. `/agents`) so they can tell at a glance whether a given backend
 * runs as an out-of-process CLI subprocess, in-process LLM loop, or
 * another local implementation.
 *
 *   'cli'         — spawns an external CLI binary per turn (Claude Code,
 *                   Codex, OpenCode, Antigravity, ...). The historical
 *                   default; the entire 'bridge' identity of agim.
 *   'in-process'  — runs entirely inside the agim process via the native
 *                   LLM client + agent loop (the `native` adapter).
 *
 * Optional — adapters that pre-date this field default to behaviour-only
 * 'cli' rendering, which matches every existing built-in.
 */
export type AgentAdapterKind = 'cli' | 'in-process'

export interface AgentAdapter {
  readonly name: string
  readonly aliases: string[]
  /** Implementation flavor. Optional for backward compatibility; UIs
   *  default to 'cli' when unset. */
  readonly kind?: AgentAdapterKind
  /** True when the adapter injects Agim Skills via its own system prompt.
   *  Router-level prompt prefix injection is skipped to avoid duplicates. */
  readonly handlesAgimSkillsPrompt?: boolean
  /** True when the adapter consumes AgentSendOpts.ephemeralContext without
   *  requiring router-level prompt concatenation. */
  readonly handlesEphemeralContext?: boolean
  sendPrompt(sessionId: string, prompt: string, history?: ChatMessage[], opts?: AgentSendOpts): AsyncGenerator<string>
  isAvailable(): Promise<boolean>
  /** Optional short hint for `/agents` UI ('model: deepseek-v4-pro',
   *  'host: cursor.com', etc.). Returns undefined when nothing useful
   *  to surface. Cheap synchronous call — never IO. */
  describe?(): string | undefined
}

/**
 * Configuration for the agim instance
 */
export interface Config {
  messengers: string[]
  agents: string[]
  defaultAgent: string
  /**
   * Sparse overrides of builtin CLI specialty profiles
   * (`src/core/agent-profiles.ts`). Agim Agent is never profiled here.
   */
  agentProfiles?: Record<string, {
    summary?: string
    strengths?: string[]
    avoid?: string[]
    tags?: string[]
  }>
  [key: string]: unknown
}
