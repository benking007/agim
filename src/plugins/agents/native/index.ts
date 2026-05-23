// Native AgentAdapter — agim's first in-process LLM agent (Stage 2 sub-PR #4).
//
// The native adapter is the **opt-in backup** path: the CLI agents
// (Claude Code / Codex / OpenCode) keep being the main route for IM
// users, but operators can now ALSO register a native agent that runs
// entirely inside agim — no subprocess spawn, no claude.json, just
// LLM API call + the agent loop from sub-PR #3.
//
// Concrete shape of one IM turn driven by this adapter:
//
//   user message
//      ↓
//   AgentAdapter.sendPrompt(sessionId, prompt, history, opts)
//      ↓
//   1. resolveProvider(role)             ← pick the LLM (role-based)
//   2. build LlmMessage[] from history+prompt
//   3. assemble dispatcher
//        = combineDispatchers(builtin, mcp)
//   4. assemble approval gate (from operator policy config)
//   5. runAgentLoop(...) — multi-iter tool loop
//   6. yield the final text as a SINGLE chunk (buffered) back to the
//      adapter's AsyncGenerator contract
//
// Stage 2 sub-PR #4 deliberately ships:
//   - one LLM call per IM turn (no streaming of incremental thinking
//     to IM; that's a separate feature)
//   - sequential tool execution within each iteration (matches
//     agent-loop's current contract)
//   - policy-based approval (mode=allow-list by default; operators
//     opt into looser modes via env)
//   - the existing tryIntrospect-style usage / cost audit accounting
//
// Out of scope here (covered later):
//   - IM-interactive approval cards (button taps / y-n IM reply); the
//     policy gate is sufficient for the initial release
//   - Streaming partial responses to IM (we already accumulate the
//     final text; partial streaming wants viewer-routing support too)
//   - Session persistence specific to native (we reuse the caller-
//     supplied history; agim's regular session manager handles
//     persistence across turns)

import type {
  AgentAdapter,
  AgentSendOpts,
  ChatMessage,
} from '../../../core/types.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { logInvocation } from '../../../core/audit-log.js'
import {
  runAgentLoop,
  buildMcpDispatcher,
  combineDispatchers,
  getProvider,
  getAllMcpTools,
  type LlmMessage,
  type LlmProvider,
  type ToolDef,
} from '../../../core/llm/index.js'
import {
  buildBuiltinDispatcher,
  getBuiltinTools,
} from '../../../core/llm/builtin-dispatcher.js'
import {
  buildPolicyApprovalGate,
  describePolicy,
  type ApprovalMode,
  type PolicyApprovalGateConfig,
} from '../../../core/llm/policy-approval-gate.js'

const log = rootLogger.child({ component: 'native-agent' })

const DEFAULT_SYSTEM_PROMPT = [
  'You are agim native, an in-process LLM agent talking to a user over an IM platform.',
  'You can call tools (built-in + MCP servers configured by the operator). Prefer tool use over guessing.',
  'When you call a tool, the result is appended as a tool message; reason about it before the next step.',
  'Be terse. Avoid filler. When uncertain, ask one focused clarifying question rather than guessing.',
].join('\n')

/** Role priority for picking which LLM backend powers the native chat
 *  turn. First found wins. Operators can override the role via
 *  `IMHUB_NATIVE_AGENT_ROLE`. */
const DEFAULT_ROLE_FALLBACK: string[] = ['native-chat', 'cheap']

function resolveRole(): string[] {
  const raw = process.env.IMHUB_NATIVE_AGENT_ROLE
  if (raw?.trim()) return [raw.trim(), ...DEFAULT_ROLE_FALLBACK]
  return DEFAULT_ROLE_FALLBACK.slice()
}

function pickProvider(): { provider: LlmProvider; role: string } | null {
  for (const role of resolveRole()) {
    const p = getProvider(role)
    if (p) return { provider: p, role }
  }
  return null
}

/** Resolve the operator's approval policy from env. Defaults to
 *  `allow-list` mode with NO allow entries — equivalent to "no tool
 *  calls". Operators that want native to actually call tools must
 *  configure at least one of these env vars:
 *
 *    IMHUB_NATIVE_AGENT_MODE=allow-all|read-only|allow-list|deny-all
 *    IMHUB_NATIVE_AGENT_AUTOALLOW=tool1,tool2,...
 *    IMHUB_NATIVE_AGENT_DENYLIST=tool1,...
 *
 *  The `read-only` mode is the recommended starter — it accepts every
 *  tool whose name starts/ends with a read-only verb (`read_*` /
 *  `list_*` / `get_*` / etc.) and the four built-ins
 *  (`native_echo`/`now`/`random_uuid` — `sleep_ms` excluded).
 */
function resolvePolicy(): PolicyApprovalGateConfig {
  const mode = (process.env.IMHUB_NATIVE_AGENT_MODE || 'allow-list').toLowerCase() as ApprovalMode
  const autoAllow = splitEnvList(process.env.IMHUB_NATIVE_AGENT_AUTOALLOW)
  const denyList = splitEnvList(process.env.IMHUB_NATIVE_AGENT_DENYLIST)
  // 'native_echo' / 'native_now' / 'native_random_uuid' are safe enough
  // to allow by default in allow-list mode so the agent has SOMETHING
  // to call right out of the box.
  const defaultBuiltins = ['native_echo', 'native_now', 'native_random_uuid']
  const effectiveAllow = mode === 'allow-list'
    ? Array.from(new Set([...autoAllow, ...defaultBuiltins]))
    : autoAllow
  return { mode, autoAllow: effectiveAllow, denyList }
}

function splitEnvList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Are we configured AT ALL to make tool calls? Reflected in startup
 *  log + onboarding hints so the operator notices when they ship
 *  `agents:['native']` without configuring a backend. */
function isConfigured(): boolean {
  return pickProvider() !== null
}

// ─── AgentAdapter implementation ─────────────────────────────────────

class NativeAgentAdapter implements AgentAdapter {
  readonly name = 'native'
  readonly aliases = ['llm', 'native-llm', 'na']
  readonly kind = 'in-process' as const

  /** One-line UI hint surfaced by `/agents`: which LLM role + backend
   *  currently powers this adapter. Returns undefined when not
   *  configured (caller renders 'NOT CONFIGURED' elsewhere). */
  describe(): string | undefined {
    const picked = pickProvider()
    if (!picked) return undefined
    // 'role -> vendor:backend' so a glance at /agents tells you which
    // LLM is wired without opening config.json.
    return `role=${picked.role} -> ${picked.provider.providerType}:${picked.provider.name}`
  }

  async isAvailable(): Promise<boolean> {
    return isConfigured()
  }

  async *sendPrompt(
    sessionId: string,
    prompt: string,
    history: ChatMessage[] = [],
    opts: AgentSendOpts = {},
  ): AsyncGenerator<string> {
    const picked = pickProvider()
    if (!picked) {
      const msg = '❌ native agent: no LLM backend configured for role `native-chat` or `cheap`. Add one in `~/.agim/config.json` `llmBackends`/`llmRoles` (see docs/llm-backends.md).'
      yield msg
      return
    }
    const { provider, role } = picked

    // Build the message array. The native loop accepts a system message
    // either as the first element OR via systemPrompt; we go with the
    // dedicated field so user-supplied history doesn't get clipped by
    // a synthetic system message.
    const messages: LlmMessage[] = []
    for (const m of history) {
      // ChatMessage role is 'user' | 'assistant'; both map straight
      // through. Skip empty content to keep prompts compact.
      if (!m.content) continue
      messages.push({ role: m.role, content: m.content })
    }
    messages.push({ role: 'user', content: prompt })

    // Compose dispatcher: built-in first (so a stray MCP server with
    // a colliding tool name doesn't shadow `native_now` etc.), then MCP.
    const dispatch = combineDispatchers(
      buildBuiltinDispatcher(),
      buildMcpDispatcher(),
    )

    // Compose tool list the same way (built-in first; MCP last; if a
    // collision exists at the LLM-facing level we let it be — providers
    // generally rely on the LATER definition winning).
    const tools: ToolDef[] = [...getBuiltinTools(), ...getAllMcpTools()]

    const policy = resolvePolicy()
    const approve = buildPolicyApprovalGate(policy)

    const startedAt = Date.now()
    log.info({
      event: 'native.turn.start',
      sessionId,
      role,
      backend: provider.name,
      policy: describePolicy(policy),
      tools: tools.length,
      platform: opts.platform,
      threadId: opts.threadId,
    })

    const traceId = `native-${sessionId}-${Date.now()}`
    const result = await runAgentLoop({
      provider,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      messages,
      tools,
      dispatch,
      approve,
      callOptions: {
        model: opts.model,
      },
      audit: {
        agent: `llm:${provider.name}`,
        intent: 'native.agent.iter',
        userId: opts.userId,
        platform: opts.platform || 'native-agent',
        traceId,
      },
    })

    // Per-turn parent audit row that aggregates the iteration rows
    // already written by runAgentLoop. Lets /tasks#cost sum cost per
    // turn rather than per iteration.
    try {
      logInvocation({
        traceId,
        userId: opts.userId ?? '',
        platform: opts.platform || 'native-agent',
        agent: this.name,
        intent: 'native.agent.turn',
        promptLen: prompt.length,
        responseLen: result.text.length,
        durationMs: Date.now() - startedAt,
        cost: typeof result.usage.costUsd === 'number' ? result.usage.costUsd : 0,
        success: result.finishReason !== 'error' && result.finishReason !== 'aborted',
        error: result.error,
      })
    } catch { /* audit best-effort */ }

    // Surface usage to cli's per-session accumulator the same way CLI
    // adapters do (via opts.onUsage). agim's cost dashboard reads from
    // the audit table either way, but the in-memory session usage panel
    // wants it pushed here too.
    if (opts.onUsage && typeof result.usage.costUsd === 'number') {
      try { opts.onUsage({ costUsd: result.usage.costUsd }) } catch { /* best-effort */ }
    }

    log.info({
      event: 'native.turn.done',
      sessionId,
      backend: provider.name,
      finishReason: result.finishReason,
      iterations: result.iterations,
      toolCalls: result.toolCalls.length,
      elapsedMs: Date.now() - startedAt,
    })

    // Compose the user-facing reply. Failure modes surface as ASCII
    // banners so the IM user sees something concrete rather than
    // silence (and so logs in /tasks#cost have a non-empty
    // response_len to filter on).
    let body = result.text
    if (result.finishReason === 'error') {
      body = `❌ native agent error: ${result.error ?? '(no detail)'}`
    } else if (result.finishReason === 'max_iterations') {
      body = '⚠️ native agent hit max iterations without finishing. Try a more focused prompt or raise IMHUB_NATIVE_AGENT_MAX_ITER.'
    } else if (result.finishReason === 'aborted') {
      body = '⏹ native agent aborted before completion.'
    } else if (!body) {
      body = '(native agent returned an empty response)'
    }
    yield body
  }
}

export const nativeAgentAdapter: AgentAdapter = new NativeAgentAdapter()

/** Lightweight banner for cli.ts boot log. Lets operators see at a
 *  glance whether `/cc native` will work before they try it in an IM
 *  thread. */
export function describeNativeAgent(): string {
  const picked = pickProvider()
  if (!picked) return 'native agent: NOT CONFIGURED (no llmRoles.native-chat / .cheap)'
  return `native agent: backend=${picked.provider.name} (role=${picked.role}); policy=${describePolicy(resolvePolicy())}`
}
