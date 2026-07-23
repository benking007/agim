import type { MessageContext } from '../core/types.js'
import type { RouteContext } from '../core/router.js'
import { generateTraceId, createLogger, sanitizeUserText } from '../core/logger.js'
import { sink } from '../core/message-sink.js'
import { tryHandleApprovalReply } from '../core/approval-router.js'
import { threadKey } from '../core/approval-bus.js'
import { consumeLocationContext, formatLocationAnnotation } from '../core/location-context.js'
import { tryConsumeReply as tryConsumePendingReminderReply } from '../core/pending-reminder.js'
import { createReminder } from '../core/reminders.js'
import { tryDetectReminderIntent } from '../core/remind-intent.js'
import { handleMessage } from './handle-message.js'
import { getDefaultAgent } from '../core/live-config.js'

/**
 * Full interceptor chain for a single inbound messenger message.
 * Extracted verbatim from the start command's messenger.onMessage callback.
 * The caller is responsible for populating ctx.traceId / ctx.logger before
 * calling, though this function sets them itself as a first step.
 */
export async function handleInboundMessage(ctx: MessageContext, defaultAgent: string): Promise<void> {
  const traceId = generateTraceId()
  ctx.traceId = traceId
  ctx.logger = createLogger({ traceId, platform: ctx.platform, component: 'cli' })
  ctx.logger.info({
    event: 'message.received',
    userId: ctx.message.userId,
    ...sanitizeUserText(ctx.message.text),
  })

  // v2 admin model — auto-discover IM identities. Any user who has
  // ever talked to agim appears in Web Settings → Admins as a candidate,
  // so operators never have to hand-type opaque user IDs.
  try {
    const { recordSeenImUser } = await import('../core/admin-allowlist.js')
    recordSeenImUser(ctx.platform, ctx.message.userId, {
      channelId: ctx.channelId,
      threadId: ctx.message.threadId,
    })
  } catch (err) {
    ctx.logger.warn({
      event: 'admin.known_user.record_failed',
      err: err instanceof Error ? err.message : String(err),
    }, 'failed to record known IM user; continuing')
  }

  // v1.2.66 — sender allowlist gate. When configured (env
  // AGIM_ALLOWED_USERS set), unknown senders get a short refusal
  // and the message is dropped before reaching any agent or
  // tool. When unconfigured, this passes through unchanged
  // (default-open; boot log warns OPEN_IM_ACCESS).
  try {
    const { isSenderAllowlistConfigured, isSenderAllowed, senderDenialMessage } =
      await import('../core/sender-allowlist.js')
    const configured = isSenderAllowlistConfigured()
    let allowed = true
    if (configured) {
      try {
        allowed = isSenderAllowed(ctx.platform, ctx.message.userId)
      } catch (err) {
        // v1.3.7 (F6) — a deny-gate must NOT fail open. If the
        // allowlist is configured but we can't evaluate it, treat the
        // sender as NOT allowed rather than silently letting them in.
        ctx.logger.error({
          event: 'sender.allowlist.eval_failed',
          platform: ctx.platform,
          err: err instanceof Error ? err.message : String(err),
        }, 'sender allowlist evaluation failed while configured — failing CLOSED (deny)')
        allowed = false
      }
    }
    if (configured && !allowed) {
      ctx.logger.warn({
        event: 'sender.allowlist.denied',
        platform: ctx.platform,
        userId: ctx.message.userId,
      }, 'message dropped — sender not on AGIM_ALLOWED_USERS')
      try {
        await sink.deliver({
          platform: ctx.platform,
          channelId: ctx.channelId,
          threadId: ctx.message.threadId,
          payload: senderDenialMessage(ctx.platform, ctx.message.userId),
          kind: 'text',
          priority: 'high',
          source: 'system',
        })
      } catch { /* best-effort */ }
      return
    }
  } catch (err) {
    // v1.3.7 (F6) — the module failed to load, so we genuinely cannot
    // tell whether a restriction is configured. Surface LOUDLY (was a
    // quiet fail-open warn). Open posture is preserved only because we
    // can't prove a restriction exists.
    ctx.logger.error({
      event: 'sender.allowlist.error',
      err: err instanceof Error ? err.message : String(err),
    }, 'sender allowlist module failed to load; cannot enforce — review AGIM_ALLOWED_USERS')
  }

  // Phase 3 — interrupted-job recovery reply. If the user has a
  // pending "retry / cancel" prompt outstanding on this thread AND
  // their reply parses as 1/重发/2/取消, consume the message here
  // before any other interceptor (approval / reminder) sees it.
  // hasPendingRecovery is a cheap map lookup; we only do the full
  // parse when the gate is true.
  const recoveryThreadKey = `${ctx.platform}:${ctx.channelId}:${ctx.message.threadId}`
  try {
    const { hasPendingRecovery, tryHandleRecoveryReply } =
      await import('../core/job-recovery.js')
    if (hasPendingRecovery(recoveryThreadKey)) {
      const outcome = tryHandleRecoveryReply(recoveryThreadKey, ctx.message.text)
      if (outcome.kind === 'retried') {
        ctx.logger.info({
          event: 'recovery.retried', oldJobId: outcome.oldJobId, newJobId: outcome.newJobId,
        })
        // Substitute the user's "1" with the original prompt so the
        // rest of the handler reruns the work. handleMessage reads
        // message.text again on its own, so this is the cheapest
        // way to re-enter the normal path without duplicating logic.
        ctx.message.text = outcome.entry.prompt
        // Hand the freshly-created replacement job id to handleMessage
        // so it doesn't build a second inline row (the recovery flow
        // already created newJobId + stamped replaced_by on the old
        // row). Without this we'd accumulate orphan 'pending' rows
        // that retention eventually GCs — visible but harmless.
        ctx.inlineJobId = outcome.newJobId
        // Send a short "好的，重发中..." acknowledgement first so the
        // user knows we accepted the choice (the actual agent reply
        // can take many seconds). priority=normal — slot it after
        // anything urgent in the outbox.
        await sink.deliver({
          platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
          payload: '🔁 好的，重发中…',
          kind: 'text',
        })
        // Fall through to the normal handler below with the rewritten
        // message text.
      } else if (outcome.kind === 'cancelled') {
        ctx.logger.info({ event: 'recovery.cancelled', oldJobId: outcome.oldJobId })
        await sink.deliver({
          platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
          payload: '✅ 已取消，不再处理上次的消息。',
          kind: 'text',
        })
        return
      }
      // outcome.kind === 'not-recovery-reply' → user typed something
      // else; fall through to normal handling so we don't swallow
      // unrelated messages.
    }
  } catch (err) {
    ctx.logger.warn({
      event: 'recovery.intercept_crashed',
      err: err instanceof Error ? err.message : String(err),
    }, 'recovery intercept threw — falling through to normal flow')
  }

  // v1.2.89 — ask_user text-reply intercept. handleAskOp registers
  // a pending entry keyed by (platform, channelId, threadId); when
  // the user replies with one of the choice tokens (1 / a / 通过 / …),
  // we resolve the pending Promise the calling agent is awaiting.
  // BEFORE this commit, tryHandleAskReply was defined but never
  // called from anywhere — so an agent's mcp__agim__ask_user call
  // would surface the choice card but the user's typed reply went
  // straight to the agent as a fresh prompt, leaving the ask
  // dangling until the configured timeout. Runs BEFORE the approval
  // intercept since asks are blocking the calling agent's progress
  // — if both exist on the same thread (rare) the ask wins.
  try {
    const { tryHandleAskReply } = await import('../core/ask-user-router.js')
    if (tryHandleAskReply(ctx.platform, ctx.channelId, ctx.message.threadId, ctx.message.text)) {
      ctx.logger.info({ event: 'message.consumed_by_ask_user' })
      return
    }
  } catch (err) {
    ctx.logger.warn({
      event: 'ask.intercept_crashed',
      err: err instanceof Error ? err.message : String(err),
    }, 'ask-user intercept threw — falling through to normal flow')
  }

  // Approval interception comes BEFORE the agent router. If a pending
  // approval exists for this thread and the message is a y/n-style
  // reply, we resolve the approval and stop. Anything else routes
  // normally (with the side effect of auto-denying any stale pending —
  // see approval-router.ts).
  if (tryHandleApprovalReply(
    threadKey(ctx.platform, ctx.channelId, ctx.message.threadId),
    ctx.message.text,
    ctx.message.userId,
  )) {
    ctx.logger.info({ event: 'message.consumed_by_approval' })
    return
  }

  // Reminder-intent confirmation reply ("y"/"n" to a previously-
  // proposed reminder card). Must come BEFORE the detector so a
  // user replying "y" doesn't get re-detected as another reminder.
  const tk = `${ctx.platform}:${ctx.channelId}:${ctx.message.threadId}`

  // Location-context injection: if the user shared a native pin /
  // venue on Telegram or Feishu within the last 5 min, the adapter
  // stashed the WGS-84 coords in core/location-context. Prepend a
  // structured annotation to the user's text so the agent can decide
  // what to do (save_memo with these coords, ignore, ask follow-up).
  // Single-shot: consuming clears the stash so the next turn doesn't
  // accidentally re-inject. Matches the WeChat H5-flow architecture:
  // the agent is the decision-maker; adapters just surface data.
  const locCtxStash = consumeLocationContext(tk)
  if (locCtxStash) {
    const annotation = formatLocationAnnotation(locCtxStash)
    ctx.message.text = `${annotation}\n\n${ctx.message.text}`
    ctx.logger.info({
      event: 'message.location_context_injected',
      lat: locCtxStash.lat,
      lng: locCtxStash.lng,
      hasVenue: !!locCtxStash.venueLabel,
    })
  }

  const replyDecision = tryConsumePendingReminderReply(tk, ctx.message.text)
  if (replyDecision) {
    if (replyDecision.decision === 'cancel') {
      await sink.deliver({
        platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
        payload: '✅ 已忽略这条提醒建议', kind: 'text',
      })
    } else {
      const p = replyDecision.pending
      try {
        const id = createReminder({
          fireAt: p.fireAt,
          text: p.text,
          platform: ctx.platform,
          channelId: ctx.channelId,
          threadId: ctx.message.threadId,
          userId: ctx.message.userId || '',
          source: 'slash',
          recurrence: p.recurrence,
        })
        const recurLine = p.recurrence ? `\n   循环：${p.recurrence}` : ''
        await sink.deliver({
          platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
          payload: `✅ 已创建提醒 #${id}\n   触发：${p.fireAt.toLocaleString()}${recurLine}\n   内容：${p.text}`,
          kind: 'text',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await sink.deliver({
          platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
          payload: `❌ 创建失败：${msg}`, kind: 'text',
        })
      }
    }
    ctx.logger.info({ event: 'message.consumed_by_pending_reminder', decision: replyDecision.decision })
    return
  }

  // Service-control intent detection — catches "重启服务" / "restart
  // bot" / "状态" etc. BEFORE they reach the LLM, which would
  // otherwise be tempted to run `kill <pid>` or `systemctl restart`
  // and bypass the entire pre-flight + completion-push pipeline.
  // Only on non-slash messages (slash commands have their own
  // parser); slash forms go through routeMessage normally.
  if (!ctx.message.text.trim().startsWith('/')) {
    const { detectServiceIntent } = await import('../core/service-intent.js')
    const svcIntent = detectServiceIntent(ctx.message.text)
    if (svcIntent) {
      ctx.logger.info({
        event: 'service-intent.matched',
        intent: svcIntent.intent,
        confidence: svcIntent.confidence,
        userId: ctx.message.userId,
      })
      const routeCtx: RouteContext = {
        channelId: ctx.channelId,
        threadId: ctx.message.threadId,
        platform: ctx.platform,
        defaultAgent: getDefaultAgent(defaultAgent),
        traceId,
        logger: ctx.logger,
        userId: ctx.message.userId,
      }
      const { handleRestartCommand, handleStopCommand, handleStatusCommand } =
        await import('../core/commands/service.js')
      let reply: string
      if (svcIntent.intent === 'restart') reply = await handleRestartCommand('', routeCtx)
      else if (svcIntent.intent === 'stop') reply = await handleStopCommand('', routeCtx)
      else reply = await handleStatusCommand('', routeCtx)
      // v1.1.10: /restart now delivers its "重启中…" ack synchronously
      // from inside initiateRestart() to win the race against the new
      // process's "✅ 已重启完成…" push. In that case the handler
      // returns an empty string — skip the duplicate sink call.
      if (reply && reply.length > 0) {
        await sink.deliver({
          platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
          payload: reply, kind: 'text',
        })
      }
      return
    }
  }

  // Reminder-intent detector: only on non-slash messages and only
  // when the user has aiwatch on. Cheap regex pre-filter inside the
  // detector skips most messages without a time hint, so the LLM
  // call only fires on plausible candidates.
  if (!ctx.message.text.trim().startsWith('/')) {
    try {
      const detected = await tryDetectReminderIntent({
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.message.threadId,
        userId: ctx.message.userId || '',
        text: ctx.message.text,
      })
      if (detected.handled && detected.reply) {
        await sink.deliver({
          platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
          payload: detected.reply, kind: 'text',
        })
        ctx.logger.info({ event: 'message.proposed_reminder' })
        return
      }
    } catch (err) {
      // Detector must never break the message pipeline. Log and
      // fall through to normal agent dispatch.
      ctx.logger.warn({
        event: 'remind-intent.crashed',
        err: err instanceof Error ? err.message : String(err),
      }, 'detector crashed — falling through to normal agent flow')
    }
  }

  await handleMessage(ctx, defaultAgent)
}
