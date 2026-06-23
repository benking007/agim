// imhub-dispatcher — wires agim's internal RPC handlers (skills /
// memo / push / ask-user / a2a) into the native LLM agent loop so a
// `native` adapter call can invoke `mcp__imhub__read_skill` etc. with
// the exact same wire shape claude-code's MCP sidecar exposes to
// `claude-code` / `codex` / `opencode`.
//
// Why this file exists
// --------------------
// `mcp-client.ts` in this directory only handles operator-configured
// external MCP servers (stdio / sse / streamable-http). The "imhub"
// tools (read_skill, save_memo, ask_user, push_message, call_agent…)
// live inside the agim process and historically were only reachable
// via the claude-code MCP sidecar process. Before this file, a native
// agent could only call the four `native_*` built-ins (echo, now,
// sleep, random_uuid) — it couldn't read its own skills, save a
// memo, or hand off to claude-code via call_agent.
//
// What this file does
// -------------------
// 1. `getImhubTools()` returns the `ToolDef[]` to advertise to the
//    LLM, all named `mcp__imhub__<op>` so the LLM and downstream
//    audit observers see the same tool naming as the claude-code MCP
//    surface.
// 2. `buildImhubDispatcher(ctx)` returns a `ToolDispatcher` that
//    receives a per-IM-turn `RunContext`-equivalent (closure) and
//    routes each call into the corresponding RPC handler.
//
// Tool naming uses double-underscore (`mcp__imhub__read_skill`) to
// stay byte-identical to the claude-code MCP-server-emitted names —
// log greps, audit dashboards, and policy gates configured against
// the claude-code surface keep matching when native is in use.
//
// Anything the dispatcher doesn't recognise returns
// `source: 'unknown'` so `combineDispatchers(builtin, imhub, mcp)`
// can fall through to the next layer (external MCP servers).

import { logger as rootLogger } from '../logger.js'
import type { ToolDispatcher, DispatcherResult } from './tool-dispatcher.js'
import type { ToolDef } from './provider-base.js'
import { handleSkillsOp } from '../skills-rpc.js'
import { handleMemoOp } from '../memo-rpc.js'
import { handlePushOp } from '../push-rpc.js'
import { handleAskOp } from '../ask-user-rpc.js'
import { callAgentByName } from '../a2a.js'
import {
  createReminder,
  listReminders,
  cancelReminder,
  snoozeReminder,
  parseDuration,
  ReminderError,
  type CreateReminderInput,
} from '../reminders.js'
import { savePaste } from '../viewer-local.js'
import { buildPasteUrl } from '../viewer-config.js'
import type { RouteContext } from '../router.js'

const log = rootLogger.child({ component: 'imhub-dispatcher' })

/** v1.2.121 — kill switch for in-process native self-spawn. When set to
 *  'off' (or '0' / 'no'), call_agent('native', …) falls back to the
 *  subprocess CLI boot path. Default is ON (in-process) because
 *  fan-out latency is the main reason this feature exists. */
function isInProcessSpawnDisabled(): boolean {
  const raw = (process.env.IMHUB_NATIVE_CALL_AGENT_IN_PROCESS ?? '').toLowerCase().trim()
  return raw === 'off' || raw === '0' || raw === 'no' || raw === 'false'
}

/** Per-turn caller identity. Matches the subset of `RunContext` the
 *  agim RPC handlers consume + the optional `agent` for A2A self-call
 *  detection. */
export interface ImhubDispatcherCtx {
  platform: string
  channelId: string
  threadId: string
  userId: string
  /** Calling agent name. A2A uses this to reject self-calls. */
  callerAgent: string
  /** Optional pino-compatible logger for the RouteContext A2A needs. */
  logger?: typeof rootLogger
  /** Optional A2A depth — defaults to 0 for native-originated calls. */
  callerDepth?: number
  /** v1.2.139 — caller's PlanMode flag at dispatch time. When true the
   *  parent thread has `/plan on`, so any sub-agent we spawn MUST also
   *  run read-only. Resolved by native/index.ts via
   *  effectivePlanModeOn(planThreadKey) before building the dispatcher. */
  callerPlanMode?: boolean
  /** The parent turn's inline-job id (cli.ts stamps routeCtx.parentJobId on
   *  every inbound turn). Threaded into callAgentByName so the A2A callee row
   *  gets parent_id set — without it native-originated A2A jobs have a NULL
   *  parent_id and the web `/api/a2a/*` views (which filter parent_id IS NOT
   *  NULL) show them as 0. */
  parentJobId?: number
}

/** v1.2.139 — env-driven output cap. When a sub-agent's reply exceeds
 *  this, the dispatcher returns a short head + tail and stashes the full
 *  text into viewer-paste (when configured) so the model can still cite
 *  it. Default 8 KB: enough for typical CR reports / research summaries,
 *  small enough that 2-3 stacked sub-agents don't blow the parent's
 *  context budget. Set 0 to disable truncation. */
export function resolveSubAgentOutputCap(): number {
  const raw = process.env.IMHUB_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS
  if (raw === undefined) return 8000
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 8000
  return n
}

/** v1.2.139 — one-shot transient retry. Mirrors the streamWithFirstTokenRetry
 *  pattern: if the underlying provider/CLI tripped a 5xx / socket reset / quick
 *  timeout, retry exactly once. Permanent errors (4xx, schema fail, model
 *  refusals) keep the original behaviour (no retry). */
export function isTransientSubAgentError(msg: string): boolean {
  if (!msg) return false
  return /\b(5\d\d|408)\b|timeout|ECONN|ETIMEDOUT|fetch failed|socket hang up|network|ENETUNREACH/i.test(msg)
}

/** Track a single sub-agent invocation for richer cap_exceeded prompts. */
interface SubAgentCall {
  agent: string
  promptHead: string
  ok: boolean
}

/** v1.2.139 — apply the byte cap to a sub-agent reply, optionally
 *  spilling the full text into viewer-paste so the model can reference
 *  the spill URL. Returns the (possibly truncated) text the dispatcher
 *  should hand to the agent loop. */
export function applyOutputCap(
  raw: string,
  agentName: string,
  jobId: number | null,
): string {
  const cap = resolveSubAgentOutputCap()
  if (cap === 0 || raw.length <= cap) return raw
  // Split roughly 70/30 head vs tail — the conclusion of a sub-agent
  // reply is usually as important as the lede.
  const headBudget = Math.floor(cap * 0.7)
  const tailBudget = Math.max(cap - headBudget - 200, 0)  // 200 reserved for marker
  const head = raw.slice(0, headBudget)
  const tail = tailBudget > 0 ? raw.slice(raw.length - tailBudget) : ''
  let pasteHint = ''
  try {
    // savePaste fail-softs when better-sqlite3 is unavailable (bun
    // test runner / fresh install) — it returns null and we just
    // skip the URL hint.
    const id = savePaste({
      content: raw,
      content_type: 'markdown',
      title: `call_agent(${agentName}) full reply`,
      source: 'a2a',
      job_id: jobId ?? undefined,
    })
    if (id) {
      const url = buildPasteUrl(id)
      if (url) pasteHint = `\n\n[full reply spilled to ${url}]`
    }
  } catch {
    // best-effort; the truncation itself is still the safety net
  }
  return [
    head,
    `\n\n[…truncated ${raw.length - headBudget - tailBudget} of ${raw.length} chars; ` +
    `cap=IMHUB_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS=${cap}…]\n\n`,
    tail,
    pasteHint,
  ].join('')
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function ok(text: string): DispatcherResult {
  return { text, isError: false, source: 'imhub' }
}

function err(text: string): DispatcherResult {
  return { text, isError: true, source: 'imhub' }
}

function unknown(name: string): DispatcherResult {
  // matches builtin-dispatcher's marker so combineDispatchers falls
  // through to the next dispatcher in the stack.
  return {
    text: `imhub-dispatcher: no handler for "${name}"`,
    isError: true,
    source: 'unknown',
  }
}

/**
 * Tool roster the LLM sees. JSON Schemas are kept terse — they match
 * the RPC handlers' real expectations without copying claude-code's
 * MCP server's full prose docstrings, which can grow to multi-KB.
 */
export function getImhubTools(): ToolDef[] {
  return [
    {
      name: 'mcp__imhub__read_skill',
      description:
        'Read the full body of one agim skill (a markdown reference card maintained by the operator). The skill summary is already injected into the system prompt; call this when you need the full text (examples, exact slash command syntax, gotchas).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name as shown in the system prompt list, e.g. "agim-self".' },
        },
        required: ['name'],
      },
    },
    {
      name: 'mcp__imhub__list_skills',
      description:
        'Enumerate every skill currently available to this agim install (name + one-line description). Cheap; use it instead of guessing what skill names exist.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'mcp__imhub__save_memo',
      description:
        'Record any kind of memo for the user (5W1H). Extract `what` (required), plus `who`, `when_at` / `when_text`, `where_lat`/`where_lng`/`where_label` or `address`, `how`, `why`, `memo` (full original phrasing) from the user message. Defaults to permanent storage; pass `expires_in_hours` for transient notes. All times Asia/Shanghai (UTC+8) format "YYYY-MM-DD HH:MM:SS".',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', description: 'Core thing being recorded (REQUIRED, ≤200 chars).' },
          who: { type: 'string' },
          when_at: { type: 'string', description: 'UTC+8 datetime "YYYY-MM-DD HH:MM:SS".' },
          when_text: { type: 'string', description: 'Raw user phrase if when_at not parseable.' },
          where_lat: { type: 'number' },
          where_lng: { type: 'number' },
          where_label: { type: 'string' },
          address: { type: 'string', description: 'Free-text address; server geocodes when lat/lng absent.' },
          how: { type: 'string' },
          why: { type: 'string' },
          memo: { type: 'string', description: 'Full original phrasing of the user request.' },
          expires_in_hours: { type: 'number', description: 'Auto-expire after N hours. Omit for permanent.' },
        },
        required: ['what'],
      },
    },
    {
      name: 'mcp__imhub__search_memos',
      description:
        'Recall memos for queries about saved knowledge ("我的车在哪", "我爸爸的生日"). Combines free-text query with optional structured filters; all filters AND-combine.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text — fuzzy LIKE match across what/who/where_label/how/why/when_text/memo.' },
          what: { type: 'string' },
          who: { type: 'string' },
          has_location: { type: 'boolean' },
          when_after: { type: 'string', description: 'UTC+8 "YYYY-MM-DD HH:MM:SS"; memos with when_at OR created_at ≥ this.' },
          when_before: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          include_expired: { type: 'boolean', default: false },
        },
      },
    },
    {
      name: 'mcp__imhub__update_memo',
      description: 'Patch an existing memo by id. Pass only the fields you want to change.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          what: { type: 'string' },
          who: { type: 'string' },
          when_at: { type: 'string' },
          when_text: { type: 'string' },
          where_lat: { type: 'number' },
          where_lng: { type: 'number' },
          where_label: { type: 'string' },
          memo: { type: 'string' },
          expires_in_hours: { type: 'number' },
        },
        required: ['id'],
      },
    },
    {
      name: 'mcp__imhub__delete_memo',
      description: 'Drop one memo by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
    },
    {
      name: 'mcp__imhub__push_message',
      description:
        'Push a follow-up message back into the caller IM thread without waiting for the next user turn. Use for proactive notifications during long-running tasks. Default pushes into the caller thread; cross-thread requires operator opt-in (IMHUB_PUSH_CROSS_THREAD=on).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Body to push. Required.' },
          toThread: { type: 'string', description: 'Optional override "<platform>:<channelId>:<threadId>". Cross-thread requires operator opt-in.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'mcp__imhub__ask_user',
      description:
        'Present the user with a structured question and reliably get an answer back. Supports single-select (default), multi-select, and optional custom free-form input. Use when you need disambiguation rather than free-form chat. Default timeout 90s.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Single-line question, ≤400 chars.' },
          choices: { type: 'array', items: { type: 'string' }, description: '2-9 short choice labels.' },
          timeoutSec: { type: 'integer', minimum: 5, maximum: 600, default: 90 },
          selectionMode: { type: 'string', enum: ['single', 'multi'], default: 'single' },
          minSelections: { type: 'integer', minimum: 1, description: 'Only for multi mode. Default 1.' },
          maxSelections: { type: 'integer', minimum: 1, description: 'Only for multi mode. Default = choices.length.' },
          allowCustomInput: { type: 'boolean', default: false, description: 'Allow the user to answer with free-form text.' },
          customInputLabel: { type: 'string', description: 'Optional display label for custom input entry.' },
          allowTextReply: { type: 'boolean', default: true, description: 'When true, text "1"/"a"/label substring also matches.' },
          detailsUrl: { type: 'string', description: 'Optional http(s) URL shown as a "查看详情" entry on the card — for context the decision depends on (e.g. a viewer/paste link or PR). Invalid/non-http values are ignored.' },
          detailsLabel: { type: 'string', description: 'Optional label for detailsUrl (default "📖 查看详情").' },
        },
        required: ['question', 'choices'],
      },
    },
    {
      name: 'mcp__imhub__call_agent',
      description:
        'Hand off a prompt to another registered agent (claude-code, codex, opencode, antigravity, native, or any remote ACP). Subject to A2A guardrails: depth limit, self-call ban, workspace ACL, per-user budget. Returns the callee\'s final text.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Target agent name. Must not be the caller.' },
          prompt: { type: 'string', description: 'Prompt to send.' },
        },
        required: ['agent', 'prompt'],
      },
    },
    {
      name: 'mcp__imhub__long_task',
      description:
        'Register a sustained multi-turn objective for this thread. Use when the user describes ' +
        'work that should stay visible across many turns ("ship v1.3 this week", "track X for the ' +
        'next 3 days"). The goal is injected into your future system prompts as an `[Active goal]` ' +
        'block. If a goal is ALREADY active on this thread, this refuses unless you pass force:true ' +
        '(complete_goal first, or force to pause the prior one). NOT for one-shot questions — ' +
        'use this only when persistence across turns is the point.',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description:
              'One-line objective. Write it idempotent + bounded + self-contained: "Ship agim v1.3 ' +
              'with the fs/web/exec tool batch landed and CHANGELOG updated", not "improve agim".',
          },
          summary: {
            type: 'string',
            description: 'Optional short acceptance criteria / scope notes (≤ 4000 chars).',
          },
          force: {
            type: 'boolean',
            description: 'Set true to override (auto-pause) an existing active goal on this thread. ' +
              'Defaults to false, which refuses when a goal is already active.',
          },
        },
        required: ['goal'],
      },
    },
    {
      name: 'mcp__imhub__complete_goal',
      description:
        'Mark the thread\'s currently-active goal as done (or cancelled). Use when the work is ' +
        'finished, when the user cancels, or when the user replaces the goal with a different ' +
        'objective. Without `status` defaults to "completed". `recap` is appended as a final ' +
        'progress note so the historical log makes sense.',
      parameters: {
        type: 'object',
        properties: {
          recap: { type: 'string', description: 'One-line honest summary of how the goal ended.' },
          status: { type: 'string', enum: ['completed', 'cancelled'] },
        },
      },
    },
    {
      name: 'mcp__imhub__create_reminder',
      description:
        'Create a one-shot or recurring reminder for the current user. CALL THIS PROACTIVELY ' +
        'whenever the user mentions a future commitment, event, task, or anything they might ' +
        'want to be reminded about — including casual mentions like "明天中午要开会", ' +
        '"下周三去医院复查", or explicit asks like "提醒我30分钟后喝水". The reminder fires at ' +
        'fireAt and is delivered to this same IM thread. After creating, briefly acknowledge to ' +
        'the user (e.g. "✅ 已为你设了提醒，明天12点 团队聚餐"). For recurring use "every:5m", ' +
        '"daily:08:00", or "weekly:1,3,5:09:00".',
      parameters: {
        type: 'object',
        properties: {
          fireAt: {
            type: 'string',
            description: 'First fire time as ISO 8601 local time, e.g. "2026-05-10T12:00:00". Asia/Shanghai assumed if no offset.',
          },
          text: {
            type: 'string',
            description: 'What to remind the user about, ≤ 60 chars. Just the activity, not the time.',
          },
          recurrence: {
            type: 'string',
            description: 'Optional. "every:5m" | "daily:HH:MM" | "weekly:1,3,5:HH:MM"',
          },
          promptMode: {
            type: 'string',
            enum: ['literal', 'llm'],
            description: 'Default "llm" (LLM polishes the reminder text at fire time). Pass "literal" for verbatim delivery.',
          },
        },
        required: ['fireAt', 'text'],
      },
    },
    {
      name: 'mcp__imhub__list_reminders',
      description:
        'List the current user\'s pending reminders. Use when the user asks "我有什么提醒" / ' +
        '"接下来要做什么" or before suggesting cancel/snooze.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'mcp__imhub__cancel_reminder',
      description:
        'Cancel a pending reminder by id. Find ids via list_reminders. For recurring reminders ' +
        'this terminates the entire loop.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Reminder id from list_reminders' } },
        required: ['id'],
      },
    },
    {
      name: 'mcp__imhub__snooze_reminder',
      description:
        'Push a reminder back by a duration ("5m", "30m", "2h", "1d"). Creates a new reminder ' +
        'with the same text and cancels the original.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Reminder id to snooze' },
          duration: { type: 'string', description: 'Duration like "5m" / "30m" / "2h" / "1d"' },
        },
        required: ['id', 'duration'],
      },
    },
  ]
}

/** Build a dispatcher closure over the per-turn IM context. */
export function buildImhubDispatcher(ctx: ImhubDispatcherCtx): ToolDispatcher {
  const runCtxBase = {
    threadId: ctx.threadId,
    platform: ctx.platform,
    userId: ctx.userId,
    channelId: ctx.channelId,
  }

  // v1.2.59 A — per-turn call_agent cap. Closure state is scoped to ONE
  // dispatcher instance, which native rebuilds per turn — so the counter
  // resets on every new user message. Default 2; override with
  // IMHUB_NATIVE_CALL_AGENT_MAX_PER_TURN. Set 0 to disable the cap
  // (legacy unlimited behavior).
  const callAgentMaxPerTurn = (() => {
    const raw = process.env.IMHUB_NATIVE_CALL_AGENT_MAX_PER_TURN
    if (!raw) return 2
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2
  })()
  // v1.2.139 — track call history (not just count) so the cap_exceeded
  // refusal can name which agents the model already invoked and whether
  // they succeeded — model self-corrects faster when it can see "you
  // already asked claude-code, it returned OK; don't ask it again".
  const callAgentHistory: SubAgentCall[] = []

  return async (call, signal, toolCtx): Promise<DispatcherResult> => {
    if (!call.name.startsWith('mcp__imhub__')) return unknown(call.name)
    const op = call.name.slice('mcp__imhub__'.length)
    const args = (call.arguments && typeof call.arguments === 'object' ? call.arguments : {}) as Record<string, unknown>

    try {
      switch (op) {
        case 'read_skill': {
          const r = await handleSkillsOp({ op: 'read', name: args.name })
          if (!r.ok) return err(`read_skill failed: ${r.error}`)
          if (r.result.op !== 'read') return err('unexpected response shape')
          if (!r.result.available) return err(`skill "${r.result.name}" unavailable: ${r.result.unavailableReason || 'unknown'}`)
          return ok(r.result.body)
        }
        case 'list_skills': {
          const r = await handleSkillsOp({ op: 'list' })
          if (!r.ok) return err(`list_skills failed: ${r.error}`)
          return ok(safeJson(r.result))
        }
        case 'save_memo': {
          const r = await handleMemoOp('save', args, runCtxBase)
          if (!r.ok) return err(`save_memo failed: ${r.error}`)
          return ok(safeJson(r.result))
        }
        case 'search_memos': {
          const r = await handleMemoOp('search', args, runCtxBase)
          if (!r.ok) return err(`search_memos failed: ${r.error}`)
          return ok(safeJson(r.result))
        }
        case 'update_memo': {
          const r = await handleMemoOp('update', args, runCtxBase)
          if (!r.ok) return err(`update_memo failed: ${r.error}`)
          return ok(safeJson(r.result))
        }
        case 'delete_memo': {
          const r = await handleMemoOp('delete', args, runCtxBase)
          if (!r.ok) return err(`delete_memo failed: ${r.error}`)
          return ok(safeJson(r.result))
        }
        case 'push_message': {
          const r = await handlePushOp(args as { text?: unknown; toThread?: unknown; kind?: unknown }, runCtxBase)
          if (!r.ok) return err(`push_message failed: ${r.error}`)
          return ok(safeJson(r.result))
        }
        case 'ask_user': {
          const r = await handleAskOp(
            args as {
              question?: unknown
              choices?: unknown
              timeoutSec?: unknown
              selectionMode?: unknown
              minSelections?: unknown
              maxSelections?: unknown
              allowCustomInput?: unknown
              customInputLabel?: unknown
              allowTextReply?: unknown
              detailsUrl?: unknown
              detailsLabel?: unknown
            },
            runCtxBase,
          )
          if (!r.ok) return err(`ask_user failed (${r.reason || 'error'}): ${r.error}`)
          return ok(safeJson(r.result))
        }
        case 'call_agent': {
          const agentName = typeof args.agent === 'string' ? args.agent : ''
          const prompt = typeof args.prompt === 'string' ? args.prompt : ''
          if (!agentName || !prompt) return err('call_agent requires both `agent` (string) and `prompt` (string).')
          // v1.2.59 A — enforce per-turn cap. Without this, a model that
          // keeps delegating ("ask claude-code again, that wasn't enough")
          // can chain dozens of A2A calls per single user turn — observed
          // 8 chained calls in one wechat turn before the user had to
          // /abort. The cap is also visible in the deny message so the
          // model self-corrects on its next iteration.
          if (callAgentMaxPerTurn > 0 && callAgentHistory.length >= callAgentMaxPerTurn) {
            // v1.2.139 — include the history so the model can see what it
            // has already tried (and whether those calls succeeded). A
            // model that sees "you already called claude-code and got an
            // OK 4k-char reply" stops re-delegating much faster than one
            // that just sees a bare count.
            const summary = callAgentHistory
              .map((h, i) => `  ${i + 1}. ${h.agent} ${h.ok ? '✓' : '✗'}: "${h.promptHead}…"`)
              .join('\n')
            log.warn({
              event: 'native.call_agent.cap_exceeded',
              callerAgent: ctx.callerAgent,
              calleeAgent: agentName,
              count: callAgentHistory.length,
              cap: callAgentMaxPerTurn,
              history: callAgentHistory,
              threadId: ctx.threadId,
            }, `call_agent cap exceeded (${callAgentHistory.length}/${callAgentMaxPerTurn}) — refusing further delegation`)
            return err(
              `call_agent refused: you have already delegated ${callAgentHistory.length} time(s) this turn ` +
              `(cap=${callAgentMaxPerTurn}). Prior delegations:\n${summary}\n\n` +
              `Use your own tools (native_read_file, native_grep, native_list_dir, mcp__imhub__* …) to ` +
              `finish the task with the information you already gathered. If you genuinely need a CLI ` +
              `agent for the rest, tell the user to /cc, /oc, or /cs to switch — don't keep chaining call_agent.`,
            )
          }
          const promptHead = prompt.slice(0, 60).replace(/\s+/g, ' ')
          log.info({
            event: 'native.call_agent.delegated',
            callerAgent: ctx.callerAgent,
            calleeAgent: agentName,
            attempt: callAgentHistory.length + 1,
            cap: callAgentMaxPerTurn,
            callerPlanMode: ctx.callerPlanMode ?? false,
            threadId: ctx.threadId,
          }, `delegating to ${agentName} (attempt ${callAgentHistory.length + 1}/${callAgentMaxPerTurn || '∞'}` +
              `${ctx.callerPlanMode ? ', plan-mode propagated' : ''})`)

          // v1.2.121 — in-process self-spawn fast path.
          //
          // When the target is `native` (i.e. caller wants to fan-out
          // research using more native turns), skip the subprocess
          // boot and run another native agent loop in the SAME JS
          // heap. Saves the ~5s claude-code-style boot per fan-out;
          // matches the pattern Claude Code uses for in-process Task
          // agents.
          //
          // Disabled via IMHUB_NATIVE_CALL_AGENT_IN_PROCESS=off
          // (falls back to subprocess via callAgentByName).
          // Depth + A2A_ENABLED checks still apply.
          if (agentName === 'native' && !isInProcessSpawnDisabled()) {
            const { getA2AMaxDepth, isA2AEnabled } = await import('../a2a.js')
            if (!isA2AEnabled()) {
              callAgentHistory.push({ agent: agentName, promptHead, ok: false })
              return err('call_agent refused: A2A disabled (IMHUB_A2A_ENABLED=0)')
            }
            const callerDepth = ctx.callerDepth ?? 0
            const nextDepth = callerDepth + 1
            const maxDepth = getA2AMaxDepth()
            if (nextDepth > maxDepth) {
              log.warn({
                event: 'native.call_agent.in_process_depth_exceeded',
                callerDepth, nextDepth, maxDepth, threadId: ctx.threadId,
              }, `in-process self-spawn refused: depth ${nextDepth} > max ${maxDepth}`)
              callAgentHistory.push({ agent: agentName, promptHead, ok: false })
              return err(`call_agent refused: depth ${nextDepth} > max ${maxDepth}`)
            }
            log.info({
              event: 'native.call_agent.in_process_spawn',
              callerDepth, nextDepth, threadId: ctx.threadId, subTurnCallId: call.id,
              callerPlanMode: ctx.callerPlanMode ?? false,
            }, `in-process native self-spawn (depth ${nextDepth}); skipping subprocess boot`)
            // v1.2.139 — one-shot transient retry on the in-process path.
            // ADR-0002 — chain the parent turn's trace into the in-process
            // sub-turn so its native audit rows correlate end-to-end (mirrors
            // the `${parentTrace}/a2a-${id}` chaining the subprocess path uses
            // below). Falls back to undefined → the sub-turn self-mints.
            const inProcParentTrace = toolCtx?.traceId
            const inProcA2aTrace = inProcParentTrace ? `${inProcParentTrace}/a2a-${call.id}` : undefined
            const runOnce = async (): Promise<string> => {
              // Route to the single Agim Agent registered under 'native' so
              // in-process sub-agent runs use the same adapter as the parent.
              const { registry } = await import('../registry.js')
              const nativeAdapter = registry.findAgent('native')
              if (!nativeAdapter) throw new Error('native engine not registered')
              const subSessionId = `${ctx.threadId}-spawn-${call.id}`
              const parts: string[] = []
              for await (const chunk of nativeAdapter.sendPrompt(
                subSessionId,
                prompt,
                [],
                {
                  platform: ctx.platform,
                  channelId: ctx.channelId,
                  threadId: ctx.threadId,
                  userId: ctx.userId,
                  callDepth: nextDepth,
                  ...(inProcA2aTrace ? { traceId: inProcA2aTrace } : {}),
                  // v1.2.139 — propagate parent's plan-mode to the child.
                  // Without this a parent in /plan on could delegate write
                  // work to the in-process child and bypass user intent.
                  ...(ctx.callerPlanMode ? { planMode: true } : {}),
                  signal,
                },
              )) {
                parts.push(chunk)
              }
              return parts.join('')
            }
            try {
              let raw: string
              try {
                raw = await runOnce()
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                if (!isTransientSubAgentError(msg)) throw e
                log.warn({
                  event: 'native.call_agent.in_process_retry',
                  err: msg, threadId: ctx.threadId,
                }, 'in-process self-spawn transient-failed; retrying once')
                raw = await runOnce()
              }
              callAgentHistory.push({ agent: agentName, promptHead, ok: true })
              return ok(applyOutputCap(raw, agentName, null))
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              log.warn({ event: 'native.call_agent.in_process_failed', err: msg },
                'in-process self-spawn threw; surfacing error to caller')
              callAgentHistory.push({ agent: agentName, promptHead, ok: false })
              return err(`call_agent (in-process native) failed: ${msg}`)
            }
          }

          // Construct a minimal RouteContext from the run context so A2A
          // can audit / route. Lifted to a partial cast because most of
          // RouteContext's optional fields (intent, agentSessionId, …)
          // are only used by full-router dispatch — not A2A.
          // v1.2.111 — chain the parent trace id from the agent loop
          // rather than minting a fresh root, so a full turn (every
          // tool call + every A2A fan-out) is traceable end-to-end via
          // a single prefix in the audit log. Falls back to the legacy
          // mint when the caller didn't supply one (e.g. tests).
          const parentTrace = toolCtx?.traceId
          const a2aTrace = parentTrace
            ? `${parentTrace}/a2a-${call.id}`
            : `native-a2a-${Date.now()}`
          const routeCtx: RouteContext = {
            channelId: ctx.channelId,
            threadId: ctx.threadId,
            platform: ctx.platform,
            userId: ctx.userId,
            defaultAgent: ctx.callerAgent,
            traceId: a2aTrace,
            logger: (ctx.logger ?? rootLogger).child({ component: 'a2a-from-native', threadId: ctx.threadId }),
          }
          const baseOpts = {
            callerDepth: ctx.callerDepth ?? 0,
            callerAgent: ctx.callerAgent,
            // Link the callee row to the parent turn so the web A2A views
            // (parent_id IS NOT NULL) can see native-originated A2A.
            ...(typeof ctx.parentJobId === 'number' ? { parentJobId: ctx.parentJobId } : {}),
            // v1.2.139 — propagate parent's plan-mode to the sub-agent.
            ...(ctx.callerPlanMode ? { planMode: true } : {}),
          }
          // v1.2.139 — one-shot transient retry. callAgentByName already
          // wraps its own audit + notify lifecycle; we just retry the
          // whole call when the first attempt looks like a 5xx / socket
          // reset / quick timeout. Permanent failures (workspace ACL,
          // depth exceeded, model refusal) skip the retry.
          let result = await callAgentByName(agentName, prompt, routeCtx, baseOpts)
          if (!result.ok && isTransientSubAgentError(result.error || '')) {
            log.warn({
              event: 'native.call_agent.retry',
              calleeAgent: agentName,
              err: result.error,
              threadId: ctx.threadId,
            }, `call_agent transient-failed; retrying once`)
            result = await callAgentByName(agentName, prompt, routeCtx, baseOpts)
          }
          if (!result.ok) {
            callAgentHistory.push({ agent: agentName, promptHead, ok: false })
            return err(`call_agent failed: ${result.error}`)
          }
          callAgentHistory.push({ agent: agentName, promptHead, ok: true })
          // CallAgentResult exposes the callee's final text as `result`.
          // Outputs, jobId, durationMs etc. are returned as a JSON
          // sidecar so the model can reference produced artifacts if
          // it asks for them — keeps the main payload terse.
          // v1.2.139 — apply output cap so a chatty sub-agent doesn't
          // blow the parent's context budget. The full text is spilled
          // into viewer-paste (when configured) so the model can still
          // cite the link.
          const raw = typeof result.result === 'string' ? result.result : safeJson(result)
          return ok(applyOutputCap(raw, agentName, result.jobId ?? null))
        }
        case 'long_task':
        case 'complete_goal': {
          // v1.2.63 — thin wrapper over goals.ts. RPC layer enforces
          // ctx integrity + writes audit logs.
          const { handleGoalOp } = await import('../goal-rpc.js')
          const r = await handleGoalOp(op, args, {
            platform: ctx.platform,
            channelId: ctx.channelId,
            threadId: ctx.threadId,
            userId: ctx.userId,
            callerAgent: ctx.callerAgent,
          })
          if (!r.ok) return err(`${op} failed: ${r.error}`)
          return ok(safeJson(r.result))
        }
        case 'create_reminder': {
          // v1.2.98 — wire reminder tools into native (was previously
          // only reachable via claude-code's MCP sidecar). Direct call
          // into core/reminders.ts; ctx fields come from the per-turn
          // RunContext on this dispatcher instance, so the reminder is
          // always bound to the right user + thread.
          const fireAtStr = typeof args.fireAt === 'string' ? args.fireAt : ''
          const text = typeof args.text === 'string' ? args.text.trim() : ''
          if (!fireAtStr || !text) return err('create_reminder requires fireAt + text')
          const fireAt = new Date(fireAtStr)
          if (Number.isNaN(fireAt.getTime())) return err(`create_reminder: unparseable fireAt "${fireAtStr}"`)
          const input: CreateReminderInput = {
            fireAt,
            text,
            platform: ctx.platform,
            channelId: ctx.channelId,
            threadId: ctx.threadId,
            userId: ctx.userId,
            source: 'mcp',
            recurrence: typeof args.recurrence === 'string' && args.recurrence ? args.recurrence : undefined,
            promptMode: args.promptMode === 'literal' ? 'literal' : 'llm',
          }
          try {
            const id = createReminder(input)
            return ok(safeJson({ id, fireAt: fireAt.toISOString(), text, recurrence: input.recurrence ?? null }))
          } catch (err2) {
            if (err2 instanceof ReminderError) return err(`create_reminder refused: ${err2.message}`)
            return err(`create_reminder crashed: ${err2 instanceof Error ? err2.message : String(err2)}`)
          }
        }
        case 'list_reminders': {
          const rows = listReminders({ creatorId: ctx.userId, status: 'pending', limit: 50 })
          return ok(safeJson({
            count: rows.length,
            rows: rows.map((r) => ({
              id: r.id,
              fireAt: new Date(r.fire_at).toISOString(),
              text: r.text,
              recurrence: r.recurrence ?? null,
            })),
          }))
        }
        case 'cancel_reminder': {
          const id = typeof args.id === 'number' ? args.id : Number(args.id)
          if (!Number.isFinite(id) || id <= 0) return err('cancel_reminder requires positive integer id')
          const ok2 = cancelReminder(id, { creatorId: ctx.userId })
          return ok(safeJson({ id, cancelled: ok2 }))
        }
        case 'snooze_reminder': {
          const id = typeof args.id === 'number' ? args.id : Number(args.id)
          const duration = typeof args.duration === 'string' ? args.duration : ''
          if (!Number.isFinite(id) || id <= 0) return err('snooze_reminder requires positive integer id')
          const deltaMs = parseDuration(duration)
          if (!deltaMs) return err(`snooze_reminder: bad duration "${duration}" (use 5m / 30m / 2h / 1d)`)
          try {
            const newId = snoozeReminder(id, deltaMs, { creatorId: ctx.userId })
            return ok(safeJson({ original_id: id, new_id: newId, snoozed_by_ms: deltaMs }))
          } catch (err2) {
            if (err2 instanceof ReminderError) return err(`snooze_reminder refused: ${err2.message}`)
            return err(`snooze_reminder crashed: ${err2 instanceof Error ? err2.message : String(err2)}`)
          }
        }
        default:
          return unknown(call.name)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn({ event: 'imhub.dispatcher.error', name: call.name, err: msg })
      return err(`imhub.${op} crashed: ${msg}`)
    } finally {
      void signal // signal is provided for future cancellation; current handlers don't honour it.
    }
  }
}
