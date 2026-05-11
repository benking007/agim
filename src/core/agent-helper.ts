// agent-helper.ts — generic LLM-via-AgentAdapter helper.
//
// Why this layer exists: features that want a small LLM judgement
// (reminder text polish, reminder-intent detection, etc.) MUST NOT bake in
// a specific provider (DeepSeek, OpenAI, …). im-hub is shipped as a
// pluggable framework — every user's LLM access goes through the agent
// they've already registered (claude-code / codex / opencode / copilot /
// any future ACP-discovered remote). So all helper calls funnel through
// one of those adapters via AgentAdapter.sendPrompt.
//
// Selection rule (in order):
//   1. opts.agentName (explicit override; mainly tests)
//   2. The active agent of the IM thread — sessionManager.getExistingSession
//   3. The first registered agent — registry.listAgents()[0]
//   4. null → no LLM available, caller falls back to literal/no-op behavior
//
// Fail-soft contract: any failure returns null. Timeout is a hard cap
// independent of the underlying adapter so a wedged claude-code subprocess
// can't block a reminder fire indefinitely.

import { logger as rootLogger } from './logger.js'
import { registry } from './registry.js'
import { sessionManager } from './session.js'

const log = rootLogger.child({ component: 'agent-helper' })

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_CHARS = 4_000

export interface CallHelperOpts {
  /** IM thread coordinates — used to pick the same agent the user is
   *  currently chatting with. */
  platform: string
  channelId: string
  threadId: string
  /** Behavioral guidance ("you are X, do Y, do not Z"). Most agents don't
   *  expose a native system role, so we prepend it to the user prompt. */
  systemPrompt: string
  /** The actual instruction / payload. */
  userPrompt: string
  /** Hard wall-clock cap. Default 15s. */
  timeoutMs?: number
  /** Stop accumulating output once this many characters arrive. Defends
   *  against a runaway agent and bounds memory. Default 4 000. */
  maxOutputChars?: number
  /** Override agent selection. When omitted, resolveActiveAgent() picks. */
  agentName?: string
}

/**
 * Resolve which agent to use for this thread. Exposed so callers can probe
 * "is an agent available at all?" before composing a heavy prompt.
 *
 * Visible-for-test: takes optional injectable resolvers so unit tests don't
 * need to spin up a real session manager.
 */
export async function resolveActiveAgent(
  platform: string,
  channelId: string,
  threadId: string,
  deps: {
    getExistingSession?: typeof sessionManager.getExistingSession
    listAgents?: () => string[]
  } = {},
): Promise<string | null> {
  const getSession = deps.getExistingSession ?? sessionManager.getExistingSession.bind(sessionManager)
  const listAgents = deps.listAgents ?? (() => registry.listAgents())

  try {
    const session = await getSession(platform, channelId, threadId)
    if (session?.agent) return session.agent
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) },
      'session lookup failed during agent resolution')
  }
  const all = listAgents()
  return all[0] ?? null
}

/**
 * Pick the fastest registered agent for a short helper task (noun
 * extraction, intent classification, etc.). Spawn-cost order, lowest first:
 *
 *   1. opencode — HTTP daemon already running; per-call latency ~1–3 s
 *   2. claude-code — fresh subprocess each call; ~5–10 s spawn cost
 *   3. codex — `codex exec` cold start is ~15–30 s; way too slow for
 *      a micro-task that has a 6 s timeout budget
 *   4. copilot / any other — fallback to first registered
 *
 * Used for inline LLM helpers that block the IM pipeline (memo-extract's
 * `what` extraction, intent detector). Picking the sticky agent would
 * make a feishu-+-codex user pay 15 s per memo save — unacceptable.
 *
 * Falls through to `resolveActiveAgent` semantics if none of the preferred
 * agents are registered.
 */
export function pickFastHelperAgent(
  deps: { listAgents?: () => string[] } = {},
): string | null {
  const all = (deps.listAgents ?? (() => registry.listAgents()))()
  const preferred = ['opencode', 'claude-code', 'codex', 'copilot']
  for (const name of preferred) {
    if (all.includes(name)) return name
  }
  return all[0] ?? null
}

/**
 * Call a helper agent with composed prompts. Returns trimmed output text or
 * null on any failure / timeout / no-agent.
 *
 * The result is *raw* — JSON parsing, truncation, etc. are caller's job.
 */
export async function callHelperAgent(opts: CallHelperOpts): Promise<string | null> {
  const agentName = opts.agentName ?? await resolveActiveAgent(
    opts.platform, opts.channelId, opts.threadId,
  )
  if (!agentName) {
    log.debug({ event: 'helper.no_agent', platform: opts.platform, threadId: opts.threadId },
      'no agent available — caller will fall back')
    return null
  }
  const adapter = registry.getAgent(agentName)
  if (!adapter) {
    log.warn({ event: 'helper.agent_missing', agentName },
      'resolved agent is not registered — caller will fall back')
    return null
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const composed = `${opts.systemPrompt.trim()}\n\n---\n\n${opts.userPrompt.trim()}`

  let acc = ''
  const start = Date.now()
  try {
    const generator = adapter.sendPrompt('llm-helper', composed, [])
    const collect = (async () => {
      for await (const chunk of generator) {
        acc += chunk
        if (acc.length >= maxChars) break
      }
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`helper agent timed out (${timeoutMs}ms)`)), timeoutMs))
    await Promise.race([collect, timeout])
    const text = acc.trim()
    log.debug({
      event: 'helper.ok',
      agent: agentName, elapsedMs: Date.now() - start, chars: text.length,
    }, 'helper call succeeded')
    return text || null
  } catch (err) {
    log.warn({
      event: 'helper.failed',
      agent: agentName, elapsedMs: Date.now() - start,
      err: err instanceof Error ? err.message : String(err),
    }, 'helper agent call failed — caller will fall back')
    return null
  }
}

/**
 * Shorthand for "ask the helper agent and parse the first JSON block out
 * of the response". Returns null on parse failure or LLM failure. Callers
 * should validate the shape with their own type guard.
 */
export async function callHelperForJson<T = unknown>(
  opts: CallHelperOpts,
): Promise<T | null> {
  const raw = await callHelperAgent(opts)
  if (!raw) return null
  // Many adapters wrap output in markdown fences or add prose. Find the
  // first {...} block (non-greedy), then parse.
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) {
    log.debug({ event: 'helper.json.no_match', rawLen: raw.length }, 'no JSON object in helper response')
    return null
  }
  try {
    return JSON.parse(match[0]) as T
  } catch (err) {
    log.debug({
      event: 'helper.json.parse_failed',
      err: err instanceof Error ? err.message : String(err),
      preview: match[0].slice(0, 200),
    }, 'helper JSON parse failed')
    return null
  }
}
