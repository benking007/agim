// plan-exit-dispatcher — native_exit_plan_mode tool (v1.2.131 P0b).
//
// Mirrors Claude Code's ExitPlanMode handshake:
//   1. Model is in PlanMode (write tools denied at policy gate).
//   2. Model thinks through the plan, then calls `native_exit_plan_mode`
//      with the plan markdown.
//   3. Dispatcher routes the call through the approval-bus so the user
//      sees an IM approval card carrying the plan content.
//   4. On approve: clear per-thread PlanMode, record history,
//      return "approved — proceed" so the model picks up with full
//      write access on the next iteration.
//   5. On reject: record history with reason, return rejection text so
//      the model revises the plan (PlanMode stays ON).
//
// Why a dedicated dispatcher instead of relying on the existing
// PolicyApprovalGate ("askUser" path):
//   * That gate decides allow/deny on an ARBITRARY tool call; here the
//     tool call IS the request — its only payload is markdown.
//   * The outcome's side effect (flipping PlanMode off) needs to happen
//     server-side at dispatch time, not via prompt-instruction to the
//     model.
//   * The plan_history audit row is specific to this tool.
//
// Tool is only advertised when isPlanModeOn(threadKey) is true; the
// roster shrinks back when plan mode flips off.

import { logger as rootLogger } from '../logger.js'
import { approvalBus } from '../approval-bus.js'
import { recordPlanHistory } from '../plan-history.js'
import {
  effectivePlanModeOn,
  setPlanModeForThread,
} from '../plan-mode-state.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { randomUUID } from 'node:crypto'

const log = rootLogger.child({ component: 'plan-exit-dispatcher' })

export const PLAN_EXIT_TOOL_NAME = 'native_exit_plan_mode'

export function isPlanExitToolName(name: string): boolean {
  return name === PLAN_EXIT_TOOL_NAME
}

export interface PlanExitCtx {
  /** Composite thread key (same one PlanMode + Todo use). */
  threadKey: string
  /** agent-loop run identifier — required by approvalBus.registerRun. */
  runId: string
  /** RunContext fields. approvalBus needs these to address the IM card
   *  back to the right thread. When platform/channelId/threadId are
   *  empty, the approval-bus has no way to surface the prompt; we fall
   *  back to a synthetic "auto-approve only if running as loopback CLI"
   *  hint and degrade to immediate rejection so model isn't stuck. */
  platform?: string
  channelId?: string
  threadId?: string
  userId?: string
}

/** Tool definitions to advertise — emitted ONLY when the thread is in
 *  plan mode. The native agent strips it from the roster otherwise so
 *  the model can't accidentally call it from a normal turn. */
export function getPlanExitTools(): ToolDef[] {
  return [
    {
      name: PLAN_EXIT_TOOL_NAME,
      description:
        'Call this when your plan is ready for the user to approve. ' +
        'You MUST already be in Plan Mode (write/exec tools are blocked). ' +
        'Pass a single `plan` argument: a concise markdown description of ' +
        'EXACTLY the steps you will take after approval — one bullet per ' +
        'concrete action. The user will see this in an approval card with ' +
        'Approve / Reject buttons. On approve you regain full write access ' +
        'and should immediately proceed; on reject you stay in Plan Mode ' +
        'and revise the plan based on the user feedback.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description:
              'Markdown plan, ≤ 4000 chars. Use - bullets or numbered steps. ' +
              'Each step should be a single concrete action (read a file, edit X, ' +
              'run command Y). Avoid hand-wavy "review and refactor" — be specific.',
          },
        },
        required: ['plan'],
        additionalProperties: false,
      },
      // The approval handshake can take a while — user might be away.
      // 10 minutes is generous enough for any reasonable round-trip
      // and short enough that a forgotten card doesn't pin a session
      // indefinitely (the approval-bus default timeout still applies
      // independently).
      timeoutMs: 10 * 60 * 1000,
    },
  ]
}

/** Build a per-thread dispatcher. Each agent-loop run gets one; the
 *  closure captures threadKey + runId + IM context. */
export function buildPlanExitDispatcher(ctx: PlanExitCtx): ToolDispatcher {
  return async (call, _signal, _ctxDispatcher): Promise<DispatcherResult> => {
    if (call.name !== PLAN_EXIT_TOOL_NAME) {
      return { text: `not handled: ${call.name}`, isError: true, source: 'unknown' }
    }

    // 1. Validate plan mode IS on. If the model calls this from a
    //    non-plan turn, refuse — the tool only makes sense as the
    //    exit handshake from plan mode.
    if (!ctx.threadKey || !effectivePlanModeOn(ctx.threadKey)) {
      return {
        text:
          'native_exit_plan_mode can only be called while Plan Mode is active. ' +
          'This thread is not in Plan Mode — proceed with normal tool calls.',
        isError: true,
        source: 'plan-exit',
      }
    }

    // 2. Validate + cap the plan markdown. Bigger plans don't help — IM
    //    approval cards are short; force the model to be concise.
    const raw = call.arguments?.plan
    if (typeof raw !== 'string') {
      return { text: '`plan` must be a string', isError: true, source: 'plan-exit' }
    }
    const planMd = raw.trim()
    if (!planMd) {
      return { text: '`plan` is empty', isError: true, source: 'plan-exit' }
    }
    if (planMd.length > 4000) {
      return {
        text: `\`plan\` too long (${planMd.length} > 4000 chars). Tighten it.`,
        isError: true, source: 'plan-exit',
      }
    }

    // 3. Need a real IM thread to surface the approval card. CLI smoke
    //    and tests run without a notifier; in that case we degrade
    //    deterministically with a "no UI to ask" message and stay in
    //    plan mode so the model can recover.
    const platform = ctx.platform
    const threadId = ctx.threadId
    if (!platform || !threadId || !approvalBus.hasNotifier()) {
      recordPlanHistory({
        threadKey: ctx.threadKey,
        planMd,
        outcome: 'rejected',
        detail: 'no IM notifier available — cannot surface approval card',
      })
      return {
        text:
          'No interactive UI is available to confirm this plan ' +
          '(headless / CLI mode). Cannot exit Plan Mode automatically. ' +
          'Ask the operator to run `/plan off` from an IM session.',
        isError: true,
        source: 'plan-exit',
      }
    }

    // 4. Hand off to approval-bus. Same shape as the buildNativeAskUser
    //    flow — we register a synthetic pending and resolve when the
    //    user clicks. Capture wall time so the audit row reports how
    //    long the user took.
    const reqId = randomUUID()
    const t0 = Date.now()
    const decision = await new Promise<{ behavior: 'allow' | 'deny'; reason?: string }>((resolve, reject) => {
      void approvalBus.registerSyntheticPending({
        runId: ctx.runId,
        reqId,
        toolName: PLAN_EXIT_TOOL_NAME,
        input: { plan: planMd },
        ctx: {
          platform,
          channelId: ctx.channelId ?? 'default',
          threadId,
          userId: ctx.userId ?? 'unknown',
          callerAgent: 'native',
        },
        // `message` is only present on the deny branch (Decision is a
        // discriminated union); we narrow defensively so the approve
        // branch's lack of `message` doesn't trip the type checker.
        dispatch: (d) => resolve({
          behavior: d.behavior,
          reason: d.behavior === 'deny' ? d.message : undefined,
        }),
      }).catch((err) => reject(err))
    })
    const pendingMs = Date.now() - t0

    if (decision.behavior === 'allow') {
      // 5a. Flip plan mode OFF for the thread + record audit row.
      //     Use setPlanModeForThread(false) — explicit "this thread is
      //     out", which beats the env default even if env says ON.
      setPlanModeForThread(ctx.threadKey, false)
      recordPlanHistory({
        threadKey: ctx.threadKey,
        planMd,
        outcome: 'approved',
        detail: decision.reason ?? null,
        pendingMs,
      })
      log.info({
        event: 'plan-exit.approved',
        threadKey: ctx.threadKey,
        planLen: planMd.length,
        pendingMs,
      })
      return {
        text:
          'Plan approved by user. You are now OUT of Plan Mode and have full ' +
          'write/exec access for the rest of this conversation. Proceed with ' +
          'the plan exactly as agreed.',
        isError: false,
        source: 'plan-exit',
      }
    }

    // 5b. Reject — keep plan mode on, record audit, give model the
    //     rejection reason so it can revise. Surfaces the reason
    //     directly in tool result so it lands in the next turn's
    //     context window.
    recordPlanHistory({
      threadKey: ctx.threadKey,
      planMd,
      outcome: 'rejected',
      detail: decision.reason ?? null,
      pendingMs,
    })
    log.info({
      event: 'plan-exit.rejected',
      threadKey: ctx.threadKey,
      planLen: planMd.length,
      pendingMs,
      reason: decision.reason,
    })
    const reason = decision.reason?.trim()
    return {
      text:
        'Plan REJECTED by user. You remain in Plan Mode. Revise the plan to ' +
        'address this feedback:\n\n' +
        (reason ? `> ${reason}` : '> (no reason provided)') +
        '\n\nWhen ready, call native_exit_plan_mode again with the revised plan.',
      isError: true,
      source: 'plan-exit',
    }
  }
}
