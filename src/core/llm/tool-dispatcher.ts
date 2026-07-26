// tool-dispatcher — routes a ToolCallRequest to the right executor
// (Stage 2 sub-PR #3).
//
// The agent loop doesn't want to know WHERE each tool lives. It just
// produces a ToolCallRequest and asks the dispatcher to run it. This
// keeps the loop testable (stub dispatcher) and lets us add new tool
// sources (built-in agim tools, sub-agent delegate, etc.) later without
// touching the loop.
//
// Stage 2 sub-PR #3 ships only:
//   - the dispatcher interface (ToolDispatcher)
//   - DispatcherResult shape (text + isError; matches mcp-client)
//   - one concrete implementation: `buildMcpDispatcher()` that routes
//     every call to mcp-registry. Names not in the MCP roster return
//     an isError result rather than throwing.
//   - a `combineDispatchers(...)` helper for future stages that want
//     to layer built-in tools above MCP.
//
// Out of scope here (covered by sub-PR #4):
//   - built-in tool functions (echo / time / web_search) — they're an
//     orthogonal feature; once the loop is stable, adding them is one
//     more dispatcher implementation.

import type { ToolCallRequest } from './provider-base.js'
import { callToolByName as callMcpToolByName, getOwningServer as getMcpOwningServer } from './mcp-registry.js'

/** Outcome of executing one tool call. Mirrors mcp-client.ToolCallResult
 *  so dispatchers can pass it through unchanged. */
export interface DispatcherResult {
  text: string
  isError: boolean
  /** Optional dispatcher tag for audit / debug — e.g. 'mcp:filesystem'
   *  or 'builtin'. Lets the agent loop's audit row distinguish where
   *  the cost is going. Default empty string. */
  source?: string
}

/** v1.2.111 — per-call context the agent loop hands to the dispatcher.
 *  Lets dispatchers that fan out further (notably agim-dispatcher's
 *  call_agent / A2A path) chain the parent trace id instead of minting
 *  a fresh root, so an entire turn's tool chain is traceable end-to-end
 *  via a single trace id prefix. Optional — dispatchers that don't fan
 *  out can ignore. */
export interface ToolDispatcherContext {
  /** Trace id from the calling agent loop's `input.audit?.traceId`.
   *  Undefined when the caller didn't supply one (e.g. test fixtures). */
  traceId?: string
}

/**
 * Async function the agent loop invokes once per tool call. Signal is
 * the loop's overall AbortSignal — dispatchers should honor it to
 * abort in-flight tool work on /stop or timeout. `ctx` was added in
 * v1.2.111 and is optional for backward compatibility; pre-v1.2.111
 * dispatchers ignore the third argument and continue to work.
 */
export type ToolDispatcher = (
  call: ToolCallRequest,
  signal: AbortSignal,
  ctx?: ToolDispatcherContext,
) => Promise<DispatcherResult>

/**
 * Build the default dispatcher: every call name beginning with `mcp_`
 * is routed to the MCP registry; everything else gets a graceful
 * "tool unknown" error. The agent loop's job is to surface that error
 * back to the model so it can choose a different tool or give up.
 */
export function buildMcpDispatcher(): ToolDispatcher {
  return async (call, signal) => {
    if (!call.name.startsWith('mcp_')) {
      return {
        text: `unknown tool "${call.name}" (dispatcher only handles mcp_*; no built-in fallback registered)`,
        isError: true,
        source: 'unknown',
      }
    }
    const r = await callMcpToolByName(call.name, call.arguments, { signal })
    return {
      text: r.text,
      isError: r.isError,
      source: tagFor(call.name),
    }
  }
}

/**
 * Stack dispatchers: the first one that returns a non-"unknown" result
 * wins. Use this in sub-PR #4 to put built-in tools above MCP, so
 * `echo` / `time` etc. resolve locally and don't accidentally hit a
 * server's same-named tool.
 *
 * Implementation note: we identify "unknown" by checking `source ===
 * 'unknown'`. Dispatchers signal "I don't handle this" by returning
 * isError=true with source='unknown'; everything else (including
 * domain-level tool errors) is considered handled.
 */
export function combineDispatchers(...dispatchers: ToolDispatcher[]): ToolDispatcher {
  return async (call, signal, ctx) => {
    let lastUnknown: DispatcherResult | null = null
    for (const d of dispatchers) {
      const r = await d(call, signal, ctx)
      if (r.source === 'unknown') {
        lastUnknown = r
        continue
      }
      return r
    }
    // No dispatcher took it. Surface the last "unknown" message; if
    // somehow nothing returned, synthesise one.
    return lastUnknown ?? {
      text: `unknown tool "${call.name}" (no dispatcher handled it)`,
      isError: true,
      source: 'unknown',
    }
  }
}

/** Map a namespaced MCP tool name back to its owning server for the
 *  audit `source` tag. Falls back to 'mcp:?' if the registry can't
 *  identify the owner (shouldn't happen for valid calls). */
function tagFor(callName: string): string {
  const server = getMcpOwningServer(callName)
  return server ? `mcp:${server}` : 'mcp:?'
}
