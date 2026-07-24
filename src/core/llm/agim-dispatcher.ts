// agim-dispatcher — wires agim's internal RPC handlers (skills /
// memo / push / ask-user / a2a) into the native LLM agent loop so a
// `native` adapter call can invoke `mcp__agim__read_skill` etc. with
// the exact same wire shape claude-code's MCP sidecar exposes to
// `claude-code` / `codex` / `opencode`.
//
// Why this file exists
// --------------------
// `mcp-client.ts` in this directory only handles operator-configured
// external MCP servers (stdio / sse / streamable-http). The "agim"
// tools (read_skill, save_memo, ask_user, push_message, call_agent…)
// live inside the agim process and historically were only reachable
// via the claude-code MCP sidecar process. Before this file, a native
// agent could only call the four `native_*` built-ins (echo, now,
// sleep, random_uuid) — it couldn't read its own skills, save a
// memo, or hand off to claude-code via call_agent.
//
// What this file does
// -------------------
// 1. `getAgimTools()` returns the `ToolDef[]` to advertise to the
//    LLM, all named `mcp__agim__<op>` so the LLM and downstream
//    audit observers see the same tool naming as the claude-code MCP
//    surface.
// 2. `buildAgimDispatcher(ctx)` returns a `ToolDispatcher` that
//    receives a per-IM-turn `RunContext`-equivalent (closure) and
//    routes each call into the corresponding RPC handler.
//
// Tool naming uses double-underscore (`mcp__agim__read_skill`) to
// stay byte-identical to the claude-code MCP-server-emitted names —
// log greps, audit dashboards, and policy gates configured against
// the claude-code surface keep matching when native is in use.
//
// Anything the dispatcher doesn't recognise returns
// `source: 'unknown'` so `combineDispatchers(builtin, agim, mcp)`
// can fall through to the next layer (external MCP servers).

import { AGIM_AGENT_ID } from '../naming-migrate.js'
import { logger as rootLogger } from '../logger.js'
import type { ToolDispatcher, DispatcherResult } from './tool-dispatcher.js'
import type { ToolDef } from './provider-base.js'
import { handleSkillsOp } from '../skills-rpc.js'
import { handleMemoOp } from '../memo-rpc.js'
import { handlePushOp } from '../push-rpc.js'
import { handleAskOp } from '../ask-user-rpc.js'
import { callAgentByName } from '../a2a.js'
import { resolveSubagentSpawn } from '../subagent.js'
import {
  buildCallAgentToolDescription,
  buildCallAgentsToolDescription,
} from '../subagent-heuristics.js'
import {
  CALL_AGENTS_TASKS_HARD_MAX,
  getCallAgentMaxPerTurn,
  getSubagentParallelMax,
  isSubagentParallelEnabled,
  mapPool,
} from '../subagent-parallel.js'
import { describeRegistry, listProviders } from './registry.js'
import { resolveCompleteGoalToolTimeoutMs } from '../goal-rpc.js'
import { hashWorkspaceScope } from '../goal-evidence.js'
import { defaultAgentCwd, resolveAgentCwd } from '../agent-cwd.js'
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

const log = rootLogger.child({ component: 'agim-dispatcher' })

/** Legacy env for in-process same-agent spawn. As of Subagent Phase A1,
 *  same-family calls always use `callAgentByName` (job/activity parity);
 *  this flag is logged-and-ignored for those paths. Kept for operators /
 *  tests that still read the knob. */
export function isInProcessSpawnEnabled(): boolean {
  const raw = (process.env.AGIM_NATIVE_CALL_AGENT_IN_PROCESS ?? '').toLowerCase().trim()
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes'
}

/** Per-turn caller identity. Matches the subset of `RunContext` the
 *  agim RPC handlers consume + the optional `agent` for A2A self-call
 *  detection. */
export interface AgimDispatcherCtx {
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
  /** Web chat activity accordion — forwarded into callAgentByName so A2A
   *  emits "Waiting for subagent" steps on the parent turn. */
  onToolActivity?: import('../types.js').AgentSendOpts['onToolActivity']
}

/** v1.2.139 — env-driven output cap. When a sub-agent's reply exceeds
 *  this, the dispatcher returns a short head + tail and stashes the full
 *  text into viewer-paste (when configured) so the model can still cite
 *  it. Default 8 KB: enough for typical CR reports / research summaries,
 *  small enough that 2-3 stacked sub-agents don't blow the parent's
 *  context budget. Set 0 to disable truncation. */
export function resolveSubAgentOutputCap(): number {
  const raw = process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS
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
    `cap=AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS=${cap}…]\n\n`,
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
  return { text, isError: false, source: 'agim' }
}

function err(text: string): DispatcherResult {
  return { text, isError: true, source: 'agim' }
}

/** R1 hard gate: while Loop is ALIGNING, refuse dispatch / verdict tools. */
async function refuseIfLoopAligning(
  platform: string,
  channelId: string,
  threadId: string,
  tool: string,
): Promise<string | null> {
  const { getActiveLoop, isLoopAligning } = await import('../loop-run.js')
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run || !isLoopAligning(run)) return null
  return (
    `${tool} refused: Loop is ALIGNING (objective + exit not confirmed). `
    + 'Use mcp__agim__ask_user (or tell user `/loop objective` / `/loop exit` / `/loop confirm`). '
    + 'Do not spawn subagents until mission is confirmed.'
  )
}

function unknown(name: string): DispatcherResult {
  // matches builtin-dispatcher's marker so combineDispatchers falls
  // through to the next dispatcher in the stack.
  return {
    text: `agim-dispatcher: no handler for "${name}"`,
    isError: true,
    source: 'unknown',
  }
}

/**
 * Tool roster the LLM sees. JSON Schemas are kept terse — they match
 * the RPC handlers' real expectations without copying claude-code's
 * MCP server's full prose docstrings, which can grow to multi-KB.
 */
export function getAgimTools(): ToolDef[] {
  return [
    {
      name: 'mcp__agim__read_skill',
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
      name: 'mcp__agim__list_skills',
      description:
        'Enumerate every skill currently available to this agim install (name + one-line description). Cheap; use it instead of guessing what skill names exist.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'mcp__agim__save_memo',
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
      name: 'mcp__agim__search_memos',
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
      name: 'mcp__agim__update_memo',
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
      name: 'mcp__agim__delete_memo',
      description: 'Drop one memo by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
    },
    {
      name: 'mcp__agim__push_message',
      description:
        'Push a follow-up message back into the caller IM thread without waiting for the next user turn. Use for proactive notifications during long-running tasks. Default pushes into the caller thread; cross-thread requires operator opt-in (AGIM_PUSH_CROSS_THREAD=on).',
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
      name: 'mcp__agim__ask_user',
      description:
        'Present the user with a structured question and reliably get an answer back. Supports single-select (default), multi-select, and optional custom free-form input. Use when you need disambiguation rather than free-form chat. Default timeout 900s (15 min); give the user enough time to think.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Single-line question, ≤400 chars.' },
          choices: { type: 'array', items: { type: 'string' }, description: '2-9 short choice labels.' },
          timeoutSec: { type: 'integer', minimum: 5, maximum: 1800, default: 900 },
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
      // Waiting on a human can take up to timeoutSec (max 1800s). Do not inherit
      // the Native Agent tool-bridge 60s default — that would cancel the card early.
      timeoutMs: 0,
    },
    {
      name: 'mcp__agim__call_agent',
      description: buildCallAgentToolDescription({
        backends: listProviders().map((p) => p.name),
        roles: Object.keys(describeRegistry().roles),
      }),
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description:
              'Registry agent id: "agim" for same-family Subagent, or another adapter (claude-code, codex, …). '
              + 'For same-family prefer separate backend= field with a configured llmBackends name. '
              + 'Also accepts "agim:<backend>" / "agim/<backend-or-role>" shorthand.',
          },
          prompt: {
            type: 'string',
            description:
              'Self-contained Subagent brief: Objective + Output format + Boundaries + Done-when. '
              + 'Do not spawn for trivial one-step work; child does not see parent chat history.',
          },
          backend: {
            type: 'string',
            description:
              'Preferred: concrete llmBackends.name for same-family Agim Subagent (implies isolate). '
              + 'Use a name from the configured backends list in the tool description.',
          },
          role: {
            type: 'string',
            description:
              'Optional llmRoles alias (e.g. "cheap") only when that role is configured. '
              + 'Prefer backend= over role= — unbound roles fail.',
          },
          isolate: {
            type: 'boolean',
            description:
              'Allow same-agent nested Subagent with a fresh context (default model if backend/role omitted).',
          },
        },
        required: ['agent', 'prompt'],
      },
      // Subagent wall clock is owned by A2A (AGIM_A2A_TIMEOUT_DEFAULT_MS, 30 min
      // default). The Native tool-bridge default (60s) must not abort call_agent
      // mid-research — that was mis-labeled "Stopped by user" in the UI.
      timeoutMs: 0,
    },
    {
      name: 'mcp__agim__call_agents',
      description: buildCallAgentsToolDescription({
        backends: listProviders().map((p) => p.name),
        roles: Object.keys(describeRegistry().roles),
      }),
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: CALL_AGENTS_TASKS_HARD_MAX,
            description:
              `Independent Subagent tasks (1–${CALL_AGENTS_TASKS_HARD_MAX}). `
              + 'Prefer 2–3 lanes. Each prompt must be self-contained. '
              + 'Do not assign two writers to the same file.',
            items: {
              type: 'object',
              properties: {
                agent: {
                  type: 'string',
                  description:
                    'Registry agent id ("agim" or cross-adapter). Same shorthand as call_agent.',
                },
                prompt: {
                  type: 'string',
                  description:
                    'Self-contained brief: Objective + Output format + Boundaries + Done-when.',
                },
                backend: {
                  type: 'string',
                  description: 'Preferred llmBackends.name for same-family Agim (implies isolate).',
                },
                role: {
                  type: 'string',
                  description: 'Optional llmRoles alias when configured; prefer backend=.',
                },
                isolate: {
                  type: 'boolean',
                  description:
                    'Same-family nested Subagent with fresh context (default model if backend/role omitted).',
                },
              },
              required: ['agent', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
      // Batch fan-out can run for A2A's full wall clock; never inherit 60s tool default.
      timeoutMs: 0,
    },
    {
      name: 'mcp__agim__focus_set',
      description:
        'Set this thread\'s Focus (attention anchor) and turn injection ON. Prefer this over the ' +
        'deprecated long_task tool. Focus is injected each turn while on; it is NOT a completion gate.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Focus title (what to stay on).' },
          body: { type: 'string', description: 'Optional longer body.' },
          force: {
            type: 'boolean',
            description: 'Override an existing Focus on this thread (default false refuses).',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'mcp__agim__focus_on',
      description: 'Turn Focus injection ON (requires retained Focus content).',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'mcp__agim__focus_off',
      description: 'Turn Focus injection OFF but keep content. Cancels an active Loop.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'mcp__agim__focus_clear',
      description: 'Clear Focus content and turn off. Cancels an active Loop.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'mcp__agim__loop_verdict',
      description:
        'Loop VERIFY/REFLECT verdict (not during ALIGNING). continue/revise require ≥1 '
        + 'call_agent(s) this round (R3) AND structured verification (R4): met=false, '
        + 'summary, nextDirection (gaps recommended). met=true must use decision=stop '
        + '(ends as objective_met). stop without met abandons. Exit truncates on maxRounds/maxWallMs.',
      parameters: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['continue', 'revise', 'stop'] },
          summary: { type: 'string', description: 'Verification summary against Objective/Acceptance.' },
          met: {
            type: 'boolean',
            description: 'Whether mission objective is met. Required for continue/revise.',
          },
          gaps: {
            type: 'array',
            items: { type: 'string' },
            description: 'What is still missing when met=false.',
          },
          nextDirection: {
            type: 'string',
            description: 'Required when met=false for continue/revise — what to try next round.',
          },
          nextHint: {
            type: 'string',
            description: 'Deprecated alias of nextDirection.',
          },
          reasons: { type: 'array', items: { type: 'string' } },
        },
        required: ['decision', 'summary'],
      },
    },
    {
      name: 'mcp__agim__long_task',
      description:
        'DEPRECATED — use mcp__agim__focus_set. Registers Focus (was: sustained goal) for this thread.',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: 'Focus title (legacy field name `goal`).',
          },
          summary: {
            type: 'string',
            description: 'Optional body / notes.',
          },
          force: {
            type: 'boolean',
            description: 'Override existing Focus when true.',
          },
        },
        required: ['goal'],
      },
    },
    {
      name: 'mcp__agim__complete_goal',
      description:
        'DEPRECATED — completion is not part of Focus. Prefer /loop (loop_verdict stop) for engineering ' +
        'closure. Legacy CAS complete may still run for older goal rows.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'number', description: 'Exact positive goalId from the active-goal Completion token.' },
          goalVersion: { type: 'number', description: 'Exact positive goalVersion from the Completion token.' },
          evidenceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Current `[agim evidence ...]` capability IDs supporting completion.',
          },
          recap: { type: 'string', description: 'One-line honest summary of how the goal ended.' },
          status: { type: 'string', enum: ['completed', 'cancelled'] },
        },
        required: ['goalId', 'goalVersion', 'recap'],
        additionalProperties: false,
      },
      // Human confirmation can take minutes; do not inherit the 60s tool
      // default. Budget = confirmation timeout + settle margin.
      timeoutMs: resolveCompleteGoalToolTimeoutMs(),
    },
    {
      name: 'mcp__agim__create_reminder',
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
      name: 'mcp__agim__list_reminders',
      description:
        'List the current user\'s pending reminders. Use when the user asks "我有什么提醒" / ' +
        '"接下来要做什么" or before suggesting cancel/snooze.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'mcp__agim__cancel_reminder',
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
      name: 'mcp__agim__snooze_reminder',
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
export function buildAgimDispatcher(ctx: AgimDispatcherCtx): ToolDispatcher {
  const runCtxBase = {
    threadId: ctx.threadId,
    platform: ctx.platform,
    userId: ctx.userId,
    channelId: ctx.channelId,
  }

  // Per-turn call_agent + call_agents task budget. Closure is per dispatcher
  // instance (native rebuilds each turn). Default 3; AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN=0 disables.
  const callAgentMaxPerTurn = getCallAgentMaxPerTurn()
  // v1.2.139 — track call history (not just count) so the cap_exceeded
  // refusal can name which agents the model already invoked and whether
  // they succeeded — model self-corrects faster when it can see "you
  // already asked claude-code, it returned OK; don't ask it again".
  const callAgentHistory: SubAgentCall[] = []

  function capExceededError(requested: number): string {
    const summary = callAgentHistory
      .map((h, i) => `  ${i + 1}. ${h.agent} ${h.ok ? '✓' : '✗'}: "${h.promptHead}…"`)
      .join('\n')
    return (
      `call_agent refused: you have already delegated ${callAgentHistory.length} time(s) this turn `
      + `(cap=${callAgentMaxPerTurn}`
      + (requested > 1 ? `; this batch wanted +${requested}` : '')
      + `). Prior delegations:\n${summary || '  (none)'}\n\n`
      + `Use your own tools (agim_read_file, agim_grep, agim_list_dir, mcp__agim__* …) to `
      + `finish with what you already gathered, shrink the batch, or ask the user to switch `
      + `agents explicitly (/cc, /oc, …) — don't keep chaining call_agent / call_agents.`
    )
  }

  type SpawnOk = Extract<ReturnType<typeof resolveSubagentSpawn>, { ok: true }>

  async function invokeOneSubagent(opts: {
    spawn: SpawnOk
    prompt: string
    activityStepId: string
    signal: AbortSignal
    toolCtx?: { traceId?: string }
    callId: string
  }): Promise<{ ok: true; text: string; cancelled?: boolean } | { ok: false; error: string }> {
    const { spawn, prompt, activityStepId, signal: sig, toolCtx, callId } = opts
    if (isInProcessSpawnEnabled() && spawn.sameAgent) {
      log.info({
        event: 'native.call_agent.in_process_skipped_for_parity',
        threadId: ctx.threadId,
        label: spawn.label,
      }, 'same-family Subagent uses callAgentByName (job/activity parity); ignoring AGIM_NATIVE_CALL_AGENT_IN_PROCESS')
    }
    const parentTrace = toolCtx?.traceId
    const a2aTrace = parentTrace
      ? `${parentTrace}/a2a-${callId}`
      : `native-a2a-${Date.now()}`
    const routeCtx: RouteContext = {
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      platform: ctx.platform,
      userId: ctx.userId,
      defaultAgent: ctx.callerAgent,
      traceId: a2aTrace,
      logger: (ctx.logger ?? rootLogger).child({ component: 'a2a-from-native', threadId: ctx.threadId }),
      ...(ctx.onToolActivity ? { onToolActivity: ctx.onToolActivity } : {}),
    }
    const baseOpts = {
      callerDepth: ctx.callerDepth ?? 0,
      callerAgent: ctx.callerAgent,
      ...(typeof ctx.parentJobId === 'number' ? { parentJobId: ctx.parentJobId } : {}),
      ...(ctx.callerPlanMode ? { planMode: true } : {}),
      ...(ctx.onToolActivity ? { onToolActivity: ctx.onToolActivity } : {}),
      ...(spawn.isolate ? { isolate: true } : {}),
      ...(spawn.model ? { model: spawn.model } : {}),
      activityLabel: spawn.label,
      activityStepId,
      signal: sig,
    }
    let result = await callAgentByName(spawn.agent, prompt, routeCtx, baseOpts)
    if (!sig.aborted && !result.ok && isTransientSubAgentError(result.error || '')) {
      log.warn({
        event: 'native.call_agent.retry',
        calleeAgent: spawn.label,
        err: result.error,
        threadId: ctx.threadId,
      }, `call_agent transient-failed; retrying once`)
      result = await callAgentByName(spawn.agent, prompt, routeCtx, baseOpts)
    }
    if (!result.ok) return { ok: false, error: result.error || 'unknown error' }
    if (result.cancelled) {
      return {
        ok: true,
        cancelled: true,
        text: typeof result.result === 'string' ? result.result : safeJson(result),
      }
    }
    const raw = typeof result.result === 'string' ? result.result : safeJson(result)
    return { ok: true, text: applyOutputCap(raw, spawn.label, result.jobId ?? null) }
  }

  return async (call, signal, toolCtx): Promise<DispatcherResult> => {
    if (!call.name.startsWith('mcp__agim__')) return unknown(call.name)
    const op = call.name.slice('mcp__agim__'.length)
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
          {
            const gate = await refuseIfLoopAligning(ctx.platform, ctx.channelId, ctx.threadId, 'call_agent')
            if (gate) return err(gate)
          }
          const agentName = typeof args.agent === 'string' ? args.agent : ''
          const prompt = typeof args.prompt === 'string' ? args.prompt : ''
          if (!agentName || !prompt) {
            return err('call_agent requires both `agent` (string) and `prompt` (string).')
          }
          const roleArg = typeof args.role === 'string' ? args.role : undefined
          const backendArg = typeof args.backend === 'string' ? args.backend : undefined
          const isolateArg = args.isolate === true
          const spawn = resolveSubagentSpawn(
            { agent: agentName, role: roleArg, backend: backendArg, isolate: isolateArg },
            ctx.callerAgent,
          )
          if (!spawn.ok) {
            // Pending Subagent card (toolCallId) would otherwise stay forever —
            // call_agent tool_result activity is suppressed in the adapter.
            try {
              ctx.onToolActivity?.({
                id: call.id,
                kind: 'agent',
                label: agentName,
                status: 'error',
                startedAt: Date.now(),
                finishedAt: Date.now(),
                preview: spawn.error.slice(0, 180),
              })
            } catch { /* observer must not break dispatch */ }
            return err(`call_agent refused: ${spawn.error}`)
          }

          if (callAgentMaxPerTurn > 0 && callAgentHistory.length >= callAgentMaxPerTurn) {
            log.warn({
              event: 'native.call_agent.cap_exceeded',
              callerAgent: ctx.callerAgent,
              calleeAgent: spawn.agent,
              count: callAgentHistory.length,
              cap: callAgentMaxPerTurn,
              history: callAgentHistory,
              threadId: ctx.threadId,
            }, `call_agent cap exceeded (${callAgentHistory.length}/${callAgentMaxPerTurn}) — refusing further delegation`)
            return err(capExceededError(1))
          }
          const promptHead = prompt.slice(0, 60).replace(/\s+/g, ' ')
          log.info({
            event: 'native.call_agent.delegated',
            callerAgent: ctx.callerAgent,
            calleeAgent: spawn.agent,
            subagentLabel: spawn.label,
            model: spawn.model,
            role: spawn.role,
            isolate: spawn.isolate,
            sameAgent: spawn.sameAgent,
            attempt: callAgentHistory.length + 1,
            cap: callAgentMaxPerTurn,
            callerPlanMode: ctx.callerPlanMode ?? false,
            threadId: ctx.threadId,
          }, `delegating to ${spawn.label} (attempt ${callAgentHistory.length + 1}/${callAgentMaxPerTurn || '∞'}` +
              `${ctx.callerPlanMode ? ', plan-mode propagated' : ''})`)

          {
            const { noteLoopDispatch } = await import('../loop-run.js')
            noteLoopDispatch(ctx.platform, ctx.channelId, ctx.threadId, {
              count: 1,
              tasks: [{
                id: '1',
                brief: promptHead,
                agentHint: spawn.label,
              }],
            })
          }

          const one = await invokeOneSubagent({
            spawn,
            prompt,
            activityStepId: call.id,
            signal,
            toolCtx,
            callId: call.id,
          })
          if (!one.ok) {
            callAgentHistory.push({ agent: spawn.label, promptHead, ok: false })
            return err(`call_agent failed: ${one.error}`)
          }
          callAgentHistory.push({ agent: spawn.label, promptHead, ok: true })
          return ok(one.text)
        }
        case 'call_agents': {
          {
            const gate = await refuseIfLoopAligning(ctx.platform, ctx.channelId, ctx.threadId, 'call_agents')
            if (gate) return err(gate)
          }
          const rawTasks = Array.isArray(args.tasks) ? args.tasks : null
          if (!rawTasks || rawTasks.length === 0) {
            return err('call_agents requires a non-empty `tasks` array.')
          }
          if (rawTasks.length > CALL_AGENTS_TASKS_HARD_MAX) {
            return err(
              `call_agents refused: tasks.length=${rawTasks.length} exceeds hard max ${CALL_AGENTS_TASKS_HARD_MAX}.`,
            )
          }

          type TaskIn = {
            agent: string
            prompt: string
            role?: string
            backend?: string
            isolate?: boolean
          }
          const tasks: TaskIn[] = []
          for (let i = 0; i < rawTasks.length; i++) {
            const t = rawTasks[i]
            if (!t || typeof t !== 'object') {
              return err(`call_agents tasks[${i}] must be an object.`)
            }
            const rec = t as Record<string, unknown>
            const agent = typeof rec.agent === 'string' ? rec.agent : ''
            const prompt = typeof rec.prompt === 'string' ? rec.prompt : ''
            if (!agent || !prompt) {
              return err(`call_agents tasks[${i}] requires both agent and prompt strings.`)
            }
            tasks.push({
              agent,
              prompt,
              role: typeof rec.role === 'string' ? rec.role : undefined,
              backend: typeof rec.backend === 'string' ? rec.backend : undefined,
              isolate: rec.isolate === true,
            })
          }

          if (
            callAgentMaxPerTurn > 0
            && callAgentHistory.length + tasks.length > callAgentMaxPerTurn
          ) {
            log.warn({
              event: 'native.call_agents.cap_exceeded',
              callerAgent: ctx.callerAgent,
              count: callAgentHistory.length,
              batch: tasks.length,
              cap: callAgentMaxPerTurn,
              history: callAgentHistory,
              threadId: ctx.threadId,
            }, `call_agents cap exceeded (${callAgentHistory.length}+${tasks.length}/${callAgentMaxPerTurn})`)
            return err(capExceededError(tasks.length))
          }

          const prepared: Array<{
            index: number
            task: TaskIn
            spawn: SpawnOk
            stepId: string
            promptHead: string
          }> = []
          for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i]!
            const spawn = resolveSubagentSpawn(
              {
                agent: task.agent,
                role: task.role,
                backend: task.backend,
                isolate: task.isolate,
              },
              ctx.callerAgent,
            )
            const stepId = `${call.id}#${i}`
            if (!spawn.ok) {
              try {
                ctx.onToolActivity?.({
                  id: stepId,
                  kind: 'agent',
                  label: task.agent,
                  status: 'error',
                  startedAt: Date.now(),
                  finishedAt: Date.now(),
                  preview: spawn.error.slice(0, 180),
                })
              } catch { /* observer must not break dispatch */ }
              return err(`call_agents tasks[${i}] refused: ${spawn.error}`)
            }
            prepared.push({
              index: i,
              task,
              spawn,
              stepId,
              promptHead: task.prompt.slice(0, 60).replace(/\s+/g, ' '),
            })
          }

          const parallelOn = isSubagentParallelEnabled()
          const concurrency = parallelOn
            ? Math.min(getSubagentParallelMax(), prepared.length)
            : 1
          log.info({
            event: 'native.call_agents.fanout',
            callerAgent: ctx.callerAgent,
            batch: prepared.length,
            parallel: parallelOn,
            concurrency,
            cap: callAgentMaxPerTurn,
            threadId: ctx.threadId,
          }, `call_agents fan-out x${prepared.length} (concurrency=${concurrency})`)

          {
            const { noteLoopDispatch } = await import('../loop-run.js')
            noteLoopDispatch(ctx.platform, ctx.channelId, ctx.threadId, {
              count: prepared.length,
              tasks: prepared.map((p, i) => ({
                id: String(i + 1),
                brief: p.promptHead,
                agentHint: p.spawn.label,
              })),
            })
          }

          type LaneResult = {
            index: number
            agent: string
            label: string
            promptHead: string
            ok: boolean
            cancelled?: boolean
            text?: string
            error?: string
          }

          const laneResults = await mapPool(prepared, concurrency, async (item) => {
            log.info({
              event: 'native.call_agent.delegated',
              callerAgent: ctx.callerAgent,
              calleeAgent: item.spawn.agent,
              subagentLabel: item.spawn.label,
              model: item.spawn.model,
              role: item.spawn.role,
              isolate: item.spawn.isolate,
              sameAgent: item.spawn.sameAgent,
              batchIndex: item.index,
              batchSize: prepared.length,
              attempt: callAgentHistory.length + item.index + 1,
              cap: callAgentMaxPerTurn,
              callerPlanMode: ctx.callerPlanMode ?? false,
              threadId: ctx.threadId,
            }, `delegating batch[${item.index}] → ${item.spawn.label}`)
            const one = await invokeOneSubagent({
              spawn: item.spawn,
              prompt: item.task.prompt,
              activityStepId: item.stepId,
              signal,
              toolCtx,
              callId: `${call.id}-${item.index}`,
            })
            if (!one.ok) {
              return {
                index: item.index,
                agent: item.spawn.agent,
                label: item.spawn.label,
                promptHead: item.promptHead,
                ok: false,
                error: one.error,
              } satisfies LaneResult
            }
            return {
              index: item.index,
              agent: item.spawn.agent,
              label: item.spawn.label,
              promptHead: item.promptHead,
              ok: true,
              cancelled: one.cancelled,
              text: one.text,
            } satisfies LaneResult
          })

          for (const lane of laneResults) {
            callAgentHistory.push({
              agent: lane.label,
              promptHead: lane.promptHead,
              ok: lane.ok,
            })
          }

          const okCount = laneResults.filter((l) => l.ok).length
          const payload = {
            parallel: parallelOn,
            concurrency,
            okCount,
            failCount: laneResults.length - okCount,
            results: laneResults.map((l) => (
              l.ok
                ? {
                    index: l.index,
                    ok: true as const,
                    agent: l.agent,
                    label: l.label,
                    cancelled: l.cancelled === true,
                    result: l.text ?? '',
                  }
                : {
                    index: l.index,
                    ok: false as const,
                    agent: l.agent,
                    label: l.label,
                    error: l.error ?? 'failed',
                  }
            )),
          }
          // Always ok:true at tool level (allSettled) so the parent can synthesize
          // partial successes; per-lane ok flags carry individual outcomes.
          return ok(
            [
              `[call_agents join] ${okCount}/${laneResults.length} succeeded`
              + ` (parallel=${parallelOn ? 'on' : 'off'}, concurrency=${concurrency}).`,
              'Synthesize the lane results below into one Chinese user reply; do not dump raw transcripts.',
              safeJson(payload),
            ].join('\n'),
          )
        }
        case 'focus_set':
        case 'focus_on':
        case 'focus_off':
        case 'focus_clear': {
          const focusMod = await import('../focus.js')
          const loopMod = await import('../loop-run.js')
          if (op === 'focus_set') {
            const title = typeof args.title === 'string' ? args.title.trim() : ''
            if (!title) return err('focus_set failed: title required')
            const existing = focusMod.getFocusOn(ctx.platform, ctx.channelId, ctx.threadId)
            if (existing && args.force !== true) {
              return err('focus_set failed: focus already on (pass force:true to replace)')
            }
            const row = focusMod.setFocus({
              platform: ctx.platform,
              channelId: ctx.channelId,
              threadId: ctx.threadId,
              userId: ctx.userId,
              title,
              body: typeof args.body === 'string' ? args.body : undefined,
              replaceActive: true,
            })
            if (!row) return err('focus_set failed: persist')
            return ok(safeJson({ deprecatedAlias: false, focus: row }))
          }
          if (op === 'focus_on') {
            const r = focusMod.focusOn(ctx.platform, ctx.channelId, ctx.threadId)
            if (!r.ok) return err(`focus_on failed: ${r.error}`)
            return ok(safeJson({ focus: r.focus }))
          }
          if (op === 'focus_off') {
            const r = focusMod.focusOff(ctx.platform, ctx.channelId, ctx.threadId)
            if (!r.ok) return err(`focus_off failed: ${r.error}`)
            loopMod.cancelLoopForFocusOff(ctx.platform, ctx.channelId, ctx.threadId)
            return ok(safeJson({ focus: r.focus }))
          }
          {
            const r = focusMod.focusClear(ctx.platform, ctx.channelId, ctx.threadId)
            loopMod.cancelLoopForFocusOff(ctx.platform, ctx.channelId, ctx.threadId)
            if (!r.ok) return err(`focus_clear failed: ${r.error}`)
            return ok(safeJson({ cleared: true }))
          }
        }
        case 'loop_verdict': {
          {
            const gate = await refuseIfLoopAligning(ctx.platform, ctx.channelId, ctx.threadId, 'loop_verdict')
            if (gate) return err(gate)
          }
          const { applyLoopVerdict } = await import('../loop-run.js')
          const decision = String(args.decision || '')
          if (decision !== 'continue' && decision !== 'revise' && decision !== 'stop') {
            return err('loop_verdict failed: decision must be continue|revise|stop')
          }
          const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
          if (!summary) return err('loop_verdict failed: summary required')
          const r = applyLoopVerdict(ctx.platform, ctx.channelId, ctx.threadId, {
            decision,
            summary,
            met: typeof args.met === 'boolean' ? args.met : undefined,
            nextDirection: typeof args.nextDirection === 'string' ? args.nextDirection : undefined,
            nextHint: typeof args.nextHint === 'string' ? args.nextHint : undefined,
            gaps: Array.isArray(args.gaps)
              ? args.gaps.filter((x): x is string => typeof x === 'string')
              : undefined,
            reasons: Array.isArray(args.reasons)
              ? args.reasons.filter((x): x is string => typeof x === 'string')
              : undefined,
          })
          if (!r.ok) {
            if (r.error === 'no_dispatch') {
              return err(
                'loop_verdict failed: no_dispatch — this Loop round needs ≥1 '
                + 'mcp__agim__call_agents (or call_agent) before continue/revise. '
                + 'Decompose the objective, dispatch, then retry the verdict. '
                + 'Use decision=stop to end without further dispatch.',
              )
            }
            if (r.error === 'need_verification') {
              return err(
                'loop_verdict failed: need_verification — pass met=false, summary, and '
                + 'nextDirection (gaps recommended) after comparing results to Objective.',
              )
            }
            if (r.error === 'need_next_direction') {
              return err(
                'loop_verdict failed: need_next_direction — when met=false, set nextDirection '
                + 'so the next planning round knows what to try.',
              )
            }
            if (r.error === 'met_use_stop') {
              return err(
                'loop_verdict failed: met_use_stop — objective is met; call again with '
                + 'decision=stop and met=true (ends as objective_met).',
              )
            }
            return err(`loop_verdict failed: ${r.error}`)
          }
          return ok(safeJson({
            status: r.run.status,
            round: r.run.round,
            endReason: r.run.endReason,
            lastVerdict: r.run.lastVerdict,
            lastVerification: r.run.lastVerification,
            openedFocus: r.run.openedFocus,
            dispatchesThisRound: r.run.dispatchesThisRound,
          }))
        }
        case 'long_task':
        case 'complete_goal': {
          // Deprecated aliases — long_task → focus_set; complete_goal still CAS for legacy.
          if (op === 'long_task') {
            const focusMod = await import('../focus.js')
            const title = typeof args.goal === 'string' ? args.goal.trim() : ''
            if (!title) return err('long_task failed: goal required')
            const existing = focusMod.getFocusOn(ctx.platform, ctx.channelId, ctx.threadId)
            if (existing && args.force !== true) {
              return err('long_task failed: focus already on (pass force:true); prefer mcp__agim__focus_set')
            }
            const row = focusMod.setFocus({
              platform: ctx.platform,
              channelId: ctx.channelId,
              threadId: ctx.threadId,
              userId: ctx.userId,
              title,
              body: typeof args.summary === 'string' ? args.summary : undefined,
              replaceActive: true,
            })
            if (!row) return err('long_task failed: persist')
            return ok(safeJson({
              deprecated: true,
              prefer: 'mcp__agim__focus_set',
              focus: row,
            }))
          }
          const { handleGoalOp } = await import('../goal-rpc.js')
          const r = await handleGoalOp(op, args, {
            platform: ctx.platform,
            channelId: ctx.channelId,
            threadId: ctx.threadId,
            userId: ctx.userId,
            callerAgent: ctx.callerAgent,
            traceId: toolCtx?.traceId,
            signal,
            workspaceScope: hashWorkspaceScope(
              resolveAgentCwd(AGIM_AGENT_ID, {
                platform: ctx.platform,
                channelId: ctx.channelId,
                threadId: ctx.threadId,
              }) || defaultAgentCwd(AGIM_AGENT_ID),
            ),
          })
          if (!r.ok) return err(`${op} failed: ${r.error}`)
          return ok(safeJson({ deprecated: true, prefer: '/loop or loop_verdict', ...((r.result && typeof r.result === 'object') ? r.result as object : { result: r.result }) }))
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
      log.warn({ event: 'agim.dispatcher.error', name: call.name, err: msg })
      return err(`agim.${op} crashed: ${msg}`)
    } finally {
      void signal // signal is provided for future cancellation; current handlers don't honour it.
    }
  }
}
