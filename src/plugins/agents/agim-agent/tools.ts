// Assembles the Agim Agent tool surface (builtin / fs / web / exec / todo /
// plan-exit / agim / external-MCP), then bridges ToolDef[] + dispatcher onto
// pi AgentTool[].

import { resolveAgentCwd, defaultAgentCwd } from '../../../core/agent-cwd.js'
import { threadKey as makeThreadKey } from '../../../core/approval-bus.js'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { expandToolNameList } from '../../../core/llm/tool-names.js'
import { effectivePlanModeOn } from '../../../core/plan-mode-state.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { assembleNativeTools } from '../agim-agent-shared/tool-registry.js'

export interface NativeToolSurface {
  tools: ToolDef[]
  dispatch: ToolDispatcher
  parallelSafe: (toolName: string) => boolean
}

/** Build the per-turn Agim Agent tool surface. */
export function assembleToolsForPi(opts: AgentSendOpts | undefined, sessionId: string): NativeToolSurface {
  const o = opts ?? {}
  const planThreadKey =
    o.platform && o.threadId ? makeThreadKey(o.platform, o.channelId ?? '', o.threadId) : undefined

  const agimCtx = {
    platform: o.platform || 'native-agent',
    // Keep the same channel key as loopScope / startLoop. Remapping empty
    // to "default" made loop_verdict miss a run stored under "" or "web".
    channelId: o.channelId ?? '',
    threadId: o.threadId || sessionId,
    userId: o.userId || 'unknown',
    callerAgent: 'agim',
    callerDepth: o.callDepth ?? 0,
    ...(typeof o.a2aMaxDepth === 'number' ? { a2aMaxDepth: o.a2aMaxDepth } : {}),
    ...(o.allowedTools && o.allowedTools.length > 0 ? { allowedTools: o.allowedTools } : {}),
    // Link A2A callee rows to the parent turn so the web A2A views can see them.
    ...(typeof o.parentJobId === 'number' ? { parentJobId: o.parentJobId } : {}),
    // Propagate plan-mode to any call_agent the agim dispatcher fires, so a
    // plan-mode parent can't delegate a write task at full access (mirrors the
    // v1.2.154 approval-bus fix on the legacy path).
    callerPlanMode: (planThreadKey ? effectivePlanModeOn(planThreadKey) : false) || o.planMode === true,
    ...(o.stepReflect ? { callerStepReflect: true } : {}),
    ...(o.onToolActivity ? { onToolActivity: o.onToolActivity } : {}),
  }

  const cwd = resolveAgentCwd('agim', o) || defaultAgentCwd('agim')

  const assembled = assembleNativeTools({
    cwd,
    rpcCtx:
      o.platform && o.threadId
        ? { platform: o.platform, channelId: o.channelId ?? '', threadId: o.threadId, userId: o.userId ?? '' }
        : undefined,
    todoThreadKey: planThreadKey ?? `agim:${sessionId}`,
    planExitCtx: {
      threadKey: planThreadKey ?? `agim:${sessionId}`,
      runId: sessionId,
      platform: o.platform,
      channelId: o.channelId,
      threadId: o.threadId,
      userId: o.userId,
    },
    advertisePlanExit: !!(planThreadKey && effectivePlanModeOn(planThreadKey)),
    agimCtx,
  })

  let tools = assembled.tools
  if (o.allowedTools && o.allowedTools.length > 0) {
    const allow = expandToolNameList(o.allowedTools)
    tools = assembled.tools.filter((t) => allow.has(t.name))
    if (tools.length === 0) {
      throw new Error(
        `allowedTools matched no advertised tools (asked: ${o.allowedTools.join(', ')})`,
      )
    }
  }

  return {
    tools,
    dispatch: assembled.dispatch,
    parallelSafe: (name: string) => assembled.isParallelSafe({ id: '', name, arguments: {} }),
  }
}
