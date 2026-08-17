// native/tool-registry — single authoritative assembly of the native
// agent's tool surface (Stage 2 / T2, distilled from the agentic-harness
// "Tool Registry" pattern).
//
// Before this module, native/index.ts hand-built THREE parallel lists:
//   1. a `ToolDef[]` advertised to the model,
//   2. a `combineDispatchers(...)` chain that executed them, and
//   3. a static per-name `parallelSafeTools` Set.
// Adding a tool meant editing all three; forgetting one caused silent
// drift (a tool advertised but not dispatched, or dispatched but never
// classified for concurrency).
//
// Here each tool SOURCE declares its defs, its dispatcher, and its
// concurrency-safe names together, and we assemble them once:
//   - Dispatch order is FIXED (built-ins first) so `combineDispatchers`
//     fall-through + name-collision precedence stay deterministic.
//   - The advertised list keeps the native built-in sources in their stable
//     source order, then appends the DYNAMIC external-MCP partition sorted
//     by name — so a changing MCP server set can't reshuffle the prompt and
//     invalidate the model's prefix cache.
//   - Concurrency is classified PER CALL and FAIL-CLOSED: a tool with no
//     registered safe-marker (or a classifier that throws) runs serially.

import type { ToolCallRequest, ToolDef } from '../../../core/llm/provider-base.js'
import { canonicalizeToolName, toolNameVariants } from '../../../core/llm/tool-names.js'
import {
  buildMcpDispatcher,
  combineDispatchers,
  getAllMcpTools,
  type ToolDispatcher,
} from '../../../core/llm/index.js'
import { buildBuiltinDispatcher, getBuiltinTools } from '../../../core/llm/builtin-dispatcher.js'
import { buildFsDispatcher, getFsTools } from '../../../core/llm/fs-dispatcher.js'
import { buildWebDispatcher, getWebTools } from '../../../core/llm/web-dispatcher.js'
import { buildExecDispatcher, getExecTools } from '../../../core/llm/exec-dispatcher.js'
import { buildTodoDispatcher, getTodoTools } from '../../../core/llm/todo-dispatcher.js'
import { buildPlanExitDispatcher, getPlanExitTools } from '../../../core/llm/plan-exit-dispatcher.js'
import { buildAgimDispatcher, getAgimTools } from '../../../core/llm/agim-dispatcher.js'
import { buildGitDispatcher, getGitTools, GIT_READ_SAFE } from '../../../core/llm/git-dispatcher.js'
import {
  buildCodingGateDispatcher,
  getCodingGateTools,
  CODING_READ_SAFE,
} from '../../../core/llm/coding-gate-dispatcher.js'
import type { ResolvedToolPacks } from '../../../core/llm/tool-packs.js'
import { resolveToolPacksFromLiveConfig } from '../../../core/llm/tool-packs.js'

/** One tool source: defs advertised + dispatcher + concurrency-safe names.
 *  `parallelSafe` lists ONLY genuinely read-only / pure / order-independent
 *  tool names; everything else (and any source that omits a name) is serial
 *  by default — fail-closed. */
interface ToolSource {
  tools: ToolDef[]
  dispatch: ToolDispatcher
  parallelSafe: ReadonlySet<string>
}

export interface AssembleOpts {
  /** Workspace root for fs/exec tools. */
  cwd: string
  /** When set, exec children inherit a thread-scoped RPC token. */
  rpcCtx?: Parameters<typeof buildExecDispatcher>[0]['rpcCtx']
  /** Composite key for the per-thread todo tracker. */
  todoThreadKey: string
  /** Plan-exit dispatcher context. The dispatcher is ALWAYS wired (it
   *  self-refuses when the thread isn't in plan mode); only its advertised
   *  tool is gated by `advertisePlanExit`. */
  planExitCtx: Parameters<typeof buildPlanExitDispatcher>[0]
  /** Advertise the plan-exit tool to the model (only when plan mode is on). */
  advertisePlanExit: boolean
  /** agim (mcp__agim__*) dispatcher context. */
  agimCtx: Parameters<typeof buildAgimDispatcher>[0]
  /**
   * Optional native tool packs. When omitted, resolved from live config
   * (`toolPacks`) so Settings toggles apply on the next turn.
   */
  toolPacks?: ResolvedToolPacks
}

export interface AssembledTools {
  /** Advertised to the model: native built-ins (stable source order) then
   *  the external-MCP partition sorted by name. */
  tools: ToolDef[]
  /** Combined dispatcher, built-ins first. */
  dispatch: ToolDispatcher
  /** Per-call concurrency classifier. Fail-closed: an unknown tool name or a
   *  classifier that throws returns false (serial). */
  isParallelSafe: (call: ToolCallRequest) => boolean
}

// Concurrency-safe names per source. These reproduce exactly the membership
// of the former static NATIVE_PARALLEL_SAFE_TOOLS set, now scoped to the
// source that owns each name (so adding a tool can't forget to classify it).
/** Zero-arg / side-effect-free builtins — also HITL-exempt under allow-list. */
export const BUILTIN_SAFE = new Set(['agim_echo', 'agim_now', 'agim_random_uuid'])
/** Local read-only FS tools (parallel-safe + HITL-exempt under allow-list). */
export const FS_SAFE = new Set(['agim_read_file', 'agim_list_dir', 'agim_glob', 'agim_grep'])
/** Git read tools (status/diff/log). */
export const GIT_SAFE = GIT_READ_SAFE
/** Coding diagnostics (Biome). Test/quality-gate stay serial + approval-gated. */
export const CODING_SAFE = CODING_READ_SAFE
/**
 * Outbound web tools. Parallel-safe + HITL-exempt under allow-list.
 * SSRF still denied at the dispatcher (private/link-local/localhost blocked
 * unless AGIM_URL_ALLOW_PRIVATE=1) — skipping the approval card does not
 * bypass that guard. (Distinct from policy `read-only` mode, which still
 * refuses bare `*fetch*` names via READ_ONLY_HINTS.)
 */
export const WEB_SAFE = new Set(['agim_web_fetch', 'agim_web_search'])
const AGIM_SAFE = new Set([
  'mcp__agim__read_skill', 'mcp__agim__list_skills', 'mcp__agim__search_memos',
  'mcp__agim__memory_list', 'mcp__agim__memory_query',
])
const EMPTY: ReadonlySet<string> = new Set()

/** Default allow-list HITL skip set (deny-all / explicit deny-list still win). */
export const NATIVE_HITL_EXEMPT: ReadonlySet<string> = new Set([
  ...BUILTIN_SAFE,
  ...FS_SAFE,
  ...GIT_SAFE,
  ...CODING_SAFE,
  ...WEB_SAFE,
])

/** Explicit Plan Mode capability allowlist. Unknown/external tools fail closed;
 * side-effecting Agim tools (memo/reminder/goal/push/A2A) are intentionally
 * absent. Plan-exit is the one approval-only state transition allowed. */
export const AGIM_PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...BUILTIN_SAFE,
  'agim_sleep_ms',
  ...FS_SAFE,
  ...GIT_SAFE,
  ...CODING_SAFE,
  ...WEB_SAFE,
  ...AGIM_SAFE,
  'agim_todo_write',
  'agim_exit_plan_mode',
])

/** @deprecated Prefer AGIM_PLAN_MODE_ALLOWED_TOOLS */
export const NATIVE_PLAN_MODE_ALLOWED_TOOLS = AGIM_PLAN_MODE_ALLOWED_TOOLS

export function assembleNativeTools(opts: AssembleOpts): AssembledTools {
  // Source order == dispatch precedence. Built-ins first so a stray MCP tool
  // sharing a native name can't shadow it; external MCP is appended last
  // (below, separately) so it never wins a collision against a first-party tool.
  const packs = opts.toolPacks ?? resolveToolPacksFromLiveConfig()
  const sources: ToolSource[] = [
    { tools: getBuiltinTools(), dispatch: buildBuiltinDispatcher(), parallelSafe: BUILTIN_SAFE },
    { tools: getFsTools(), dispatch: buildFsDispatcher({ cwd: opts.cwd }), parallelSafe: FS_SAFE },
  ]
  if (packs.git) {
    sources.push({
      tools: getGitTools(),
      dispatch: buildGitDispatcher({ cwd: opts.cwd }),
      parallelSafe: GIT_SAFE,
    })
  }
  if (packs.codingGate) {
    sources.push({
      tools: getCodingGateTools(),
      dispatch: buildCodingGateDispatcher({ cwd: opts.cwd }),
      parallelSafe: CODING_SAFE,
    })
  }
  if (packs.web) {
    sources.push({
      tools: getWebTools(),
      dispatch: buildWebDispatcher(),
      parallelSafe: WEB_SAFE,
    })
  }
  sources.push(
    { tools: getExecTools(), dispatch: buildExecDispatcher({ cwd: opts.cwd, rpcCtx: opts.rpcCtx }), parallelSafe: EMPTY },
    { tools: getTodoTools(), dispatch: buildTodoDispatcher(opts.todoThreadKey), parallelSafe: EMPTY },
    // Plan-exit: dispatcher ALWAYS wired (self-refuses off plan mode); tool
    // advertised only in plan mode.
    {
      tools: opts.advertisePlanExit ? getPlanExitTools() : [],
      dispatch: buildPlanExitDispatcher(opts.planExitCtx),
      parallelSafe: EMPTY,
    },
    { tools: getAgimTools(), dispatch: buildAgimDispatcher(opts.agimCtx), parallelSafe: AGIM_SAFE },
  )

  // External MCP — a dynamic partition. Always serial (unknown side effects),
  // sorted by name for prefix-cache stability across server-set changes.
  const mcpTools = getAllMcpTools().slice().sort((a, b) => a.name.localeCompare(b.name))

  const tools: ToolDef[] = [...sources.flatMap((s) => s.tools), ...mcpTools]
  const dispatch = combineDispatchers(...sources.map((s) => s.dispatch), buildMcpDispatcher())

  // Build the per-call safe-name lookup once. External MCP names are absent →
  // they classify as serial (fail-closed) without an explicit entry.
  const safeNames = new Set<string>()
  for (const s of sources) {
    for (const n of s.parallelSafe) {
      for (const v of toolNameVariants(n)) safeNames.add(v)
    }
  }

  const isParallelSafe = (call: ToolCallRequest): boolean => {
    try {
      return safeNames.has(call.name) || safeNames.has(canonicalizeToolName(call.name))
    } catch {
      return false
    }
  }

  return { tools, dispatch, isParallelSafe }
}
