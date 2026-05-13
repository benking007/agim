// OpenCode CLI agent adapter — stdio (JSONL) driver.
// Uses `opencode run --format json` for programmatic interaction.
//
// Two flavors of multi-turn continuity, mirroring the claude-code adapter:
//
//   First turn  — no opts.agentSessionId yet. Spawn `opencode run …` plain.
//                 The adapter watches for `sessionID` on the very first event
//                 and reports it back via opts.onAgentSessionId so cli can
//                 persist it on the agim Session row.
//   Later turns — opts.agentSessionId is the captured ses_… id. We pass
//                 `--session <id>` so opencode reads the conversation from
//                 its own DB instead of relying on agim stitching the
//                 history into the prompt. router.callAgentWithHistory
//                 honours this by zeroing out `effectiveHistory` whenever
//                 `agentSessionResume` is true.
//
// Cost accounting: opencode emits `cost` and `tokens.{input,output}` in
// `step_finish` events. We forward those as opts.onUsage deltas so /stats
// reflects opencode reality (it had been hard-coded to 0 before).
//
// Known limitation (the reason OpenCodeHttpAdapter exists): `opencode run`'s
// stdout JSON stream does NOT emit `permission.asked`, and its inline auto-
// reject logic occasionally fails to release the prompt deferred. Result:
// process hangs until the 30-min hard timeout fires. The HTTP driver fixes
// this at the root by driving opencode via its REST + SSE API instead.

import { randomUUID } from 'node:crypto'
import { AgentBase, type SpawnPlan } from '../../../core/agent-base.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'agent.opencode' })

interface OpenCodeEvent {
  type: string
  sessionID?: string
  content?: string
  text?: string
  /**
   * The actual event payload. opencode wraps every meaningful field
   * (text body, cost, tokens, reason) inside `part`, not the top-level
   * event. The outer event only carries `type` / `sessionID` / `timestamp`.
   * Getting this wrong is silently 0 on /stats — we did exactly that in
   * the first cut of this adapter.
   */
  part?: {
    type: string
    text?: string
    tokens?: { input?: number; output?: number; total?: number; reasoning?: number }
    cost?: number
  }
}

export class OpenCodeAdapter extends AgentBase {
  readonly name = 'opencode'
  readonly aliases = ['oc', 'opencodeai']

  protected buildArgs(prompt: string, opts: AgentSendOpts): string[] {
    const args = ['run', '--format', 'json']
    if (opts.agentSessionId) args.push('--session', opts.agentSessionId)
    if (opts.model) args.push('--model', opts.model)
    if (opts.variant) args.push('--variant', opts.variant)
    // planMode → opencode's built-in `plan` agent. Its policy denies edit/
    // write outside .opencode/plans/*.md and allows the LLM to call
    // `plan_exit` when it's done — but we intentionally do NOT auto-flip
    // session.planMode on plan_exit (see docs/architecture/plan-mode.md);
    // the user keeps control of the toggle via /plan off.
    if (opts.planMode) args.push('--agent', 'plan')
    args.push(prompt)
    return args
  }

  /**
   * opencode keys its per-project AGENTS.md and memory off the spawn cwd,
   * so for IM calls we pin to ~/.agim-workspaces/opencode/. Non-IM calls
   * (web/scheduler) keep cwd undefined and inherit agim's cwd, preserving
   * the prior behavior. See agent-cwd.ts for full rationale.
   *
   * MCP context (for the imhub reminder tools): when we have a real IM
   * thread + the bus is running, register a unique runId and inject
   * IMHUB_APPROVAL_SOCK + IMHUB_RUN_ID into the spawn env. opencode forwards
   * its env to MCP server children (per opencode/src/mcp/index.ts:384), so
   * the sidecar inherits these and can route reminder.* RPCs back to the
   * right RunContext. No env injection → sidecar still launches but
   * connects to nothing → reminder tools deny gracefully ("bus unavailable").
   */
  protected async prepareCommand(prompt: string, opts: AgentSendOpts): Promise<SpawnPlan> {
    const args = this.buildArgs(prompt, opts)
    const cwd = resolveAgentCwd(this.name, opts)

    const sockPath = approvalBus.getSocketPath()
    const haveImCtx = !!(opts.threadId && opts.platform && opts.channelId)
    if (!sockPath || !haveImCtx) {
      return { args, cwd }
    }

    const runId = randomUUID()
    approvalBus.registerRun(runId, {
      threadId: opts.threadId as string,
      platform: opts.platform as string,
      userId: opts.userId ?? '',
      channelId: opts.channelId as string,
    })
    log.info({ event: 'opencode.mcp.run_registered', runId, threadId: opts.threadId },
      'opencode run registered with bus for MCP reminder tools')

    return {
      args,
      cwd,
      extraEnv: {
        IMHUB_APPROVAL_SOCK: sockPath,
        IMHUB_RUN_ID: runId,
      },
      cleanup: () => {
        approvalBus.unregisterRun(runId)
      },
    }
  }

  protected extractText(event: unknown): string {
    const e = event as OpenCodeEvent
    if (e.type === 'text' && e.part?.text) return e.part.text
    if (e.type === 'content' && e.content) return e.content
    return ''
  }

  /**
   * Pull metadata out of every event:
   *   - `sessionID` on any event → bubble up via opts.onAgentSessionId so cli
   *     can persist it. Idempotent (the callback handles dedup).
   *   - `cost` / `tokens` on `step_finish` → bubble up via opts.onUsage so
   *     callAgentWithHistory can roll into /stats.
   */
  protected inspectEvent(event: unknown, opts: AgentSendOpts): void {
    const e = event as OpenCodeEvent
    if (e.sessionID && opts.onAgentSessionId) {
      try { opts.onAgentSessionId(e.sessionID) } catch { /* don't let userland callbacks kill the stream */ }
    }
    if (e.type === 'step_finish' && opts.onUsage) {
      // cost / tokens are NESTED inside event.part, not on the event itself.
      const part = e.part
      const delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number } = {}
      if (typeof part?.cost === 'number' && Number.isFinite(part.cost)) delta.costUsd = part.cost
      if (typeof part?.tokens?.input === 'number') delta.tokensInput = part.tokens.input
      if (typeof part?.tokens?.output === 'number') delta.tokensOutput = part.tokens.output
      if (delta.costUsd !== undefined || delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
        try { opts.onUsage(delta) } catch { /* same — user callback safety */ }
      }
    }
  }
}
