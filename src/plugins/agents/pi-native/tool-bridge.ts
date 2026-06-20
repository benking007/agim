// Bridges agim's tool surface (ToolDef[] schemas + a ToolDispatcher) onto pi's
// AgentTool[] so the pi-native engine reuses agim's existing builtin / imhub /
// MCP dispatchers unchanged.
//
// Two facts (validated against pi source, see PROJECTS/pi-native-migration.md):
//   - pi accepts a plain JSON Schema as AgentTool.parameters (it reads only
//     .properties / .required). agim's ToolDef.parameters is already that.
//   - pi has NO isError field on a tool result; a tool signals an error by
//     THROWING. agim's DispatcherResult returns { isError }. The bridge
//     translates an isError result into a throw so pi marks the tool result as
//     an error and the dispatcher's text still reaches the model.

import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'

/** A never-aborted signal for when pi invokes execute without one. The agim
 *  ToolDispatcher contract requires a non-optional AbortSignal. */
const NEVER_ABORT = new AbortController().signal

export interface ToolBridgeOptions {
  /** Forwarded into ToolDispatcherContext so dispatchers can correlate audit
   *  rows back to the originating turn. */
  traceId?: string
  /** agim's parallel-safe verdict per tool name (read-only tools may run
   *  concurrently). Defaults to sequential — the safe choice for mutating /
   *  stateful tools. */
  parallelSafe?: (toolName: string) => boolean
}

/** Wrap one agim ToolDef + the shared dispatcher into a pi AgentTool. */
export function agimToolToPi(def: ToolDef, dispatch: ToolDispatcher, opts: ToolBridgeOptions = {}): AgentTool {
  return {
    label: def.name,
    name: def.name,
    description: def.description,
    // pi reads only .properties/.required off this; agim's JSON Schema is fine.
    parameters: def.parameters as AgentTool['parameters'],
    executionMode: opts.parallelSafe?.(def.name) ? 'parallel' : 'sequential',
    execute: async (toolCallId, args, signal) => {
      const result = await dispatch(
        { id: toolCallId, name: def.name, arguments: (args ?? {}) as Record<string, unknown> },
        signal ?? NEVER_ABORT,
        opts.traceId ? { traceId: opts.traceId } : undefined,
      )
      // pi marks errors via throw (no isError field on its result shape).
      if (result.isError) throw new Error(result.text)
      return { content: [{ type: 'text', text: result.text }], details: undefined }
    },
  }
}

/** Bridge a whole agim tool surface at once. */
export function agimToolsToPi(tools: ToolDef[], dispatch: ToolDispatcher, opts: ToolBridgeOptions = {}): AgentTool[] {
  return tools.map((def) => agimToolToPi(def, dispatch, opts))
}
