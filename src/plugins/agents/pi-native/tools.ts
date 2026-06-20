// Assembles the SAME tool surface agim's legacy native engine exposes
// (builtin / fs / web / exec / todo / plan-exit / imhub / external-MCP) for a
// pi-native turn, by reusing native's single-source assembleNativeTools. The
// pi adapter then bridges these ToolDef[] + dispatcher onto pi AgentTool[].

import { resolveAgentCwd, defaultAgentCwd } from '../../../core/agent-cwd.js'
import { threadKey as makeThreadKey } from '../../../core/approval-bus.js'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { effectivePlanModeOn } from '../../../core/plan-mode-state.js'
import type { AgentSendOpts } from '../../../core/types.js'
import { assembleNativeTools } from '../native/tool-registry.js'

export interface PiToolSurface {
  tools: ToolDef[]
  dispatch: ToolDispatcher
  parallelSafe: (toolName: string) => boolean
}

/** Build the per-turn agim tool surface for a pi-native run. Mirrors the
 *  context the legacy native adapter passes to assembleNativeTools. */
export function assembleToolsForPi(opts: AgentSendOpts | undefined, sessionId: string): PiToolSurface {
  const o = opts ?? {}
  const planThreadKey =
    o.platform && o.threadId ? makeThreadKey(o.platform, o.channelId ?? '', o.threadId) : undefined

  const imhubCtx = {
    platform: o.platform || 'native-agent',
    channelId: o.channelId || 'default',
    threadId: o.threadId || sessionId,
    userId: o.userId || 'unknown',
    callerAgent: 'pi-native',
    callerDepth: o.callDepth ?? 0,
    // Propagate plan-mode to any call_agent the imhub dispatcher fires, so a
    // plan-mode parent can't delegate a write task at full access (mirrors the
    // v1.2.154 approval-bus fix on the legacy path).
    callerPlanMode: (planThreadKey ? effectivePlanModeOn(planThreadKey) : false) || o.planMode === true,
  }

  const cwd = resolveAgentCwd('native', o) || defaultAgentCwd('native')

  const assembled = assembleNativeTools({
    cwd,
    rpcCtx:
      o.platform && o.threadId
        ? { platform: o.platform, channelId: o.channelId ?? '', threadId: o.threadId, userId: o.userId ?? '' }
        : undefined,
    todoThreadKey: planThreadKey ?? `pi-native:${sessionId}`,
    planExitCtx: {
      threadKey: planThreadKey ?? `pi-native:${sessionId}`,
      runId: sessionId,
      platform: o.platform,
      channelId: o.channelId,
      threadId: o.threadId,
      userId: o.userId,
    },
    advertisePlanExit: !!(planThreadKey && effectivePlanModeOn(planThreadKey)),
    imhubCtx,
  })

  return {
    tools: assembled.tools,
    dispatch: assembled.dispatch,
    parallelSafe: (name: string) => assembled.isParallelSafe({ id: '', name, arguments: {} }),
  }
}
