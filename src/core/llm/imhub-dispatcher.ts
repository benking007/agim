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
import type { RouteContext } from '../router.js'

const log = rootLogger.child({ component: 'imhub-dispatcher' })

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
        'Present the user with an N-way multiple-choice question and reliably get a typed answer back (1-indexed). Use when you need disambiguation rather than free-form chat. Default timeout 90s.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Single-line question, ≤400 chars.' },
          choices: { type: 'array', items: { type: 'string' }, description: '2-9 short choice labels.' },
          timeoutSec: { type: 'integer', minimum: 5, maximum: 600, default: 90 },
          allowTextReply: { type: 'boolean', default: true, description: 'When true, text "1"/"a"/label substring also matches.' },
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
        'block. Auto-pauses any prior active goal on the thread. NOT for one-shot questions — ' +
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
  let callAgentCount = 0

  return async (call, signal): Promise<DispatcherResult> => {
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
            args as { question?: unknown; choices?: unknown; timeoutSec?: unknown; allowTextReply?: unknown },
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
          if (callAgentMaxPerTurn > 0 && callAgentCount >= callAgentMaxPerTurn) {
            log.warn({
              event: 'native.call_agent.cap_exceeded',
              callerAgent: ctx.callerAgent,
              calleeAgent: agentName,
              count: callAgentCount,
              cap: callAgentMaxPerTurn,
              threadId: ctx.threadId,
            }, `call_agent cap exceeded (${callAgentCount}/${callAgentMaxPerTurn}) — refusing further delegation`)
            return err(
              `call_agent refused: you have already delegated ${callAgentCount} time(s) this turn ` +
              `(cap=${callAgentMaxPerTurn}). Use your own tools (native_read_file, native_grep, ` +
              `native_list_dir, mcp__imhub__* …) to finish the task. If you genuinely need a CLI ` +
              `agent for the rest, tell the user to /cc, /oc, or /cs to switch — don't keep ` +
              `chaining call_agent.`,
            )
          }
          callAgentCount += 1
          log.info({
            event: 'native.call_agent.delegated',
            callerAgent: ctx.callerAgent,
            calleeAgent: agentName,
            attempt: callAgentCount,
            cap: callAgentMaxPerTurn,
            threadId: ctx.threadId,
          }, `delegating to ${agentName} (attempt ${callAgentCount}/${callAgentMaxPerTurn || '∞'})`)
          // Construct a minimal RouteContext from the run context so A2A
          // can audit / route. Lifted to a partial cast because most of
          // RouteContext's optional fields (intent, agentSessionId, …)
          // are only used by full-router dispatch — not A2A.
          const routeCtx: RouteContext = {
            channelId: ctx.channelId,
            threadId: ctx.threadId,
            platform: ctx.platform,
            userId: ctx.userId,
            defaultAgent: ctx.callerAgent,
            traceId: `native-a2a-${Date.now()}`,
            logger: (ctx.logger ?? rootLogger).child({ component: 'a2a-from-native', threadId: ctx.threadId }),
          }
          const result = await callAgentByName(agentName, prompt, routeCtx, {
            callerDepth: ctx.callerDepth ?? 0,
            callerAgent: ctx.callerAgent,
          })
          if (!result.ok) return err(`call_agent failed: ${result.error}`)
          // CallAgentResult exposes the callee's final text as `result`.
          // Outputs, jobId, durationMs etc. are returned as a JSON
          // sidecar so the model can reference produced artifacts if
          // it asks for them — keeps the main payload terse.
          return ok(typeof result.result === 'string' ? result.result : safeJson(result))
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
