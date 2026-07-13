// Message router — parses commands and routes to agents

import type { ParsedMessage, ChatMessage, Session, AgentTurnOutcome } from './types.js'
import type { Logger } from 'pino'
import { randomUUID } from 'node:crypto'
import { registry } from './registry.js'
import { sessionManager } from './session.js'
import { AGENT_SESSION_PERSIST, SUBTASK_AGENT_SESSION } from './agent-session-bindings.js'
import { isAgentAvailableCached, formatAgentNotAvailableError } from './onboarding.js'
import { handleBuiltInCommand } from './commands/builtin.js'
import { handleAgentCommand } from './commands/agent.js'
import { handleAuditCommand } from './commands/audit.js'
import { handleRouterCommand } from './commands/router.js'
import { handleJobCommand } from './commands/job.js'
import { handleOutboxCommand } from './commands/outbox.js'
import { handleA2ACommand } from './commands/a2a.js'
import { handleModelCommand } from './commands/model.js'
import { handleThinkCommand } from './commands/think.js'
import { handleStatsCommand } from './commands/stats.js'
import { handleSessionsCommand } from './commands/sessions.js'
import { handleWorkspacesCommand } from './commands/workspaces.js'
import { handleCronCommand } from './commands/cron.js'
import { handleRemindCommand } from './commands/remind.js'
import { handleMemoCommand } from './commands/memo.js'
import { handleHeartbeatCommand } from './commands/heartbeat.js'
import { handleGoalCommand } from './commands/goal.js'
import { buildGoalSnippet } from './goals.js'
import { handleSkillCommand } from './commands/skill.js'
import { buildSkillsSummary } from './skills/loader.js'
import { buildContextSnippet as buildReminderContextSnippet } from './reminders.js'
import { buildViewerHintSnippet } from './render-router.js'
import { getViewerConfig } from './viewer-config.js'
import { buildPersonaSnippet } from './persona.js'
import { handleApprovalCommand } from './commands/approval.js'
import { handlePlanCommand } from './commands/plan.js'
import { handleWebCommand } from './commands/web.js'
import { logInvocation } from './audit-log.js'
import { circuitBreaker } from './circuit-breaker.js'
import { classifyIntent } from './intent.js'
import { classifyWithLLM, getLLMJudge } from './intent-llm.js'
import { userLimiter } from './rate-limiter.js'
import { workspaceRegistry } from './workspace.js'
import { createInlineJob, getJob } from './job-board.js'

/** Route context passed through the routing pipeline */
export interface RouteContext {
  channelId: string
  threadId: string
  platform: string
  defaultAgent: string
  traceId: string
  logger: Logger
  userId?: string
  /** Set by the routing layer when intent classification picks the agent.
   * Audit log records this so we can answer "why was this agent chosen?". */
  intent?: string
  /** Pre-allocated UUID forwarded to adapters that support a resumable
   * session (currently claude-code's --session-id). Set by cli when an
   * IM message is about to invoke a claude-code run, so the placeholder
   * can show the same id the user will later use with `claude --resume`. */
  agentSessionId?: string
  /** True when the adapter should --resume an existing session under
   *  agentSessionId instead of creating a new one. */
  agentSessionResume?: boolean
  /** Callback invoked by the router once the final agent is determined
   *  (after intent classification). CLI uses this to lazily prepare native
   *  agent sessions (Claude UUID, opencode session, etc.) only for the
   *  agent that will actually run. */
  onAgentResolved?: (agentName: string) => Promise<void>
  /** A2A-L1: inline-jobs row id tracking THIS run. cli.ts stashes the
   *  freshly-created inlineJobId here so callAgentWithHistory forwards it
   *  into AgentSendOpts → adapter.registerRun → RunContext.parentJobId.
   *  Any mcp__agim__call_agent fired from inside the run then knows what
   *  parent_id to stamp on its callee row. */
  parentJobId?: number
  /** A2A-L1: call_depth (0 for user-originated runs). */
  callDepth?: number
  /** Cancellation for the current inbound turn. Inline jobs bind this to the
   *  job-board controller so /abort reaches every adapter. */
  signal?: AbortSignal
  /** Structured terminal state reported by the selected adapter. Consumers
   *  (CLI/job/web) use it after draining the generator. */
  agentOutcome?: AgentTurnOutcome
}

export interface AgentCallOptions {
  /** Session key suffix used for history/user/assistant/usage persistence. */
  storageThreadId?: string
  /** Adapter-native session id override for this invocation. */
  agentSessionId?: string
  /** Adapter-native resume flag override for this invocation. */
  agentSessionResume?: boolean
}

/** Built-in coding agent commands forwarded to the active agent */
const AGENT_COMMANDS = new Set(['test', 'review', 'commit', 'push', 'diff', 'shell', 'bug', 'explain'])

/**
 * Build the rate-limit user-facing error string. Picks the effective
 * limiter (workspace's own limiter for named workspaces, otherwise the
 * shared userLimiter) so the wait estimate matches the bucket that
 * actually rejected the request.
 */
function formatRateLimitError(ws: ReturnType<typeof workspaceRegistry.resolve>, key: string): string {
  const limiter = ws.id === 'default' ? userLimiter : ws.limiter
  const s = limiter.status(key)
  const waitSec = Math.max(0, Math.ceil((limiter.nextAllowAt(key) - Date.now()) / 1000))
  const tail = waitSec > 0 ? `，请在约 ${waitSec} 秒后重试` : ''
  return `⏱️ 请求过于频繁（${s.rate} 次/${s.intervalSec}秒，剩余 ${s.remaining}）${tail}`
}

function displayAgentName(name: string): string {
  return name === 'native' ? 'agim' : name
}

/**
 * Parse a message to determine how to route it
 *
 * Command format: /alias prompt... or /agent-name prompt...
 * Built-in commands: /status, /help, /agents
 */
export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.trim()

  // Empty string → default agent with empty prompt
  if (!trimmed) {
    return { type: 'default', prompt: '' }
  }

  // Plan C (2026-05-22): user-facing coord-system tags. Lowercased and
  // matched on the *entire* message (no args) so casual replies like
  // "#wgs" / "#GCJ" / " #bd " are recognised but bare `#wgs but the
  // marker is still off` falls through to the default agent.
  const coordTagMatch = trimmed.match(/^#(wgs|gcj|bd)0?2?(?:84)?(?:09)?$/i)
  if (coordTagMatch) {
    const sys = coordTagMatch[1].toLowerCase()
    if (sys === 'wgs') return { type: 'coord', system: 'wgs84' }
    if (sys === 'gcj') return { type: 'coord', system: 'gcj02' }
    if (sys === 'bd') return { type: 'coord', system: 'bd09' }
  }

  // Batch 2 (#2 Stop) — natural-language abort phrases. Entire message
  // must match; "停止跑那个" / "stop please" still falls through to the
  // agent so it can decide. Borrowed from openclaw's `/stop` triggers.
  if (/^(停止|停|中止|取消运行|esc|escape)$/i.test(trimmed)) {
    return { type: 'stopAgent' }
  }
  // Standalone "stop" (English) — case-insensitive, no other text.
  if (/^stop$/i.test(trimmed)) {
    return { type: 'stopAgent' }
  }

  // Batch 3 (#6 @multi-agent routing) — `@<agent> <prompt>` at the
  // start of a message routes to that agent, same effect as
  // `/<agent> <prompt>`. The IM platforms (Telegram / Feishu /
  // DingTalk) strip the @-mention of the bot itself before delivery,
  // so any remaining `@…` at the head is a user-typed routing hint.
  // Only registered agent names / aliases match; otherwise it falls
  // through and the agent sees the @ as ordinary text.
  const atMatch = trimmed.match(/^@([\w-]+)(?:\s+([\s\S]*))?$/)
  if (atMatch) {
    const candidate = atMatch[1]
    const rest = atMatch[2] || ''
    const a = registry.findAgent(candidate)
    if (a) {
      return { type: 'agent', agent: a.name, prompt: rest }
    }
  }

  // Check for command prefix
  const match = trimmed.match(/^\/(\S+)\s*(.*)/)
  if (!match) {
    // No command prefix → default agent
    return { type: 'default', prompt: trimmed }
  }

  const [, cmd, rest] = match

  // Built-in commands
  if (cmd === 'start') return { type: 'command', command: 'start', args: rest }
  if (cmd === 'help' || cmd === '?') return { type: 'command', command: 'help', args: rest }
  // Service-control commands. /status read-only / open; /restart + /stop
  // gated on IM admin registry (enforced inside the handler).
  if (cmd === 'status') return { type: 'service', action: 'status', args: rest }
  if (cmd === 'restart') return { type: 'service', action: 'restart', args: rest }
  if (cmd === 'stop') return { type: 'service', action: 'stop', args: rest }
  // /setup — legacy compatibility hint (admin onboarding moved to Web settings).
  if (cmd === 'setup') return { type: 'setup', args: rest }
  if (cmd === 'agents') return { type: 'command', command: 'agents' }
  if (cmd === 'new') return { type: 'command', command: 'new' }
  if (cmd === 'audit') return { type: 'audit', args: rest }
  if (cmd === 'router') return { type: 'router', args: rest }
  if (cmd === 'workspaces' || cmd === 'ws') return { type: 'workspaces', args: rest }
  if (cmd === 'cron') return { type: 'cron', args: rest }
  if (cmd === 'schedule') return { type: 'cron', args: rest, legacy: true }
  if (cmd === 'remind' || cmd === 'reminder') return { type: 'remind', args: rest }
  if (cmd === 'memo' || cmd === '记' || cmd === 'note') return { type: 'memo', args: rest }
  if (cmd === 'heartbeat') return { type: 'heartbeat', args: rest }
  if (cmd === 'goal') return { type: 'goal', args: rest }
  // v1.2.102 — slash aliases for the long_task / complete_goal MCP tools.
  // Field observation: agents (and humans!) tried `/long_task <title>` after
  // the goal-critic recap suggested switching tactics, but got back
  // "Unknown command" because parseMessage had no branch for these — only
  // the MCP tool surface existed. `/long_task X` is equivalent to
  // `/goal set X` (active-goal create); `/complete_goal` is `/goal complete`.
  // Underscored + no-separator forms accepted because IMs vary in keyboard.
  if (cmd === 'long_task' || cmd === 'longtask' || cmd === 'long-task') {
    return { type: 'goal', args: rest ? `set ${rest}` : '' }
  }
  if (cmd === 'complete_goal' || cmd === 'completegoal' || cmd === 'complete-goal') {
    return { type: 'goal', args: 'complete' }
  }
  if (cmd === 'skill' || cmd === 'skills' || cmd === '技能') return { type: 'skill', args: rest }
  if (cmd === 'job' || cmd === 'task') return { type: 'job', args: rest }
  if (cmd === 'outbox') return { type: 'outbox', args: rest }
  if (cmd === 'a2a') return { type: 'a2a', args: rest }
  if (cmd === 'tasks') return { type: 'job', args: 'list' }
  if (cmd === 'check') return { type: 'job', args: `check ${rest}` }
  if (cmd === 'cancel') return { type: 'job', args: `cancel ${rest}` }
  if (cmd === 'switch') return { type: 'job', args: `switch ${rest}` }
  if (cmd === 'collect') return { type: 'job', args: `collect ${rest}` }

    // Model / think / stats / sessions commands
    if (cmd === 'models') return { type: 'model', args: rest ? `list ${rest}` : 'list' }
    if (cmd === 'model' || cmd === 'mode') return { type: 'model', args: rest }
  if (cmd === 'think') return { type: 'think', args: rest }
  if (cmd === 'stats' || cmd === 'usage' || cmd === 'cost') return { type: 'stats', args: rest }
  if (cmd === 'sessions') return { type: 'sessions', args: rest }
  if (cmd === 'approval' || cmd === 'auto') return { type: 'approval', args: rest }
  if (cmd === 'plan') return { type: 'plan', args: rest }
  // /web — print the web console URL (Viewer's public base URL or cloudflared tunnel).
  if (cmd === 'web' || cmd === 'console' || cmd === 'url') return { type: 'web', args: rest }
  // Convenience aliases that map to /plan on|off without typing the subcommand.
  if (cmd === 'plan-on' || cmd === 'planon') return { type: 'plan', args: 'on' }
  if (cmd === 'plan-off' || cmd === 'planoff') return { type: 'plan', args: 'off' }

  // Batch 2 (#2 Stop) — `/abort` always means "abort the running agent
  // on this thread". `/stop` keeps its admin-gated service-stop meaning
  // (see top of this switch). To stop an agent run, prefer `/abort` or
  // plain text "stop" / "停止".
  if (cmd === 'abort') return { type: 'stopAgent' }

  // Batch 2 (#5 /btw) — bypass the per-thread queue and ship a one-shot
  // quick-question into a side sub-thread. The main turn (if any) is
  // left undisturbed.
  if (cmd === 'btw') return { type: 'btw', prompt: rest }

  // Check if it's an agent alias (registered agents take priority over generic commands)
  const agent = registry.findAgent(cmd)
  if (agent) {
    return { type: 'agent', agent: agent.name, prompt: rest }
  }
  const disabledAgent = registry.findRegisteredAgent(cmd)
  if (disabledAgent) {
    return {
      type: 'error',
      prompt: trimmed,
      error: `Agent "${displayAgentName(disabledAgent.name)}" is disabled. Enable it in Web → Agent 设置, or add "${disabledAgent.name}" to config.agents.`,
    }
  }

  // Agent built-in commands (only if no registered agent matches)
  if (AGENT_COMMANDS.has(cmd)) {
    return { type: 'agentCommand', command: cmd, prompt: rest }
  }

  // Unknown command
  return { type: 'error', prompt: trimmed, error: `Unknown command: ${cmd}` }
}

/**
 * Route a parsed message to the appropriate handler
 */
export async function routeMessage(
  parsed: ParsedMessage,
  ctx: RouteContext
): Promise<string | AsyncGenerator<string>> {
  switch (parsed.type) {
    case 'command': {
      return handleBuiltInCommand(parsed.command, ctx, parsed.args)
    }

    case 'agentCommand': {
      return handleAgentCommand(parsed.command, parsed.prompt, ctx)
    }

    case 'audit': {
      return handleAuditCommand(parsed.args, ctx)
    }

    case 'router': {
      return handleRouterCommand(parsed.args, ctx)
    }

    case 'workspaces': {
      return handleWorkspacesCommand(parsed.args, ctx)
    }

    case 'cron': {
      const out = await handleCronCommand(parsed.args, ctx)
      if (parsed.legacy) {
        return `⚠️ \`/schedule\` 已重命名为 \`/cron\`（避免与 Claude Code 内置 /schedule 撞名）。老命令将在 v0.4.0 移除。\n\n${out}`
      }
      return out
    }

    case 'remind': {
      return handleRemindCommand(parsed.args, ctx)
    }

    case 'memo': {
      return handleMemoCommand(parsed.args, ctx)
    }

    case 'heartbeat': {
      return handleHeartbeatCommand(parsed.args, ctx)
    }

    case 'goal': {
      return handleGoalCommand(parsed.args, ctx)
    }

    case 'skill': {
      return handleSkillCommand(parsed.args, ctx)
    }

    case 'job': {
      return handleJobCommand(parsed.args, ctx)
    }

    case 'outbox': {
      return handleOutboxCommand(parsed.args, ctx)
    }

    case 'a2a': {
      return handleA2ACommand(parsed.args, ctx)
    }

    case 'model': {
      return handleModelCommand(parsed.args, ctx)
    }

    case 'think': {
      return handleThinkCommand(parsed.args, ctx)
    }

    case 'stats': {
      return handleStatsCommand(parsed.args, ctx)
    }

    case 'sessions': {
      return handleSessionsCommand(parsed.args, ctx)
    }

    case 'approval': {
      return handleApprovalCommand(parsed.args, ctx)
    }

    case 'plan': {
      return handlePlanCommand(parsed.args, ctx)
    }

    case 'web': {
      return handleWebCommand(parsed.args, ctx)
    }

    case 'coord': {
      const { handleCoordCommand } = await import('./commands/coord.js')
      return handleCoordCommand(parsed.system, ctx)
    }

    case 'stopAgent': {
      const { handleStopAgentCommand } = await import('./commands/stop-agent.js')
      return handleStopAgentCommand(ctx)
    }

    case 'btw': {
      const { handleBtwCommand } = await import('./commands/btw.js')
      return handleBtwCommand(parsed.prompt, ctx)
    }

    case 'service': {
      const { handleRestartCommand, handleStopCommand, handleStatusCommand } =
        await import('./commands/service.js')
      if (parsed.action === 'restart') return handleRestartCommand(parsed.args, ctx)
      if (parsed.action === 'stop') return handleStopCommand(parsed.args, ctx)
      return handleStatusCommand(parsed.args, ctx)
    }

    case 'setup': {
      const { handleSetupCommand } = await import('./commands/setup.js')
      return handleSetupCommand(parsed.args, ctx)
    }

    case 'agent': {
      const agent = registry.findAgent(parsed.agent)
      if (!agent) {
        return `❌ Agent "${parsed.agent}" not found. Use /agents to see available agents.`
      }

      // Workspace whitelist must apply to explicit /<agent> too — otherwise
      // a named workspace with `agents: ['oc']` cannot stop a member from
      // bypassing it via /cc directly.
      const wsAgent = workspaceRegistry.resolve(ctx.userId || 'unknown')
      if (!wsAgent.hasAgent(agent.name)) {
        return `🚫 Agent "${displayAgentName(agent.name)}" is not available in your workspace.\n\nTry /agents to see available agents.`
      }

      // Per-workspace rate limit (falls back to userLimiter for default
      // workspace which has no explicit limiter override).
      const limitKeyAgent = `${ctx.platform}:${ctx.userId || 'unknown'}`
      const allowedAgent = wsAgent.id === 'default'
        ? userLimiter.allow(limitKeyAgent)
        : wsAgent.allow(limitKeyAgent)
      if (!allowedAgent) {
        return formatRateLimitError(wsAgent, limitKeyAgent)
      }

      // peek() is non-consuming: the probe is only claimed once we commit to
      // the actual invocation below (after every early-return path), so the
      // half-open slot is never wasted on a switch/empty-prompt short-circuit.
      if (circuitBreaker.peek(agent.name)) {
        return `⛔ ${displayAgentName(agent.name)} is temporarily unavailable (too many consecutive failures). Try again in a few minutes, or use another agent.`
      }

      if (!(await isAgentAvailableCached(agent.name))) {
        return formatAgentNotAvailableError(agent.name)
      }

      await sessionManager.switchAgent(ctx.platform, ctx.channelId, ctx.threadId, agent.name)

      if (!parsed.prompt) {
        return `✅ Switched to ${displayAgentName(agent.name)}`
      }

      if (ctx.onAgentResolved) {
        await ctx.onAgentResolved(agent.name)
      }

      const session = await sessionManager.getOrCreateSession(
        ctx.platform, ctx.channelId, ctx.threadId, agent.name
      )
      ctx.intent = 'explicit'
      return callAgentWithHistory(agent, session.id, parsed.prompt, session.messages, ctx, session.model, session.variant, session.planMode)
    }

    case 'error': {
      return `❓ ${parsed.error}\n\nUse /help to see available commands.`
    }

    case 'default': {
      // Resolve workspace upfront so rate-limit & whitelist share the same
      // tenant context.
      const ws = workspaceRegistry.resolve(ctx.userId || 'unknown')
      const limitKey = `${ctx.platform}:${ctx.userId || 'unknown'}`
      const allowed = ws.id === 'default'
        ? userLimiter.allow(limitKey)
        : ws.allow(limitKey)
      if (!allowed) {
        return formatRateLimitError(ws, limitKey)
      }

      const existingSession = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)

      // If active subtask, route message to subtask's independent session
      if (existingSession?.activeSubtaskId) {
        const tid = existingSession.activeSubtaskId
        const job = getJob(tid) ?? existingSession.subtasks?.find((subtask) => subtask.id === tid)
        if (!job) {
          return `❌ 任务 #${tid} 已不存在。使用 /job switch main 返回主会话。`
        }
        const tAgent = registry.findAgent(job.agent)
        if (!tAgent) {
          return `❌ 任务 #${tid} 的 Agent "${displayAgentName(job.agent)}" 不可用。`
        }
        const subSession = await sessionManager.getOrCreateSubSession(
          ctx.platform, ctx.channelId, ctx.threadId, tid, job.agent
        )
        if (!parsed.prompt) {
          return `💬 继续对话（任务 #${tid}, ${displayAgentName(job.agent)}）`
        }
        const subThreadId = `${ctx.threadId}:sub:${tid}`
        const callOptions = await prepareSubtaskAgentCallOptions(tAgent.name, ctx, subThreadId, subSession)
        return callAgentWithHistory(
          tAgent, subSession.id, parsed.prompt, subSession.messages, ctx,
          subSession.model, subSession.variant, subSession.planMode, callOptions,
        )
      }

      // Use intent classifier to pick best agent
      const stickyAgent = existingSession?.agent
      let agentName: string
      let intent: string = 'fallback'
      let ruleScore = 0

      try {
        const classification = classifyIntent(parsed.prompt, stickyAgent, ctx.logger, ctx.defaultAgent)
        agentName = classification.agent
        intent = classification.triggeredBy
        ruleScore = classification.score
        ctx.logger.info({ event: 'router.intent', agent: agentName, intent, score: classification.score, reason: classification.reason })
      } catch (err) {
        // L12: don't swallow the error silently — operators tracking down
        // an intent-classifier bug otherwise see a `router.intent.failed`
        // line with no signal about which input or which line threw.
        agentName = stickyAgent || ctx.defaultAgent
        ctx.logger.warn({
          event: 'router.intent.failed',
          fallback: agentName,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
      }

      // P2-H: when the rule-based classifier produced a low-confidence
      // pick (no topic/keyword match) and an LLM judge is configured,
      // ask the judge. We only consider it for *non-sticky* requests so
      // active conversations stay deterministic.
      const judge = getLLMJudge()
      if (judge && intent === 'fallback' && ruleScore < (judge.threshold ?? 1.0) && !stickyAgent) {
        const candidates = workspaceRegistry.resolve(ctx.userId || 'unknown').agentWhitelist.size === 0
          ? registry.listAgents().filter((a) => !circuitBreaker.peek(a))
          : registry.listAgents().filter((a) =>
              !circuitBreaker.peek(a) &&
              workspaceRegistry.resolve(ctx.userId || 'unknown').hasAgent(a))
        const picked = await classifyWithLLM(parsed.prompt, candidates, (n) => registry.findAgent(n))
        if (picked) {
          agentName = picked.agent
          intent = 'llm'
          ctx.logger.info({ event: 'router.intent.llm', agent: agentName, reason: picked.reason })
        }
      }

      // Stash on ctx so callAgentWithHistory writes it into the audit row.
      ctx.intent = intent

      const agent = registry.findAgent(agentName)
      if (!agent) {
        return `❌ Agent "${displayAgentName(agentName)}" not configured.`
      }

      if (circuitBreaker.peek(agent.name)) {
        const openAgents = circuitBreaker.listOpen().map(displayAgentName).join(', ')
        return `⛔ ${displayAgentName(agent.name)} is temporarily unavailable (circuit breaker open).\nCurrently blocked: ${openAgents || 'none'}\n\nTry /agents to see available agents, or wait a few minutes.`
      }

      // Workspace already resolved above — check the whitelist before
      // exposing the agent to the message.
      if (!ws.hasAgent(agent.name)) {
        return `🚫 Agent "${displayAgentName(agent.name)}" is not available in your workspace.\n\nTry /agents to see available agents.`
      }

      if (!(await isAgentAvailableCached(agent.name))) {
        return formatAgentNotAvailableError(agent.name)
      }

      if (!parsed.prompt) {
        return '💬 Send a message to chat with the agent.'
      }

      // Switch session agent if intent picked a different one
      if (agentName !== stickyAgent) {
        await sessionManager.switchAgent(ctx.platform, ctx.channelId, ctx.threadId, agentName)
      }

      // Let CLI prepare native agent sessions now that we know the final agent.
      if (ctx.onAgentResolved) {
        await ctx.onAgentResolved(agentName)
      }

      const session = await sessionManager.getOrCreateSession(
        ctx.platform, ctx.channelId, ctx.threadId, agentName
      )
      return callAgentWithHistory(agent, session.id, parsed.prompt, session.messages, ctx, session.model, session.variant, session.planMode)
    }
  }
}

/**
 * Call agent with conversation history and save messages.
 * Exported so command handlers (commands/*.ts) can reuse it.
 */
export async function callAgentWithHistory(
  agent: ReturnType<typeof registry.findAgent>,
  sessionId: string,
  prompt: string,
  history: ChatMessage[],
  ctx: RouteContext,
  model?: string,
  variant?: string,
  planMode?: boolean,
  options: AgentCallOptions = {},
): Promise<AsyncGenerator<string>> {
  if (!agent) {
    throw new Error('callAgentWithHistory called without a configured agent')
  }
  if (ctx.signal?.aborted) {
    return (async function* (): AsyncGenerator<string> { /* cancelled before side effects */ })()
  }

  const storageThreadId = options.storageThreadId ?? ctx.threadId
  const agentSessionId = options.agentSessionId ?? ctx.agentSessionId
  const agentSessionResume = options.agentSessionResume ?? ctx.agentSessionResume

  // Freeze history before this turn is persisted. Most callers pass the
  // session's live array by reference.
  const priorHistory = history.slice()

  const startTime = Date.now()
  ctx.logger.info({ event: 'agent.invoke.start', agent: agent.name, promptLen: prompt.length, historyLen: history.length })

  // When we're resuming an existing claude session, claude already has the
  // conversation log on disk — feeding history again would duplicate every
  // prior turn in the model's view. Pass an empty history in that case so
  // claude relies purely on its native session memory.
  const effectiveHistory = agentSessionResume ? [] : priorHistory

  // Per-call accumulators for adapters that surface usage / session-id
  // inline (currently opencode). Closure-bound so concurrent runs can't
  // race each other.
  let usageAcc = 0
  let tokensInputAcc = 0
  let tokensOutputAcc = 0
  let unknownCost = false
  let adapterOutcome: AgentTurnOutcome | undefined
  const onAgentSessionId = (id: string): void => {
    // Persist the adapter-reported id on first sighting so the next turn can
    // pass it back via --session / exec resume. Setters are idempotent.
    // Table-driven (see agent-session-bindings.ts) — no per-agent if-chain.
    const binding = AGENT_SESSION_PERSIST[agent.name]
    if (!binding) return
    void binding.persist(ctx.platform, ctx.channelId, storageThreadId, id)
      .catch((err) => ctx.logger.debug({ err: String(err) }, `${binding.logLabel} failed`))
  }
  const onUsage = (delta: {
    costUsd?: number
    tokensInput?: number
    tokensOutput?: number
  }): void => {
    if (typeof delta.costUsd === 'number' && Number.isFinite(delta.costUsd)) usageAcc += delta.costUsd
    if (typeof delta.tokensInput === 'number' && Number.isFinite(delta.tokensInput)) tokensInputAcc += delta.tokensInput
    if (typeof delta.tokensOutput === 'number' && Number.isFinite(delta.tokensOutput)) tokensOutputAcc += delta.tokensOutput
  }
  const onCostMetadata = (metadata: { known: boolean }): void => {
    if (!metadata.known) unknownCost = true
  }
  const onOutcome = (outcome: AgentTurnOutcome): void => {
    adapterOutcome = outcome
    ctx.agentOutcome = outcome
  }

  // Plan mode kill-switch: ops can flip AGIM_DISABLE_PLAN_MODE=1 to ignore
  // every session's planMode flag without redeploying. Matches the same env
  // var that short-circuits the /plan command itself.
  let effectivePlanMode = planMode === true && process.env.AGIM_DISABLE_PLAN_MODE !== '1'

  // v1.2.135 — heuristic auto-enter. When the operator has opted into
  // AGIM_PLAN_INTENT_AUTO and plan mode is currently OFF, a prompt
  // containing a "先想想 / plan only / 等一下别动手" keyword temporarily
  // flips planMode ON for this turn ONLY. The session row stays at
  // off, so the next message goes back to normal unless the user
  // explicitly /plan on or the model itself calls
  // native_exit_plan_mode (v1.2.131). The override never auto-exits.
  if (!effectivePlanMode && process.env.AGIM_DISABLE_PLAN_MODE !== '1') {
    try {
      const { shouldAutoEnterPlanMode } = await import('./plan-intent.js')
      const matched = shouldAutoEnterPlanMode(prompt)
      if (matched) {
        effectivePlanMode = true
        ctx.logger.info({
          event: 'plan-intent.auto-enter',
          agent: agent.name,
          matchedPhrase: matched,
        }, '[plan-intent] auto-entered plan mode for this turn')
      }
    } catch (err) {
      // Best-effort — never break the call path because the heuristic
      // module failed to load.
      ctx.logger.debug({ err: String(err) }, '[plan-intent] detector load failed')
    }
  }

  // Inject pending-reminder context so the agent has live visibility into
  // the user's queue. Only sent OVER THE WIRE — we keep the user's stored
  // history clean (already addMessage'd above) so context isn't duplicated
  // turn-after-turn. Empty when no pending OR no userId (non-IM call).
  const reminderContext = buildReminderContextSnippet(ctx.platform, ctx.userId ?? '')
  // v1.2 — prepend a small IM-render hint when the viewer is enabled so the
  // agent knows to wrap long answers in <im-summary>/<full-md>. Falls back
  // gracefully (sink truncates and links) if the agent ignores the hint.
  const viewerCfg = getViewerConfig()
  const viewerHint = buildViewerHintSnippet({
    viewerEnabled: viewerCfg.enabled && ctx.platform !== 'web',
    thresholds: viewerCfg.thresholds,
  })
  // v1.5 — long-term memory persona block. Tiny header (~150-300 tokens)
  // listing what we know about the user, plus a nudge to call memory_query
  // for details beyond the summary. Empty for first-time users.
  const personaSnippet = buildPersonaSnippet({
    platform: ctx.platform,
    userId: ctx.userId ?? '',
  })
  // P0 #2 — inject the thread's active goal so the agent always sees
  // it and stays on-mission across turns. buildGoalSnippet returns ''
  // when no active goal, so the filter(Boolean) below drops it.
  const goalSnippet = buildGoalSnippet(ctx.platform, ctx.channelId, ctx.threadId)
  // P0 #3 (Stage 3) — inject the agim skills tier-1 summary so every
  // agent reply sees what skills are configured. Empty when no skills
  // installed; filter(Boolean) below drops it cleanly.
  const skillsSnippet = agent.handlesAgimSkillsPrompt ? '' : buildSkillsSummary()
  const headerBlocks = [personaSnippet, goalSnippet, skillsSnippet, viewerHint, reminderContext].filter(Boolean)
  const ephemeralContext = headerBlocks.join('\n\n')
  const wirePrompt = agent.handlesEphemeralContext || !ephemeralContext
    ? prompt
    : `${ephemeralContext}\n${prompt}`

  // A2A coverage: ensure EVERY top-level agent turn has a parent inline job,
  // regardless of entry point. The IM inbound path (cli.ts) pre-creates one
  // and stamps ctx.parentJobId; non-IM entry points (web /api/invoke, mobile
  // web, cron, ACP, …) don't — without a parent id any A2A the agent fires
  // gets parent_id=NULL and is invisible in the web A2A views. Create one here
  // when missing so no channel silently drops A2A records. Idempotent (skips
  // when already set) and best-effort (a failed insert never blocks the turn).
  if (typeof ctx.parentJobId !== 'number') {
    try {
      const pj = createInlineJob({
        agent: agent.name,
        prompt,
        threadKey: `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`,
        creatorId: ctx.userId ?? '',
      })
      if (pj > 0) ctx.parentJobId = pj
    } catch { /* tracking-only; the turn still runs without the anchor row */ }
  }

  const generator = agent.sendPrompt(sessionId, wirePrompt, effectiveHistory, {
    model,
    variant,
    threadId: ctx.threadId,
    platform: ctx.platform,
    userId: ctx.userId,
    channelId: ctx.channelId,
    ...(agent.handlesEphemeralContext && ephemeralContext ? { ephemeralContext } : {}),
    agentSessionId,
    agentSessionResume,
    onAgentSessionId,
    onUsage,
    onCostMetadata,
    onOutcome,
    planMode: effectivePlanMode || undefined,
    // A2A-L1: forward the caller's tracking id + call depth so the
    // adapter can stamp RunContext (consumed by bus.handleA2A).
    parentJobId: ctx.parentJobId,
    callDepth: ctx.callDepth,
    signal: ctx.signal,
    // ADR-0002: forward the inbound turn's trace id so an adapter that mints
    // its own audit rows (native) correlates them back to this message.
    traceId: ctx.traceId,
  })

  return (async function* (): AsyncGenerator<string> {
    let fullResponse = ''
    let invocationError: string | undefined
    let userPersisted = false
    try {
      if (ctx.signal?.aborted) {
        adapterOutcome = { status: 'aborted', providerFailure: false }
        ctx.agentOutcome = adapterOutcome
        return
      }
      // Claim the half-open probe only when the lazy generator actually
      // starts, guaranteeing the finally below will release it.
      circuitBreaker.acquireProbe(agent.name)
      await sessionManager.addMessage(ctx.platform, ctx.channelId, storageThreadId, {
        role: 'user',
        content: prompt,
        timestamp: new Date(),
      })
      userPersisted = true
      if (ctx.signal?.aborted) {
        adapterOutcome = { status: 'aborted', providerFailure: false }
        ctx.agentOutcome = adapterOutcome
        return
      }
      for await (const chunk of generator) {
        fullResponse += chunk
        yield chunk
      }
    } catch (err) {
      invocationError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      const durationMs = Date.now() - startTime
      const outcome: AgentTurnOutcome = adapterOutcome
        ?? (ctx.signal?.aborted
          ? { status: 'aborted' }
          : invocationError
            ? { status: 'error', providerFailure: true, error: invocationError }
            : { status: 'success', providerFailure: false })
      const aborted = outcome.status === 'aborted'
      const successful = outcome.status === 'success' || outcome.status === 'partial'
      const effectiveError = invocationError ?? outcome.error ?? (successful ? undefined : outcome.status)

      if (aborted && userPersisted) {
        await sessionManager.removeLastMessageIfMatches(
          ctx.platform,
          ctx.channelId,
          storageThreadId,
          { role: 'user', content: prompt },
        )
      }

      if (!aborted && fullResponse.trim()) {
        await sessionManager.addMessage(ctx.platform, ctx.channelId, storageThreadId, {
          role: 'assistant',
          content: fullResponse,
          timestamp: new Date()
        })
      }
      ctx.logger.info({
        event: 'agent.invoke.end',
        agent: agent.name,
        durationMs,
        responseLen: fullResponse.length,
        outcome: outcome.status,
      })

      // Cost: prefer the inline usage accumulator (opencode emits this in
      // step_finish events), fall back to legacy `getLastCost` for any
      // adapter that still uses it. Adapters with no usage path default
      // to 0.
      const costFn = (agent as unknown as { getLastCost?: () => number })?.getLastCost
      const legacyCost = typeof costFn === 'function' ? Number(costFn.call(agent)) || 0 : 0
      const cost = usageAcc > 0 ? usageAcc : legacyCost

      logInvocation({
        traceId: ctx.traceId,
        userId: ctx.userId || 'unknown',
        platform: ctx.platform,
        agent: agent.name,
        // Carry the intent the router picked (or 'explicit' for /<agent>
        // commands which set ctx.intent='explicit' upstream).
        intent: ctx.intent || 'default',
        promptLen: prompt.length,
        responseLen: fullResponse.length,
        durationMs,
        cost,
        success: successful,
        error: effectiveError,
      })

      if (invocationError || outcome.providerFailure) {
        circuitBreaker.recordFailure(agent.name)
      } else if (successful) {
        circuitBreaker.recordSuccess(agent.name)
      } else {
        circuitBreaker.recordNeutral(agent.name)
      }

      const hasMeasuredUsage = cost > 0 || tokensInputAcc > 0 || tokensOutputAcc > 0
      if (!aborted || hasMeasuredUsage) {
        // Roll up into the session-level usage so /stats reflects reality.
        await sessionManager.recordUsage(ctx.platform, ctx.channelId, storageThreadId, {
          costUsd: cost,
          costKnown: !unknownCost,
          tokensInput: tokensInputAcc,
          tokensOutput: tokensOutputAcc,
          promptChars: prompt.length,
          responseChars: aborted ? 0 : fullResponse.length,
          durationMs,
        })
      }

      if (outcome.status === 'success') {
        // v1.5 — memory distillation. Fire-and-forget post-reply hook.
        // Runs only when AGIM_MEMORY_ENABLED is on; uses the same agent
        // we just talked to (model-agnostic). Skipped for tiny exchanges.
        try {
          const { scheduleDistillation } = await import('./memory-distill.js')
          scheduleDistillation({
            platform: ctx.platform,
            userId: ctx.userId ?? '',
            userMessage: prompt,
            agentReply: fullResponse,
            agent,
            traceId: ctx.traceId,
          })
        } catch (err) {
          ctx.logger.debug({ event: 'memory.distill.schedule_failed', err: String(err) })
        }
      }
    }
  })()
}

export async function prepareSubtaskAgentCallOptions(
  agentName: string,
  ctx: RouteContext,
  storageThreadId: string,
  subSession: Pick<Session, 'claudeSessionId' | 'claudeSessionPrimed' | 'opencodeSessionId' | 'codexSessionId' | 'antigravitySessionId' | 'kimiSessionId' | 'qoderSessionId' | 'piSessionId' | 'mimoSessionId' | 'copilotSessionId'>,
): Promise<AgentCallOptions> {
  const strategy = SUBTASK_AGENT_SESSION[agentName]
  if (!strategy) return { storageThreadId }

  if (strategy.kind === 'claude-preallocate') {
    let claudeId = subSession.claudeSessionId
    if (!claudeId) {
      claudeId = randomUUID()
      await sessionManager.setClaudeSessionId(ctx.platform, ctx.channelId, storageThreadId, claudeId)
    }
    const resume = !!subSession.claudeSessionPrimed
    if (!resume) {
      await sessionManager.markClaudeSessionPrimed(ctx.platform, ctx.channelId, storageThreadId)
    }
    return { storageThreadId, agentSessionId: claudeId, agentSessionResume: resume }
  }

  if (strategy.kind === 'copilot-preallocate') {
    let copilotId = subSession.copilotSessionId
    if (!copilotId) {
      copilotId = randomUUID()
      await sessionManager.setCopilotSessionId(ctx.platform, ctx.channelId, storageThreadId, copilotId)
    }
    return {
      storageThreadId,
      agentSessionId: copilotId,
      agentSessionResume: !!subSession.copilotSessionId,
    }
  }

  const sid = subSession[strategy.field]
  return {
    storageThreadId,
    agentSessionId: sid,
    agentSessionResume: !!sid,
  }
}
