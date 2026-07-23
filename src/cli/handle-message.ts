import { registry } from '../core/registry.js'
import { getDefaultAgent } from '../core/live-config.js'
import { sessionManager } from '../core/session.js'
import { bindTurnAgentSession } from '../core/agent-session-bindings.js'
import { runOnThread } from '../core/thread-queue.js'
import { parseMessage, routeMessage, type RouteContext } from '../core/router.js'
import type { MessageContext } from '../core/types.js'
import { generateTraceId, createLogger } from '../core/logger.js'
import { sink } from '../core/message-sink.js'
import {
  bindJobController, cancelJob, createInlineJob, markJobRunning, markJobCompleted, markJobFailed, linkJobOutbox, updateJobAgent,
} from '../core/job-board.js'

/**
 * Handle incoming message from any messenger
 */
export async function handleMessage(ctx: MessageContext, defaultAgent: string): Promise<void> {
  const { message, platform } = ctx
  const traceId = ctx.traceId || generateTraceId()
  const logger = ctx.logger || createLogger({ traceId, platform, component: 'cli' })

  const messengerName = platform === 'wechat' ? 'wechat-ilink' : platform
  const messenger = registry.getMessenger(messengerName)

  if (!messenger) {
    console.error(`No messenger found for platform: ${platform}`)
    return
  }

  // Agent-name prefix removed — historically we prepended "[opencode]\n\n"
  // / "[codex]\n\n" / etc. so users could see which agent answered when
  // they were on a non-default sticky session. In practice it cluttered
  // every reply (most users only ever stick with one agent per channel)
  // and made memo/reminder confirmations look noisy. If the user wants to
  // know the active agent they can run `/status` or `/router status`.
  const maybePrefix = async (text: string): Promise<string> => text

  const stopTyping = async () => {
    if (messenger.sendTyping) {
      try {
        await messenger.sendTyping(message.threadId, false)
      } catch {
        // Ignore typing errors
      }
    }
  }

  // Build route context with trace.
  // v1.2.103 — read defaultAgent through getDefaultAgent() so the SPA's
  // "default agent" picker takes effect on the very next message instead
  // of waiting for a service restart. The `defaultAgent` parameter is
  // kept as the fallback (tests inject a fixed value; live-config
  // unset → param wins).
  const routeCtx: RouteContext = {
    threadId: message.threadId,
    channelId: ctx.channelId,
    platform,
    defaultAgent: getDefaultAgent(defaultAgent),
    traceId,
    logger,
    userId: message.userId,
  }

  // Thinking placeholder — sent if the adapter supports it, dismissed (when
  // the adapter knows how) just before the real response goes out. Skip for
  // y/n-style approval replies which already get a same-thread effect from
  // the resolved approval card; sending "🤔 思考中…" there would just add
  // noise. We approximate that filter by skipping placeholders for messages
  // that look like single-token approval words.
  let dismissThinking: (() => Promise<void>) | undefined
  const looksLikeApproval = /^\s*[yn]\s*$/i.test(message.text) ||
    /^\s*(批准|拒绝|同意|不同意|通过|可以|不可以|不行|✅|❌)\s*$/.test(message.text)

  // Inline-job tracking id (Phase 2). Declared at function scope so the
  // catch block below can mark the row 'failed' on any throw. -1 means
  // "not tracked": either the message didn't reach willInvokeAgent, or
  // createInlineJob fell back to in-memory (DB locked / AGIM_INLINE_JOB_TRACKING=0).
  let inlineJobId = -1
  let inlineAbortController: AbortController | undefined
  let unbindInlineController: (() => void) | undefined

  try {
    if (messenger.sendTyping) {
      messenger.sendTyping(message.threadId, true).catch(() => {})
    }

    const parsed = parseMessage(message.text)
    logger.debug({ event: 'router.parse', parsed: parsed.type })

    // Only show "🤔 思考中…" for messages that will actually go through the
    // agent — built-in/system commands (/help /status /audit /router etc.)
    // respond instantly so a placeholder would race the real reply.
    const willInvokeAgent =
      (parsed.type === 'default' || parsed.type === 'agent' || parsed.type === 'agentCommand') &&
      !looksLikeApproval

    // Prepare native agent sessions lazily — the router calls
    // onAgentResolved once intent classification picks the final agent,
    // so we never allocate a Claude UUID for an opencode run (or vice versa).
    //
    // Important: claude-code writes its session jsonl as soon as the run
    // starts, so markClaudeSessionPrimed MUST happen before the adapter is
    // invoked. If the run later errors, the next turn must use --resume or
    // claude refuses with "session already exists". We therefore mark
    // primed inside onAgentResolved (right after we wire agentSessionId)
    // rather than after routeMessage returns.
    //
    // Table-driven via bindTurnAgentSession — adding a CLI agent = one
    // row in agent-session-bindings.ts (no cli if-chain growth).
    if (willInvokeAgent) {
      routeCtx.onAgentResolved = async (resolvedAgent: string) => {
        const stickySession = await sessionManager.getExistingSession(
          platform, ctx.channelId, message.threadId,
        )
        const bound = await bindTurnAgentSession(
          resolvedAgent,
          stickySession,
          { platform, channelId: ctx.channelId, threadId: message.threadId },
          { ensureSession: true },
        )
        if (bound.agentSessionId) routeCtx.agentSessionId = bound.agentSessionId
        if (bound.agentSessionResume !== undefined) {
          routeCtx.agentSessionResume = bound.agentSessionResume
        }
      }
    }

    // Inline-job tracking: every agent-bound inbound message gets a row in
    // the jobs table (kind='inline') so the state machine survives crashes
    // and the Phase 3 startup scan can offer the user a retry. Built-ins
    // (status/audit/router) return string immediately and never touch the
    // agent — no point tracking them. Inline tracking can be killed wholesale
    // via env AGIM_INLINE_JOB_TRACKING=0 (createInlineJob returns -1, every
    // mark*Job helper no-ops on id<=0). createInlineJob itself never throws —
    // if the DB is locked or disk-full we get -1 and the user path runs
    // unchanged on the in-memory fast path.
    //
    // We create the row BEFORE entering the runOnThread queue so a stuck
    // queue (or runAgentInvocation crash before the agent runs) still leaves
    // a 'pending' record we can attribute to the user. The agent name is
    // initially defaultAgent and gets corrected from inside onAgentResolved
    // once routing picks the real one.
    //
    // EXCEPTION: when the cli's recovery interceptor handed us a pre-created
    // replacement-job id via ctx.inlineJobId, reuse it. The recovery path
    // had to create the row up-front so it could stamp replaced_by on the
    // old interrupted row atomically; building a second row here would
    // leave the recovery-created one as an orphan 'pending' that retention
    // eventually GCs.
    if (willInvokeAgent) {
      if (ctx.inlineJobId && ctx.inlineJobId > 0) {
        inlineJobId = ctx.inlineJobId
      } else {
        inlineJobId = createInlineJob({
          agent: defaultAgent,
          prompt: message.text,
          threadKey: `${platform}:${ctx.channelId}:${message.threadId}`,
          creatorId: message.userId ?? '',
        })
      }
      inlineAbortController = new AbortController()
      routeCtx.signal = inlineAbortController.signal
      unbindInlineController = bindJobController(inlineJobId, inlineAbortController)
      // A2A-L1: stash on routeCtx so callAgentWithHistory can forward it
      // through AgentSendOpts → adapter.registerRun → RunContext. When the
      // agent fires mcp__agim__call_agent the bus then knows what
      // parent_id to stamp on the callee inline-job row. User-originated
      // runs are call_depth=0; nested runs (A2A callees) reach this same
      // handler with their own ctx.inlineJobId and ctx.callDepth set.
      if (inlineJobId > 0) {
        routeCtx.parentJobId = inlineJobId
        // handleMessage is only the user-inbound path — callDepth is
        // always 0 here. (A2A callees don't traverse this handler; they
        // go through a2a.callAgentByName which passes its own callDepth
        // directly to target.sendPrompt.)
        routeCtx.callDepth = 0
      }
    }

    // Chain the agent-name correction onto the existing onAgentResolved
    // (which already wires native session ids). Both run sequentially —
    // the inline-job update is fast and best-effort.
    const prevOnResolved = routeCtx.onAgentResolved
    if (prevOnResolved || inlineJobId > 0) {
      routeCtx.onAgentResolved = async (resolvedAgent: string) => {
        if (prevOnResolved) await prevOnResolved(resolvedAgent)
        updateJobAgent(inlineJobId, resolvedAgent)
      }
    }

    // The thinking placeholder + agent invocation + response delivery are
    // wrapped into a closure so agent-bound messages can be serialized
    // per-thread via runOnThread (see core/thread-queue.ts). Without
    // serialization, two messages arriving in quick succession on the same
    // threadId race each other into the agent — claude-code blows up on
    // duplicate --session-id, codex / opencode get interleaved I/O, and
    // the user sees mangled responses. Built-ins and approval replies
    // (willInvokeAgent === false) bypass the queue so a `y` reply can
    // still resolve an approval card while an agent run is in flight.
    const runAgentInvocation = async (): Promise<void> => {
      // A queued inline job may have been cancelled before its turn reached
      // the head of runOnThread. CAS pending→running before any side effect;
      // a terminal row must never invoke the adapter later.
      if (willInvokeAgent && (inlineAbortController?.signal.aborted || !markJobRunning(inlineJobId))) {
        logger.info({ event: 'message.cancelled_before_start', jobId: inlineJobId })
        return
      }

      if (willInvokeAgent && messenger.sendThinking) {
        try {
          dismissThinking = await messenger.sendThinking(
            message.threadId,
            '🤔 思考中…',
          )
        } catch (err) {
          logger.debug({ err: String(err) }, 'sendThinking failed')
        }
      }

      // Cancellation can arrive while the thinking placeholder is being sent.
      // Re-check before router side effects (history write / circuit probe).
      if (inlineAbortController?.signal.aborted) {
        await stopTyping()
        if (dismissThinking) {
          try { await dismissThinking() } catch { /* ignore */ }
          dismissThinking = undefined
        }
        return
      }

      const result = await routeMessage(parsed, routeCtx)

      const dismiss = async () => {
        if (dismissThinking) {
          try { await dismissThinking() } catch { /* ignore */ }
          dismissThinking = undefined
        }
      }

      if (inlineAbortController?.signal.aborted && typeof result === 'string') {
        await stopTyping()
        await dismiss()
        return
      }
      // Handle response (string or async generator)
      if (typeof result === 'string') {
        await stopTyping()
        await dismiss()
        if (routeCtx.agentOutcome?.status === 'error' || routeCtx.agentOutcome?.status === 'timeout') {
          markJobFailed(inlineJobId, routeCtx.agentOutcome.error ?? routeCtx.agentOutcome.status)
        } else {
          markJobCompleted(inlineJobId, result)
        }
        // v1.2.73 — `result: string` is no longer exclusively "slash
        // command output". Cases that fall into this branch:
        //   1. slash command (e.g. /job list, /a2a tree, /restart, /audit)
        //      → willInvokeAgent === false → source 'system' (inline)
        //   2. agent error short-circuit (handleAgentCommand returns
        //      "❌ Agent X not available", "❌ Task #N gone" before ever
        //      reaching the adapter) → willInvokeAgent === true →
        //      source 'agent' (so viewer routing can still kick in if
        //      the error happens to be long; usually short → inline)
        //   3. an adapter that returns its FULL reply as a single string
        //      (observed with Codex when it surfaces a markdown-table
        //      response through the agent-call path) → willInvokeAgent
        //      === true → source 'agent' → message-sink can viewer-route
        //      long content. Before this fix the body got force-inlined
        //      as 'system', so markdown tables came through verbatim
        //      and rendered poorly in IM.
        //
        // Empty-string return signals "I already delivered the reply
        // myself" — used by /restart which pushes its in-flight ack via
        // sink with priority='high' to win the race against the new
        // process's completion push. Skip the duplicate sink call.
        if (result.length > 0) {
          const sinkRes = await sink.deliver({
            platform, channelId: ctx.channelId, threadId: message.threadId,
            payload: await maybePrefix(result), kind: 'text',
            jobId: inlineJobId > 0 ? inlineJobId : undefined,
            source: willInvokeAgent ? 'agent' : 'system',
          })
          if (sinkRes.outboxId > 0) linkJobOutbox(inlineJobId, sinkRes.outboxId)
        }
        logger.info({ event: 'message.sent', responseLen: result.length })
      } else {
        // Stream response chunks
        let fullResponse = ''
        for await (const chunk of result) {
          if (inlineAbortController?.signal.aborted) break
          fullResponse += chunk
        }

        await stopTyping()
        await dismiss()

        if (inlineAbortController?.signal.aborted) return
        if (routeCtx.agentOutcome?.status === 'aborted') {
          cancelJob(inlineJobId)
          return
        }

        if (fullResponse) {
          if (routeCtx.agentOutcome?.status === 'error' || routeCtx.agentOutcome?.status === 'timeout') {
            markJobFailed(inlineJobId, routeCtx.agentOutcome.error ?? routeCtx.agentOutcome.status)
          } else {
            markJobCompleted(inlineJobId, fullResponse)
          }
          const sinkRes = await sink.deliver({
            platform, channelId: ctx.channelId, threadId: message.threadId,
            payload: await maybePrefix(fullResponse), kind: 'text',
            jobId: inlineJobId > 0 ? inlineJobId : undefined,
            source: 'agent', // freeform LLM output → eligible for viewer routing
          })
          if (sinkRes.outboxId > 0) linkJobOutbox(inlineJobId, sinkRes.outboxId)
          logger.info({ event: 'message.sent', responseLen: fullResponse.length })
        } else {
          // Empty response is treated as a failure of the inline job —
          // there's nothing to deliver and we don't want the row stuck in
          // 'running' forever. The user already sees nothing; the row gets
          // pruned out of /jobs lists.
          markJobFailed(inlineJobId, 'agent returned empty response')
          logger.warn({ event: 'message.empty_response' })
        }
      }
    }

    if (willInvokeAgent) {
      const queueKey = `${platform}:${ctx.channelId || 'default'}:${message.threadId}`
      await runOnThread(queueKey, runAgentInvocation, {
        onQueued: async (ahead) => {
          logger.info({ event: 'message.queued', ahead, queueKey })
          await sink.deliver({
            platform, channelId: ctx.channelId, threadId: message.threadId,
            payload: `📥 已收到（前面还有 ${ahead} 条在处理，稍后给你结果）`,
            kind: 'text',
          })
        },
      })
    } else {
      await runAgentInvocation()
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    if (inlineAbortController?.signal.aborted) {
      logger.info({ event: 'message.cancelled', jobId: inlineJobId })
      await stopTyping()
      if (dismissThinking) {
        try { await dismissThinking() } catch { /* ignore */ }
      }
      return
    }
    logger.error({ event: 'message.error', error: errMsg })
    await stopTyping()
    if (dismissThinking) {
      try { await dismissThinking() } catch { /* ignore */ }
    }
    // Mark inline job 'failed' before sending the user error — markJobFailed
    // is a no-op for id<=0 (built-ins / inline tracking disabled) and for
    // already-terminal rows. The error blurb still goes through sink so it
    // survives an IM hiccup.
    markJobFailed(inlineJobId, errMsg)
    await sink.deliver({
      platform, channelId: ctx.channelId, threadId: message.threadId,
      payload: '❌ An error occurred processing your message.', kind: 'text',
    }).catch(() => { /* swallow — sink already logs */ })
  } finally {
    unbindInlineController?.()
  }
}
