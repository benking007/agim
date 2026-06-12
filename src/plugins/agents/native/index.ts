// Native AgentAdapter — agim's first in-process LLM agent (Stage 2 sub-PR #4).
//
// The native adapter is the **opt-in backup** path: the CLI agents
// (Claude Code / Codex / OpenCode) keep being the main route for IM
// users, but operators can now ALSO register a native agent that runs
// entirely inside agim — no subprocess spawn, no claude.json, just
// LLM API call + the agent loop from sub-PR #3.
//
// Concrete shape of one IM turn driven by this adapter:
//
//   user message
//      ↓
//   AgentAdapter.sendPrompt(sessionId, prompt, history, opts)
//      ↓
//   1. resolveProvider(role)             ← pick the LLM (role-based)
//   2. build LlmMessage[] from history+prompt
//   3. assemble dispatcher
//        = combineDispatchers(builtin, mcp)
//   4. assemble approval gate (from operator policy config)
//   5. runAgentLoop(...) — multi-iter tool loop
//   6. yield the final text as a SINGLE chunk (buffered) back to the
//      adapter's AsyncGenerator contract
//
// Stage 2 sub-PR #4 deliberately ships:
//   - one LLM call per IM turn (no streaming of incremental thinking
//     to IM; that's a separate feature)
//   - sequential tool execution within each iteration (matches
//     agent-loop's current contract)
//   - policy-based approval (mode=allow-list by default; operators
//     opt into looser modes via env)
//   - the existing tryIntrospect-style usage / cost audit accounting
//
// Out of scope here (covered later):
//   - IM-interactive approval cards (button taps / y-n IM reply); the
//     policy gate is sufficient for the initial release
//   - Streaming partial responses to IM (we already accumulate the
//     final text; partial streaming wants viewer-routing support too)
//   - Session persistence specific to native (we reuse the caller-
//     supplied history; agim's regular session manager handles
//     persistence across turns)

import type {
  AgentAdapter,
  AgentSendOpts,
  ChatMessage,
} from '../../../core/types.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { logInvocation } from '../../../core/audit-log.js'
import {
  runAgentLoop,
  getProvider,
  type LlmMessage,
  type LlmProvider,
} from '../../../core/llm/index.js'
import {
  buildPolicyApprovalGate,
  describePolicy,
  type ApprovalMode,
  type PolicyApprovalGateConfig,
} from '../../../core/llm/policy-approval-gate.js'
// Tool assembly (defs + dispatch + per-call concurrency classifier) moved
// into tool-registry.ts (#86); the per-dispatcher builder imports live there
// now. MAX_INJECTED_SKILLS is still needed here for the system-prompt skills
// cap (#85/T3).
import { assembleNativeTools } from './tool-registry.js'
import { listSkills, MAX_INJECTED_SKILLS } from '../../../core/skills/loader.js'
import { describeRegistry as describeMcpRegistry } from '../../../core/llm/mcp-registry.js'
import { resolveAgentCwd, defaultAgentCwd } from '../../../core/agent-cwd.js'
import { handlePushOp } from '../../../core/push-rpc.js'
import { approvalBus, threadKey as makeThreadKey } from '../../../core/approval-bus.js'
import { effectivePlanModeOn } from '../../../core/plan-mode-state.js'
import { randomUUID as _nativeRandomUUID } from 'node:crypto'
import type { ToolCallRequest } from '../../../core/llm/provider-base.js'
import { maybeCompactHistory } from '../../../core/llm/auto-compact.js'
import { existsSync as fsExistsSync, statSync as fsStatSync, readFileSync as fsReadFileSync } from 'node:fs'
import { resolve as pathResolve, sep as pathSep, join as pathJoin } from 'node:path'
import { sanitizeForInjection, scanForInjectionAttempts } from '../../../core/prompt-injection-guard.js'

const log = rootLogger.child({ component: 'native-agent' })

/**
 * v1.2.147 — framework-level tool-call discipline injected into EVERY
 * native turn's system prompt. Sits at the top, before the operator
 * role definition, so it dominates any persona-level rules the user
 * authors. Pure prompt — paired with the runtime hallucination
 * detector (`detectHallucinatedToolCall`) that catches the failure
 * mode if the model ignores the rule.
 *
 * Why this is hard-coded, not optional:
 *   - The failure (model narrates a tool call without emitting it) is
 *     LLM-side and silent; we cannot fully prevent it. But almost every
 *     instance we've seen would have been deterred by an explicit
 *     "do not narrate, just emit" rule.
 *   - Leaving this to operator AGENTS.md means every fresh install
 *     reproduces the same harm before the operator notices.
 *   - Escape hatch: IMHUB_NATIVE_TOOL_DISCIPLINE=off (or 0/false/no/
 *     disable) lets advanced operators drop the block, e.g. when
 *     measuring whether the prompt itself is hurting tool-call recall.
 */
const TOOL_CALL_DISCIPLINE_PROMPT = [
  '## 工具调用纪律（agim 框架级硬约束）',
  '',
  '- 禁止用文本"描述/演练"工具调用。例如不可输出 `我现在调用 native_write_file: \\`\\`\\`python ...\\`\\`\\`` —— 想用工具就直接发 `toolCalls`，不要先用纯文本预告。',
  '- 工具调用必须真的发生：如果当轮没真正发出 `toolCalls`，就不要输出"已经写好 / 已经存好 / 已经调了 X"这类口径，更不要承诺"下一步直接写"。',
  '- 不确定是否该调用，用 `native_todo_write` 把意图留为 todo 让用户审，不要假装调用了又没调。',
  '- 用户追问"做了吗 / 写好了吗 / 又没消息了"，先回顾本轮 `toolCalls` 历史；没有就直接坦白"没调成"，禁止编造"这次直接写""不废话了"等空承诺——空承诺没有任何代价但会摧毁信任。',
  '- write / edit / exec 类副作用工具一次性写完整调用，不要分两步"先承诺再调用"。',
  '',
  '（运行时会有 hallucination 检测器在末轮抓"narrate without emit"，触发会用复盘卡替换原回复。）',
].join('\n')

/**
 * Read the IMHUB_NATIVE_TOOL_DISCIPLINE kill-switch. Default ON.
 * Recognized OFF values: 'off' / '0' / 'false' / 'no' / 'disable'.
 * Pairs with isHallucinationDetectorOn (hallucination-detector.ts): the
 * detector still fires when discipline is off, by design — discipline
 * removed is a prompting test, not a license to ship lies.
 */
export function isToolDisciplineOn(): boolean {
  const raw = (process.env.IMHUB_NATIVE_TOOL_DISCIPLINE ?? '').toLowerCase().trim()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no' || raw === 'disable') {
    return false
  }
  return true
}

/**
 * v1.2.47 — system prompt is rebuilt per IM turn so the model sees:
 *   - which LLM backend + role it's actually running on
 *   - the agim process working directory (no per-thread cwd today)
 *   - the live skill roster (names + one-line descriptions), with the
 *     hint to call mcp__imhub__read_skill for full bodies
 *   - external MCP servers currently connected
 *
 * Before v1.2.47 the prompt was a 4-line generic string; users
 * complained that asking "what model are you" / "what skills do you
 * have" got non-answers ("I don't know; ask the operator"). The
 * builder closes that information gap without leaking secrets — every
 * field surfaced here is operator-configured and non-sensitive.
 */
export function buildSystemPrompt(
  provider: LlmProvider,
  role: string,
  cwd: string,
  threadKey?: string,
): string {
  // T3 (context-as-budget): bound the tier-1 skills listing. listSkills()
  // already caps each description at MAX_DESCRIPTION_CHARS; here we also cap
  // the COUNT to MAX_INJECTED_SKILLS (the same ceiling buildSkillsSummary
  // uses) so a large catalog can't blow the per-turn system-prompt budget.
  // Sorted for stable ordering; overflow collapses into a "+N more" hint
  // that points the model at the on-demand read_skill / /skill list path.
  // (Previously this re-rolled an UNCAPPED `name: desc` line per skill.)
  const allSkills = listSkills().slice().sort((a, b) => a.name.localeCompare(b.name))
  const visibleSkills = allSkills.slice(0, MAX_INJECTED_SKILLS)
  const skillsBlock = visibleSkills.length
    ? visibleSkills
        .map((s) => {
          const desc = (s.description || '').trim() || '(no description; read body via mcp__imhub__read_skill)'
          const mark = s.available ? '' : ` (unavailable: ${s.unavailableReason ?? 'requires not met'})`
          return `  - ${s.name}: ${desc}${mark}`
        })
        .join('\n')
      + (allSkills.length > visibleSkills.length
          ? `\n  … and ${allSkills.length - visibleSkills.length} more (use /skill list; read any with mcp__imhub__read_skill)`
          : '')
    : '  (no skill cards loaded; see docs/skills.md to add one)'
  const mcpReg = describeMcpRegistry()
  const externalMcp = mcpReg.servers.length
    ? mcpReg.servers
        .map((s) => `  - ${s.name} (${s.connected ? `${s.toolCount} tools` : `disconnected${s.error ? `: ${s.error}` : ''}`})`)
        .join('\n')
    : '  (none configured)'

  const lines: string[] = []

  // v1.2.147 — framework-level tool-call discipline. Prepended BEFORE
  // the operator role so it dominates persona-level rules. Hard-coded
  // (not derived from a file) so every fresh agim install gets it, no
  // per-user setup. Pairs with the runtime hallucination detector.
  if (isToolDisciplineOn()) {
    lines.push('[agim framework rule — tool-call discipline]')
    lines.push(TOOL_CALL_DISCIPLINE_PROMPT)
    lines.push('[/agim framework rule]')
    lines.push('')
  }

  // Operator-supplied role definition. Reads <cwd>/AGENTS.md (seeded by
  // bootstrapAgentWorkspaces) and prepends it as a role block. Lets
  // operators customise the agent's identity, tone, and house rules
  // without touching code. Sanitised + scanned for prompt-injection
  // patterns (best-effort warn; never blocks turn).
  const opRole = readOperatorRole(cwd)
  if (opRole) {
    lines.push('[operator role definition]')
    lines.push(opRole)
    lines.push('[/operator role definition]')
    lines.push('')
  }

  lines.push(
    `You are agim native — agim's in-process LLM agent talking to a user over an IM platform.`,
    ``,
    `Runtime:`,
    `  Backend:           ${provider.providerType}:${provider.name}`,
    `  Role:              ${role}`,
    `  Working directory: ${cwd}`,
    ``,
  )

  // v1.2.119 — PlanMode banner. When the env knob is on, prepend a
  // high-priority instruction block so the model knows up-front it
  // can't write/exec. Without this banner, the deny verdict from
  // the policy gate gives a bare "tool call denied" message and the
  // model wastes iterations trying alternative write paths.
  if (isPlanModeOn(threadKey)) {
    lines.push(
      `⚠ Plan mode is ACTIVE`,
      `  - You MUST produce a read-only plan; native_write_file and native_exec are HARD-BLOCKED.`,
      `  - Use read tools freely: native_read_file / native_list_dir / native_glob / native_grep / native_web_fetch / native_web_search.`,
      `  - Exit handshake (v1.2.131): when the plan is ready, call`,
      `      native_exit_plan_mode({ plan: '<markdown of the steps>' })`,
      `    The user will see an Approve/Reject card. On approve you regain full write access and proceed immediately. On reject you stay in Plan Mode with the user's feedback in the tool result — revise and call again.`,
      `  - DO NOT just describe the plan in prose and stop — the user expects the exit handshake. Skip it only if the user explicitly asks for "no exit" / "just brainstorm".`,
      ``,
    )
  }
  lines.push(
    `Tools available beyond the four native built-ins (echo / now / sleep / random_uuid):`,
    `  - agim built-in MCP tools (mcp__imhub__*): read_skill, list_skills, save_memo, search_memos, update_memo, delete_memo, push_message, ask_user, call_agent, long_task, complete_goal`,
    `  - native filesystem tools: native_read_file, native_write_file, native_list_dir, native_glob, native_grep — constrained to your workspace cwd unless IMHUB_NATIVE_FS_RESTRICT=0`,
    `  - native web tools: native_web_fetch (r.jina.ai reader by default), native_web_search (duckduckgo → metaso fallback). Private IPs blocked.`,
    `  - native_exec(command, timeout_ms?, cwd?): run shell commands. Always approval-gated; bwrap sandbox when IMHUB_EXEC_SANDBOX=bwrap.`,
    `  - External MCP servers configured by the operator:`,
    externalMcp,
    ``,
    `Available skill cards (call mcp__imhub__read_skill('<name>') for the full body):`,
    skillsBlock,
    ``,
    `Guidance:`,
    `  - Be terse; avoid filler. Prefer tool use over guessing.`,
    `  - When uncertain, call mcp__imhub__ask_user(question, choices[]) instead of free-form back-and-forth.`,
    `  - When the user references something they told the bot before, search memos via mcp__imhub__search_memos.`,
    ``,
    `Tool selection priority (HARD RULE — v1.2.59):`,
    `  - For "read this file / list this dir / search this content / fetch this URL", you MUST FIRST try`,
    `    your own native tools: native_read_file, native_list_dir, native_glob, native_grep,`,
    `    native_web_fetch (if available). Do NOT delegate these to call_agent.`,
    `  - call_agent is reserved for tasks that genuinely need a CLI agent's specialised capabilities`,
    `    (writing/editing source code in a real repo → claude-code; long-running plans → codex; etc).`,
    `  - You have a per-turn call_agent cap (default 2). Burning it on file reads will leave you`,
    `    unable to delegate later when you actually need to.`,
    ``,
    `When to USE call_agent (v1.2.139 positive framing — pair with the HARD RULE above):`,
    `  - The task needs sustained source-code editing in a real repo → call_agent('claude-code', …)`,
    `    or call_agent('codex', …). Don't try to mimic them with native_write_file when the work is`,
    `    multi-file refactors or feature builds.`,
    `  - You need a second pair of eyes / cross-checking on your own conclusion → call_agent('codex',`,
    `    'audit my findings: …'). Useful before committing or reporting.`,
    `  - The task is large enough that parallel research helps (e.g. survey 3 independent areas of`,
    `    a codebase) → fan-out via call_agent('native', …) so each sub-agent's context is fresh.`,
    `  - Tip: write the sub-agent prompt as a self-contained brief — they don't see this conversation.`,
    ``,
    `Verification subagent (T5 — harness pattern, the most reliably useful multi-agent move):`,
    `  - After you produce a SUBSTANTIVE result (a multi-step conclusion, a refactor, a data`,
    `    analysis, anything you're about to report or commit), spin up a FRESH subagent whose sole`,
    `    job is to verify it independently:`,
    `      call_agent('codex', 'Verify the result below against <source / acceptance criteria>.`,
    `                 Report ONLY discrepancies or risks; if it checks out, say so. <paste result>')`,
    `    Use 'codex' for code/logic review, 'native' for a fresh-eyes fact/consistency check.`,
    `  - Give the verifier a SELF-CONTAINED brief: restate the claim AND how to check it, and paste`,
    `    the artifact. It does NOT see this conversation — "verify my findings" with nothing attached`,
    `    is useless.`,
    `  - Synthesize, don't delegate understanding: digest what you learned into a PRECISE spec before`,
    `    delegating implementation or verification. "Based on your findings, fix it" is an anti-pattern`,
    `    — you (the coordinator) must state exactly what to do, not hand off the thinking.`,
    `  - Don't over-verify: skip the verifier for trivial / low-stakes turns (it costs a call_agent hop).`,
    ``,
    `Web tool routing (HARD RULE — v1.2.64):`,
    `  - If the user provided a SPECIFIC URL (http://… or https://…) → native_web_fetch.`,
    `  - If the user wants to FIND / DISCOVER something by keywords ("查找最新 X" / "search for Y" /`,
    `    "find docs on Z" / "今天 / 最近的 W") → native_web_search FIRST. Don't guess a URL.`,
    `  - Common pattern: native_web_search(query) → pick a result → native_web_fetch(that.url).`,
    `  - NEVER call native_web_fetch with a URL you fabricated from the user's keywords.`,
    ``,
    `Short-input rule:`,
    `  - If the user's message is ONLY a slash command alias for an agent name (e.g. "/native", "/llm",`,
    `    "/na", "/cc", "/oc") and you are already that agent, respond with ONE short line confirming`,
    `    your identity (e.g. "我是 native，正在听。"). Do NOT call any tool. The slash router handles`,
    `    actual agent switching; if it didn't switch, the user is already on this agent.`,
    ``,
    `Plan tracking (v1.2.124 — native_todo_write):`,
    `  - When the user gives you a task with ≥ 3 distinct steps, FIRST call native_todo_write({items}) to`,
    `    write out your plan, then update statuses as you complete each step.`,
    `    Status values: pending | in_progress | completed. Keep exactly one item in_progress at a time.`,
    `  - The tool result is a rendered markdown checklist; the user sees your progress.`,
    `  - Don't call native_todo_write for trivial one-step tasks — overhead.`,
    `  - Example sequence:`,
    `    1) native_todo_write([{c:"Fetch market data",s:"in_progress"}, {c:"Analyse",s:"pending"}, {c:"Reply",s:"pending"}])`,
    `    2) … do fetch via native_web_fetch …`,
    `    3) native_todo_write([{c:"Fetch market data",s:"completed"}, {c:"Analyse",s:"in_progress"}, {c:"Reply",s:"pending"}])`,
    `    4) … analysis …`,
    `    5) write final answer to user`,
    ``,
    `Closure rule (v1.2.94 — HARD RULE):`,
    `  - When you finish a tool chain (read_file / web_fetch / native_exec / search_memos / etc.) you`,
    `    MUST write a short Chinese summary BEFORE stopping. The tool output by itself is not a`,
    `    user-facing answer — the user can't see the raw JSON / shell stdout. Always close with at`,
    `    least one sentence stating the finding / conclusion.`,
    `  - Do NOT end a turn with empty assistant text when you've just called tools. If you genuinely`,
    `    have nothing to add, say so explicitly ("已查完，未发现 X").`,
    ``,
    `Proactive memory rule (v1.2.96 — borrowed from Hermes Agent's "agent-curated memory"):`,
    `  - Before ending a substantive turn, scan the conversation for facts that should outlive the`,
    `    current chat. Persist them yourself via mcp__imhub__save_memo — don't wait for the user to`,
    `    ask you to remember.`,
    `  - Worth saving (call save_memo for each):`,
    `      · personal preferences ("我不喝咖啡" / "我用 vim"),`,
    `      · holdings or portfolio codes ("我持有 600519"),`,
    `      · recurring people / places ("我家在朝阳" / "爸爸生日 5月8日"),`,
    `      · stable identifiers (账号 / 邮箱 / API base / 配置路径),`,
    `      · explicit "记一下" / "remember this" instructions.`,
    `  - NOT worth saving: one-off questions, transient debugging context, tool outputs that are`,
    `    already cached elsewhere (memos point AT data, they're not a cache of data).`,
    `  - Each save_memo call is cheap. Two short memos beat one long one — small atomic facts`,
    `    search better. Add a 1-line user-facing acknowledgement so the user knows you remembered`,
    `    (e.g. "已记下 600519 是你的持仓").`,
    ``,
    `Long-task SOP (v1.2.93 — for any work you estimate will run > 10 minutes):`,
    `  - You CANNOT keep a long synchronous turn alive: the IM bridge times out around 30 min, and`,
    `    most useful work past the 10-min mark loses intermediate state if it crashes mid-flight.`,
    `  - Instead, use native_exec to invoke the agim bgjob wrapper, which spawns a detached worker`,
    `    that survives independent of this conversation:`,
    `      native_exec("/root/.claude/scripts/bgjob start <slug> -- /usr/bin/python3 /path/to/script.py [args]")`,
    `    Substitute python3 for the runtime you actually need. The wrapper returns a job_id; relay it`,
    `    to the user verbatim and tell them how to check back: \`bgjob status <id>\` / \`bgjob tail <id> -f\`.`,
    `  - When the user follows up asking about the job, native_exec calls like \`bgjob status <id>\` or`,
    `    \`bgjob tail <id> -n 100\` give you the current state + recent log lines.`,
    `  - The bwrap sandbox (when configured) is bypassed for this specific wrapper path so the`,
    `    setsid-detached worker actually survives. Any OTHER native_exec command remains sandboxed.`,
    `  - DO NOT use \`nohup ... &\` or backgrounded shell pipelines for long work — those die with the`,
    `    parent shell. bgjob is the only correct path on this platform.`,
    ``,
    `Python-RPC bridge (v1.2.97 — when a task means MANY similar tool calls):`,
    `  - When you would otherwise call mcp__imhub__* dozens of times in this chat turn (saving 30`,
    `    facts, fetching 50 stocks, scoring 100 candidates), DO NOT do it inline — that wastes the`,
    `    iteration budget and is likely to trip the stuck-loop detector. Write ONE Python script,`,
    `    run it in bgjob, and let it loop locally while calling back to agim's tool surface via the`,
    `    local RPC bridge agim sets up automatically for every native_exec child.`,
    `  - The Python sidecar lives at \`<npm install dir>/bin/agim_rpc.py\` (typically`,
    `    /usr/local/lib/node_modules/agim-cli/bin/agim_rpc.py — find it with`,
    `    \`node -e "console.log(require.resolve('agim-cli'))"\`). Import it and instantiate the client:`,
    `      from agim_rpc import client`,
    `      rpc = client()                                 # reads env, validates token, no args needed`,
    `      memos = rpc.search_memos(query="茅台", k=10)`,
    `      for m in memos.get("rows", []):`,
    `          ...`,
    `      rpc.push_message(text="后台跑完了，结果是 X")`,
    `  - Available tools through the bridge (whitelist): search_memos, save_memo, read_skill,`,
    `    list_skills, push_message. Everything else (native_exec, fs writes, call_agent, long_task,`,
    `    ask_user) is NOT exposed — the worker already has a shell + filesystem.`,
    `  - The token is automatically injected via env (IMHUB_RPC_SOCKET + IMHUB_RPC_TOKEN), bound`,
    `    to THIS IM thread, valid for 24 h. The worker can only drive this thread; it cannot`,
    `    push_message into someone else's chat.`,
    `  - End the worker with rpc.push_message(text="…done…") so the user sees the result come back`,
    `    asynchronously. Don't expect the user to poll \`bgjob tail\` themselves.`,
  )
  return lines.join('\n')
}

/** Memoized single-file role read (T1 — context-as-budget). Reads a role
 *  file from disk, runs the prompt-injection scan + 8000-char sanitise, and
 *  caches the sanitised result keyed by absolute path — invalidating only
 *  when the file's own mtime or size changes ("invalidate at the mutation
 *  site", not on a timer). The per-turn cost drops to a single stat() per
 *  layer. When matches are found we still inject (the operator likely wrote
 *  them deliberately) but log a warn so forensics can correlate.
 *
 *  Limitation: an edit that changes neither mtime nor byte length (same ms,
 *  same size, different bytes) is not detected — the standard make/rsync
 *  freshness heuristic; impossible in practice for a human-edited file. */
interface OperatorRoleCacheEntry { mtimeMs: number; size: number; content: string }
const _operatorRoleCache = new Map<string, OperatorRoleCacheEntry>()

function readRoleFile(path: string): string {
  let st: import('node:fs').Stats
  try {
    st = fsStatSync(path)
  } catch {
    // Missing / unreadable → no role block; drop any stale cache entry.
    _operatorRoleCache.delete(path)
    return ''
  }
  const cached = _operatorRoleCache.get(path)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.content
  }
  let raw = ''
  try { raw = fsReadFileSync(path, 'utf-8') } catch { _operatorRoleCache.delete(path); return '' }
  const trimmed = raw.trim()
  if (!trimmed) {
    _operatorRoleCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, content: '' })
    return ''
  }
  try {
    const scan = scanForInjectionAttempts(trimmed)
    if (scan.suspicious) {
      log.warn({
        event: 'native.role_file.injection_signals',
        file: path,
        matched: scan.matched,
      }, `${path} contains prompt-injection-style language; injecting anyway — operator review recommended`)
    }
  } catch { /* scan is best-effort */ }
  const content = sanitizeForInjection(trimmed, 8000)
  _operatorRoleCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, content })
  return content
}

/**
 * Resolve the operator role definition injected into native's system prompt.
 *
 * T4 (instruction hierarchy, distilled from the agentic-harness Memory
 * pattern's "local overrides win — always"). Instead of a single
 * `<cwd>/AGENTS.md`, discover a layered stack within the native workspace
 * and concatenate in ASCENDING priority so the most-local block appears last
 * and gets the most model attention. LOCAL WINS:
 *
 *   1. project — <cwd>/AGENTS.md         (the shared native-workspace role)
 *   2. local   — <cwd>/AGENTS.local.md   (private override, not version-ctl'd)
 *
 * Both layers live under the native workspace cwd, so the stack is
 * self-contained (no dependency on a global ~/.agim file — native has a
 * single workspace, so "project" already IS the operator-global role; a
 * cross-workspace user layer can be added later if that changes).
 *
 * IMHUB_NATIVE_AGENT_ROLE_FILE still forces a single explicit file (operators
 * who pin one path bypass discovery entirely). Each layer is independently
 * memoized + injection-scanned + capped at 8000 chars by readRoleFile.
 */
export function readOperatorRole(cwd: string): string {
  const override = process.env.IMHUB_NATIVE_AGENT_ROLE_FILE
  if (override && override.length > 0) {
    // An explicit pin is operator-chosen → trusted regardless of the gate.
    return readRoleFile(override)
  }
  // T6 — workspace trust gate. Discovered workspace files are skipped wholesale
  // when the workspace is marked untrusted (see isWorkspaceTrusted).
  if (!isWorkspaceTrusted()) {
    return ''
  }
  const parts: string[] = []
  for (const p of [pathJoin(cwd, 'AGENTS.md'), pathJoin(cwd, 'AGENTS.local.md')]) {
    const c = readRoleFile(p)
    if (c) parts.push(c)
  }
  return parts.join('\n\n')
}

/**
 * T6 — workspace trust gate (distilled from the agentic-harness Lifecycle
 * pattern's "trust is all-or-nothing; an untrusted workspace disables the
 * whole extension surface, not just suspicious parts").
 *
 * agim treats `<cwd>/AGENTS.md` + `AGENTS.local.md` as an operator-authored
 * role definition injected into the system prompt — a privileged surface. In
 * multi-tenant / A2A setups the native cwd can point at a directory whose
 * contents are NOT fully operator-controlled, where an attacker-planted
 * AGENTS.md is a prompt-injection vector. Setting
 * `IMHUB_NATIVE_TRUST_WORKSPACE=off` (or 0/false/no) makes readOperatorRole
 * skip ALL workspace-discovered role files at once. Default is trusted
 * (on) for backward compatibility — operators opt into the stricter posture.
 *
 * An explicit `IMHUB_NATIVE_AGENT_ROLE_FILE` bypasses the gate: the operator
 * pinned that exact file deliberately, so it stays trusted.
 */
export function isWorkspaceTrusted(): boolean {
  const raw = (process.env.IMHUB_NATIVE_TRUST_WORKSPACE ?? '').toLowerCase().trim()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no')
}

/** Role priority for picking which LLM backend powers the native chat
 *  turn. First found wins. Operators can override the role via
 *  `IMHUB_NATIVE_AGENT_ROLE`. */
const DEFAULT_ROLE_FALLBACK: string[] = ['native-chat', 'cheap']

function resolveRole(): string[] {
  const raw = process.env.IMHUB_NATIVE_AGENT_ROLE
  if (raw?.trim()) return [raw.trim(), ...DEFAULT_ROLE_FALLBACK]
  return DEFAULT_ROLE_FALLBACK.slice()
}

/**
 * v1.2.91 / v1.2.92 — render a structured recap when a native turn
 * ends without a normal "stop + text" completion. Two failure modes
 * share the same skeleton:
 *
 *   - `empty`     : finishReason='stop' but text=''. Common cause:
 *                    model finished a tool chain (search / fetch /
 *                    read / ask_user) and skipped the closing summary.
 *   - `max_iter`  : the loop hit IMHUB_NATIVE_AGENT_MAX_ITER without
 *                    the model deciding to stop. The model wanted to
 *                    keep going. We were the ones who pulled the plug.
 *
 * Both surface:
 *   1. what tool calls actually ran (✓ / ✗ / ⚠️, deduped by name)
 *   2. a 160-char preview of the last tool's output
 *   3. a plain-language guess at why we're here
 *   4. concrete continuation options
 *
 * Pure formatting of AgentLoopResult fields; no second LLM call.
 */
function composeUnfinishedTurnRecap(
  result: {
    toolCalls: ReadonlyArray<{ name: string; isError: boolean; preview?: string; durationMs: number }>
    iterations: number
    finishReason: string
  },
  kind: 'empty' | 'max_iter' | 'stuck_loop',
  maxIter: number,
): string {
  const tools = result.toolCalls
  if (tools.length === 0) {
    // No tools called AND no text emitted — the model literally said
    // nothing. Usually a misjudged "nothing to do" or a provider
    // quirk on a single short prompt. (max_iter with 0 tools is
    // unusual but possible if the model returned empty assistant
    // text every iteration; treat the same way.)
    return [
      '🧐 这一轮没说话也没动工具。',
      '可能是模型把请求误判成了"无事可做"，或者提供方返回了空响应。',
      '',
      '怎么继续：',
      '  · 直接告诉我具体要做什么（多给点上下文）',
      '  · 或把上一条请求换种说法再发',
      '  · 或 /cc / /oc / /cs 切到别的智能体接手',
    ].join('\n')
  }

  // Group identical tool names so a chain like 6× read_file collapses
  // into "read_file ×6" rather than 6 list items.
  const counts = new Map<string, { count: number; errors: number }>()
  for (const t of tools) {
    const e = counts.get(t.name)
    if (e) {
      e.count += 1
      if (t.isError) e.errors += 1
    } else {
      counts.set(t.name, { count: 1, errors: t.isError ? 1 : 0 })
    }
  }

  const intro = kind === 'stuck_loop'
    ? `🛑 检测到死循环：模型在第 ${result.iterations} 步连续 3 次调用同一个工具拿到完全一样的结果，已提前停下。已执行的工具调用：`
    : kind === 'max_iter'
      ? `⚠️ 这一轮干到第 ${result.iterations} 步还没收尾，被安全上限切掉了。已执行的工具调用：`
      : '🧐 这一轮没写出收尾文字就结束了，但中间有做事。已执行的工具调用：'
  const lines: string[] = [intro]
  for (const [name, { count, errors }] of counts) {
    const mark = errors === 0 ? '✓' : errors === count ? '✗' : '⚠️'
    const tail = count > 1 ? ` ×${count}` : ''
    const errTail = errors > 0 && errors < count ? `（其中 ${errors} 次失败）` : ''
    lines.push(`  ${mark} ${name}${tail}${errTail}`)
  }

  const last = tools[tools.length - 1]
  if (last) {
    const preview = (last.preview ?? '').trim().slice(0, 160).replace(/\s+/g, ' ')
    lines.push('')
    lines.push(`最后一步：${last.name}${last.isError ? '（失败）' : ''}`)
    if (preview) lines.push(`  └ 结果摘要：${preview}${(last.preview?.length ?? 0) > 160 ? '…' : ''}`)
  }

  // Quick why-did-it-stop hint based on what we have.
  lines.push('')
  if (kind === 'stuck_loop' && last) {
    lines.push(
      `判定：${last.name} 工具连续 3 次返回了完全一样的内容（${last.isError ? '同一个错误' : '同一份输出'}），` +
      `继续重试不会带来新结果。请换个写法 / 换个参数 / 换个工具，或者把任务拆小。`,
    )
  } else if (kind === 'max_iter') {
    lines.push(`猜测：模型还想继续，但跑到第 ${result.iterations} 步触发了安全上限（IMHUB_NATIVE_AGENT_MAX_ITER=${maxIter}）。任务规模偏大或卡在某一步反复重试。`)
  } else if (last && !last.isError) {
    lines.push('猜测：模型在工具结果上停手了，没写最终结论。常见原因是它把工具的返回当成了"完整答案"。')
  } else if (last && last.isError) {
    lines.push('猜测：最后一步工具失败了，模型没生成补救/解释文字就停了。')
  } else {
    lines.push(`猜测：模型在第 ${result.iterations} 轮结束时主动停止（finishReason=${result.finishReason}）。`)
  }

  lines.push('')
  if (kind === 'stuck_loop') {
    lines.push('怎么继续：')
    lines.push('  · 告诉我换什么写法 / 换什么参数（最有用）')
    lines.push('  · 或把任务拆小一些（先解决卡住的那一步）')
    lines.push('  · 或 /cc / /oc / /cs 切到别的智能体接手')
  } else if (kind === 'max_iter') {
    lines.push('怎么继续：')
    lines.push('  · 回「继续」让我接着把剩下的事做完')
    lines.push('  · 或把任务拆小一些（先做 A，再做 B）')
    lines.push(`  · 或调高上限：在 .agim/env 加一行 IMHUB_NATIVE_AGENT_MAX_ITER=${Math.min(maxIter * 2, 100)} 后重启服务`)
  } else {
    lines.push('要继续吗？')
    lines.push('  · 回「继续」让我接着推进')
    lines.push('  · 或直接告诉我下一步具体做什么')
    lines.push('  · 或 /cc / /oc / /cs 切到别的智能体接手')
  }

  return lines.join('\n')
}

/**
 * v1.2.98 — render the off-track recap from the goal-critic's verdict.
 * Different shape from `composeUnfinishedTurnRecap` because the critic
 * gave us a verbatim Chinese reason + optional redirect; we don't have
 * to invent fail-mode hints. Layout:
 *
 *   🧭 目标偏离检测：模型偏离了原目标。
 *   原因：<critic.reason>
 *   建议方向：<critic.redirect>  (only if non-empty)
 *
 *   已执行的工具调用：
 *     ✓ tool_a ×2
 *     ✗ tool_b ×3 (失败)
 *
 *   要继续吗？
 *     · 回「继续」按原方向接着推
 *     · 回「换」按上面的建议方向走
 *     · 或自己说一个新方向 / 切到别的 agent
 */
function composeOffTrackRecap(
  result: { toolCalls: ReadonlyArray<{ name: string; isError: boolean; preview?: string }>; iterations: number },
  reason: string,
  redirect: string,
): string {
  const lines: string[] = []
  lines.push('🧭 目标偏离检测：模型在原目标上不再有进展。')
  if (reason) lines.push(`原因：${reason}`)
  if (redirect) lines.push(`建议方向：${redirect}`)
  lines.push('')

  if (result.toolCalls.length > 0) {
    lines.push(`已执行的工具调用（共 ${result.toolCalls.length} 次）：`)
    const counts = new Map<string, { count: number; errors: number }>()
    for (const t of result.toolCalls) {
      const e = counts.get(t.name)
      if (e) { e.count += 1; if (t.isError) e.errors += 1 }
      else counts.set(t.name, { count: 1, errors: t.isError ? 1 : 0 })
    }
    for (const [name, { count, errors }] of counts) {
      const mark = errors === 0 ? '✓' : errors === count ? '✗' : '⚠️'
      const tail = count > 1 ? ` ×${count}` : ''
      const errTail = errors > 0 && errors < count ? `（其中 ${errors} 次失败）` : ''
      lines.push(`  ${mark} ${name}${tail}${errTail}`)
    }
    lines.push('')
  }

  lines.push('要继续吗？')
  if (redirect) {
    lines.push('  · 回「继续」按原方向接着推（已经被判定走不通）')
    lines.push('  · 回「换」按上面的建议方向走（推荐）')
  } else {
    lines.push('  · 回「继续」按原方向接着推')
  }
  lines.push('  · 或自己告诉我一个新方向')
  lines.push('  · 或 /cc / /oc / /cs 切到别的智能体接手')
  return lines.join('\n')
}

/**
 * v1.2.147 — recap for the "hallucinated tool-call" failure mode.
 *
 * Trigger: agent-loop detected the model's final text narrates a
 * native_* tool invocation (e.g. "我现在调用 native_write_file:
 * ```python ...```" or "let me invoke native_exec") but the response
 * carried zero real toolCalls. The model promised an action it did not
 * take. Without this branch the lie would get shipped to the user as a
 * normal reply.
 *
 * Distinct from the empty / max-iter / stuck-loop recaps because the
 * fail-mode is model-side rather than budget-side: the model is fine,
 * just not in a tool-calling mood. The recap points the user at a
 * backend swap as the most reliable next step, since prompt tweaking
 * has limited leverage when the model has already drifted out of the
 * function-calling schema. Pure formatting; no LLM call.
 */
function composeHallucinatedToolRecap(
  result: {
    toolCalls: ReadonlyArray<{ name: string; isError: boolean; preview?: string }>
    iterations: number
    text: string
  },
  backend: string,
): string {
  const lines: string[] = []
  lines.push('🧐 模型说要调用工具，但实际上没真的发起调用。')
  lines.push('为了不让你看到空承诺，已经把这次回复挡下。')
  lines.push('')
  lines.push(`当前 native-chat 后端：${backend}`)
  if (result.toolCalls.length > 0) {
    lines.push(`本轮在此之前已真正完成了 ${result.toolCalls.length} 次工具调用，那部分有效。`)
  } else {
    lines.push('本轮没有任何真实工具调用产出。')
  }
  lines.push('')
  lines.push('怎么继续：')
  lines.push('  · 直接回「重试」让我重新跑一遍这一步')
  lines.push('  · 或在 /settings/llm 把 native-chat 角色换成工具调用更稳定的后端（Claude / GPT 系列）')
  lines.push('  · 或 /cc / /oc / /cs 切到别的智能体接手这一步')
  lines.push('')
  lines.push('（检测器可用 IMHUB_NATIVE_HALLUCINATION_DETECT=off 关掉）')
  return lines.join('\n')
}

/**
 * v1.2.142 — Stage-report retry. Replaces v1.2.94's empty-only auto-
 * summary with a single helper used by all four "unhappy ending"
 * branches (empty / max_iter / stuck_loop / off_track).
 *
 * The retry asks the same provider, with no tools, for a *user-facing
 * stage report* given the work already done — not a "final answer". The
 * prompt explicitly tolerates partial / failed work; failed tool
 * results get described in plain language ("couldn't fetch the news
 * page — anti-bot"), never as `tool_name ×N`.
 *
 * Returns the produced text + cost delta on success; null when the
 * provider returned nothing or threw. Caller falls back to the
 * technical `composeUnfinishedTurnRecap` recap on null.
 *
 * One LLM call, 60s deadline, tools=[] so it can't keep chaining.
 * Env IMHUB_NATIVE_STAGE_REPORT=off disables the retry entirely
 * (caller goes straight to the technical recap) — useful for debug.
 */
export async function tryStageReport(
  opts: {
    prompt: string
    result: {
      toolCalls: ReadonlyArray<{ name: string; isError: boolean; preview?: string }>
      iterations: number
    }
    provider: LlmProvider
    kind: 'empty' | 'max_iter' | 'stuck_loop' | 'off_track'
    /** off_track reason; ignored for other kinds. */
    offTrackReason?: string
    model?: string
    signal?: AbortSignal
    sessionId: string
  },
): Promise<{ text: string; costUsd: number | null } | null> {
  if (isStageReportDisabled()) return null
  const recent = opts.result.toolCalls.slice(-20)
  const success = recent.filter((t) => !t.isError)
  const failed = recent.filter((t) => t.isError)
  const fmtPreview = (p: string | undefined, cap: number): string =>
    (p ?? '').trim().slice(0, cap).replace(/\s+/g, ' ')

  const successBlock = success.length === 0
    ? '(无成功的中间结果)'
    : success
      .map((t, i) => `${i + 1}. ${fmtPreview(t.preview, 300)}${(t.preview?.length ?? 0) > 300 ? '…' : ''}`)
      .join('\n')
  const failedBlock = failed.length === 0
    ? '(无失败)'
    : failed
      .map((t, i) => `${i + 1}. ${fmtPreview(t.preview, 200)}${(t.preview?.length ?? 0) > 200 ? '…' : ''}`)
      .join('\n')

  const kindHint = ({
    empty: '工具调用做完了但没写收尾文字。',
    max_iter: `执行步数达到上限（${opts.result.iterations} 步）被切断。`,
    stuck_loop: '检测到同一工具连续重复执行（卡循环），提前停止。',
    off_track: '目标偏离检测：当前推进方向被判定为离原任务太远。',
  } as const)[opts.kind]
  const reasonHint = opts.kind === 'off_track' && opts.offTrackReason
    ? `\n[偏离原因] ${opts.offTrackReason}`
    : ''

  const messages: LlmMessage[] = [
    {
      role: 'system',
      content:
        '你是 agim native 智能体。用户委托你做一项任务，你做了一些工作，但当前轮次未能正常收尾。\n' +
        '\n' +
        '请用中文给用户一份**阶段性报告**，目的是让用户拿到尽可能多的可用结果 + 知道接下来怎么做：\n' +
        '\n' +
        '【已经拿到 / 做到】基于成功的中间结果，给出具体数据、事实或结论。直接写内容，不要写"我调用了 X 工具"。如果没有任何可用结果，写"暂无"。\n' +
        '【没拿到 / 卡在哪】基于失败的中间结果，用普通中文描述卡点：例如"新浪财经页面抓不到（疑似反爬）"、"某 shell 命令未找到"、"目标 URL 超时"。**不要出现工具名（native_xxx / mcp__imhub__xxx）**。没有失败就跳过本节。\n' +
        '【下一步建议】给用户 1-3 个具体可执行的下一步，可包括"继续"、"换数据源"、"缩小范围"、"终止"等。\n' +
        '\n' +
        '硬约束：\n' +
        '- 不要再调任何工具。\n' +
        '- 不要列工具调用清单 / 工具计数。\n' +
        '- 不要把失败粉饰成完成。\n' +
        '- 失败的内容里不要让用户做诊断（除非真的需要他抉择）。\n',
    },
    { role: 'user', content: opts.prompt },
    {
      role: 'user',
      content:
        `[本轮中止原因] ${kindHint}${reasonHint}\n\n` +
        `[成功的中间结果（最近 ${success.length}/${opts.result.toolCalls.length} 次，截 300 字预览）]\n${successBlock}\n\n` +
        `[失败的中间结果（最近 ${failed.length} 次，截 200 字错误预览）]\n${failedBlock}\n\n` +
        `[请基于上面的真实中间结果，按系统消息里的三节结构给阶段性报告。]`,
    },
  ]

  try {
    log.info({
      event: 'native.turn.stage_report.start',
      sessionId: opts.sessionId,
      backend: opts.provider.name,
      kind: opts.kind,
      total: opts.result.toolCalls.length,
      successCount: success.length,
      failedCount: failed.length,
    }, `stage report → ${opts.kind} (succ=${success.length} fail=${failed.length} total=${opts.result.toolCalls.length})`)
    const retry = await opts.provider.chat(messages, {
      model: opts.model,
      timeoutMs: 60_000,
      signal: opts.signal,
    })
    if (!retry.text || !retry.text.trim()) {
      log.warn({
        event: 'native.turn.stage_report.empty',
        sessionId: opts.sessionId,
        backend: opts.provider.name,
        kind: opts.kind,
      }, 'stage report returned empty text — falling through to recap')
      return null
    }
    log.info({
      event: 'native.turn.stage_report.ok',
      sessionId: opts.sessionId,
      backend: opts.provider.name,
      kind: opts.kind,
      textLen: retry.text.length,
      costUsd: retry.usage?.costUsd ?? null,
    }, `stage report produced ${retry.text.length} chars`)
    return {
      text: retry.text,
      costUsd: typeof retry.usage?.costUsd === 'number' ? retry.usage.costUsd : null,
    }
  } catch (err) {
    log.warn({
      event: 'native.turn.stage_report.failed',
      sessionId: opts.sessionId,
      backend: opts.provider.name,
      kind: opts.kind,
      err: err instanceof Error ? err.message : String(err),
    }, 'stage report threw — falling through to recap')
    return null
  }
}

/** v1.2.142 — Operator kill switch for the stage-report retry. Defaults
 *  ON. Set `IMHUB_NATIVE_STAGE_REPORT=off` (or `0` / `no` / `false`) to
 *  skip the retry and go straight to the technical recap — debug only. */
function isStageReportDisabled(): boolean {
  const raw = (process.env.IMHUB_NATIVE_STAGE_REPORT ?? '').toLowerCase().trim()
  return raw === 'off' || raw === '0' || raw === 'no' || raw === 'false'
}

/** Read IMHUB_NATIVE_AGENT_MAX_ITER, clamp to [1, 100], default 50.
 *  v1.2.136: bumped from 20 → 50 after observing real-world CR / multi-step
 *  refactor tasks routinely needed 28-35 iters and 20 was cutting them off.
 *  50 covers most cases with margin; the 30-min IM hard timeout is the
 *  earlier ceiling for genuinely long runs, and v1.2.122 semantic stuck-
 *  loop detection catches runaway model behaviour well before 50.
 *  v1.2.92 — previously this env var was named in the user-facing
 *  banner ("raise IMHUB_NATIVE_AGENT_MAX_ITER") but NOTHING in code
 *  read it. Now actually wired into runAgentLoop. */
function resolveMaxIterations(): number {
  const raw = process.env.IMHUB_NATIVE_AGENT_MAX_ITER
  if (!raw?.trim()) return 50
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(Math.max(n, 1), 100)
}

/** v1.2.112 — opt the native agent into the agent-loop's streaming
 *  code path. Default ON: the headline benefit is preserving partial
 *  assistant text when IM's 30-min hard timeout fires mid-response.
 *  Ops can flip via `IMHUB_NATIVE_STREAM_PARTIAL=off` if a vendor's
 *  streaming endpoint misbehaves. Note the agent-loop also honours
 *  process-wide `IMHUB_AGENT_LOOP_STREAM=off` as a global kill switch. */
function resolveNativeStreamPartial(): boolean {
  const raw = (process.env.IMHUB_NATIVE_STREAM_PARTIAL ?? '').toLowerCase().trim()
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return false
  return true
}

function pickProvider(): { provider: LlmProvider; role: string } | null {
  for (const role of resolveRole()) {
    const p = getProvider(role)
    if (p) return { provider: p, role }
  }
  return null
}

/**
 * Build the ordered fallback chain of (provider, role) pairs the agent
 * loop will retry against. The chain begins with whatever pickProvider
 * picks (operator's primary), then appends each remaining role that has
 * a registered provider — de-duplicated by provider name so we never
 * retry the exact same backend.
 *
 * The loop driver in sendPrompt walks this chain when an iteration ends
 * with a TRANSIENT provider error (HTTP 5xx / network reset / 408).
 * Non-transient errors (4xx misconfig, schema validation) end the turn
 * immediately — retrying won't help and just multiplies cost.
 */
function pickProviderChain(): Array<{ provider: LlmProvider; role: string }> {
  const chain: Array<{ provider: LlmProvider; role: string }> = []
  const seen = new Set<string>()
  for (const role of resolveRole()) {
    const p = getProvider(role)
    if (!p) continue
    if (seen.has(p.name)) continue
    seen.add(p.name)
    chain.push({ provider: p, role })
  }
  return chain
}

/** Resolve the operator's approval policy from env. Defaults to
 *  `allow-list` mode with NO allow entries — equivalent to "no tool
 *  calls". Operators that want native to actually call tools must
 *  configure at least one of these env vars:
 *
 *    IMHUB_NATIVE_AGENT_MODE=allow-all|read-only|allow-list|deny-all
 *    IMHUB_NATIVE_AGENT_AUTOALLOW=tool1,tool2,...
 *    IMHUB_NATIVE_AGENT_DENYLIST=tool1,...
 *
 *  The `read-only` mode is the recommended starter — it accepts every
 *  tool whose name starts/ends with a read-only verb (`read_*` /
 *  `list_*` / `get_*` / etc.) and the four built-ins
 *  (`native_echo`/`now`/`random_uuid` — `sleep_ms` excluded).
 */
export function resolvePolicy(threadKey?: string): PolicyApprovalGateConfig {
  const mode = (process.env.IMHUB_NATIVE_AGENT_MODE || 'allow-list').toLowerCase() as ApprovalMode
  const autoAllow = splitEnvList(process.env.IMHUB_NATIVE_AGENT_AUTOALLOW)
  const denyList = splitEnvList(process.env.IMHUB_NATIVE_AGENT_DENYLIST)
  // Allow the 3 safe native builtins + all first-party imhub MCP tools by
  // default. The imhub tools are in-process (no external API cost, no
  // network side-effects beyond what the IM bridge would do anyway) and
  // are part of agim's own surface — denying them by default is the same
  // class of misconfiguration as denying agim itself. Operators can
  // remove individual entries via IMHUB_NATIVE_AGENT_DENYLIST.
  const defaultBuiltins = [
    'native_echo', 'native_now', 'native_random_uuid',
    // fs read-only tools (v1.2.58). write_file deliberately omitted —
    // it mutates the workspace, even though sensitive-paths + workspace
    // restriction prevent escape; an IM card per write keeps operator
    // awareness intact. Operators who trust native can add it via
    // IMHUB_NATIVE_AGENT_AUTOALLOW=native_write_file.
    'native_read_file', 'native_list_dir', 'native_glob', 'native_grep',
    // web tools (v1.2.61) — read-only, safe-by-default. SSRF rules
    // still apply to private IPs unless IMHUB_NATIVE_WEB_ALLOW_PRIVATE=1.
    'native_web_fetch', 'native_web_search',
    'mcp__imhub__read_skill', 'mcp__imhub__list_skills',
    'mcp__imhub__save_memo', 'mcp__imhub__search_memos',
    'mcp__imhub__update_memo', 'mcp__imhub__delete_memo',
    'mcp__imhub__push_message', 'mcp__imhub__ask_user',
    'mcp__imhub__call_agent',
    // v1.2.63 — long-goal management tools. State changes are scoped
    // to the per-thread goal row, which is also the only thing the
    // /goal slash command lets the user mutate directly. No external
    // side effects, so safe-by-default.
    'mcp__imhub__long_task', 'mcp__imhub__complete_goal',
    // v1.2.124 — TodoWrite-style plan tracker. In-process, in-memory,
    // per-thread; zero side effects beyond the model's own state. Safe
    // to default-allow; never asks the user.
    'native_todo_write',
    // v1.2.131 — Plan-mode exit handshake. The tool's OWN dispatcher
    // raises the user-facing approval card (with the plan markdown
    // payload); auto-allowing here just keeps the policy gate from
    // double-prompting. Without this entry an operator using allow-list
    // mode would see two cards back-to-back ("native_exit_plan_mode
    // ok?" then "approve plan?").
    'native_exit_plan_mode',
  ]
  const effectiveAllow = mode === 'allow-list'
    ? Array.from(new Set([...autoAllow, ...defaultBuiltins]))
    : autoAllow
  // v1.2.119 — PlanMode hard-denies write + exec tools.
  // v1.2.120 — PlanMode now ALSO honours per-thread overrides written
  //            by the /plan slash command. Pass `threadKey` to apply
  //            the override; omit it (CLI boot context, tests) for
  //            the env-only path.
  //
  // Mirrors opencode's plan-mode behaviour: agent must produce a
  // read-only plan; trying to call native_write_file / native_exec is
  // denied with a clear structured message instructing the model to
  // summarise the plan instead.
  //
  // We extend the user-supplied denyList rather than replacing the
  // policy mode — read-only tools (Read/Grep/Glob/web_fetch/web_search/
  // MCP read tools) continue to pass through autoAllow as before.
  const effectiveDeny = isPlanModeOn(threadKey)
    ? Array.from(new Set([...denyList, ...PLAN_MODE_DENY_TOOLS]))
    : denyList
  return { mode, autoAllow: effectiveAllow, denyList: effectiveDeny }
}

/** v1.2.119 — tools blocked when PlanMode is on. The list is intentionally
 *  narrow: writes to the workspace + arbitrary shell exec. Read-only
 *  fs/grep/glob/web/MCP tools stay enabled so the agent can still
 *  research and draft a plan. */
const PLAN_MODE_DENY_TOOLS = [
  'native_write_file',
  'native_exec',
] as const

/** Plan mode resolution (v1.2.120):
 *  - `threadKey` given (and matches a /plan-toggled row) → use that row
 *  - `threadKey` given but no row → fall through to env
 *  - `threadKey` omitted → env-only (back-compat for CLI boot, tests)
 */
export function isPlanModeOn(threadKey?: string): boolean {
  return effectivePlanModeOn(threadKey)
}

/**
 * v1.2.60 — bridge native's policy gate to the approval-bus so tools
 * that the gate would otherwise silently deny instead surface an IM
 * approval card. Mirrors how claude-code's MCP sidecar uses
 * registerSyntheticPending. Resolves to 'allow' / 'deny' from the
 * user's button tap / text reply / auto-allow rule. Throws (caught by
 * the gate) when the bus can't reach the user — caller falls back to
 * silent-deny in that case.
 */
function buildNativeAskUser(opts: {
  runId: string
  platform: string
  channelId: string
  threadId: string
  userId: string
}): (call: ToolCallRequest) => Promise<'allow' | 'deny'> {
  const baseCtx = {
    platform: opts.platform,
    channelId: opts.channelId,
    threadId: opts.threadId,
    userId: opts.userId,
    callerAgent: 'native',
  }
  return async (call: ToolCallRequest): Promise<'allow' | 'deny'> => {
    const reqId = _nativeRandomUUID()
    return await new Promise<'allow' | 'deny'>((resolve, reject) => {
      void approvalBus.registerSyntheticPending({
        runId: opts.runId,
        reqId,
        toolName: call.name,
        input: call.arguments,
        ctx: baseCtx,
        dispatch: (decision) => resolve(decision.behavior),
      }).catch((err) => reject(err))
    })
  }
}

function splitEnvList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Are we configured AT ALL to make tool calls? Reflected in startup
 *  log + onboarding hints so the operator notices when they ship
 *  `agents:['native']` without configuring a backend. */
function isConfigured(): boolean {
  return pickProvider() !== null
}

/**
 * Extract media attachments from a prompt string. Messenger adapters
 * (telegram / wechat / discord / feishu / dingtalk) inline a marker like
 * `[图片附件：/abs/path/to/file.jpg]` or `[image attachment: ...]` when a
 * user message carries a media payload. The path is already downloaded
 * to `~/.agim/media/<platform>/...` by the adapter, so we only need to
 * surface it to vision-capable providers; non-vision providers see the
 * original text and can still acknowledge the attachment.
 *
 * Heuristic-safe: matches absolute paths under common image extensions
 * + a path-safety check that the file exists. Anything ambiguous (no
 * extension, file missing, points outside ~/.agim/media) is silently
 * skipped so we never leak random filesystem paths into a vision call.
 */
export function parsePromptMedia(prompt: string): Array<{ path: string; mime?: string }> {
  if (!prompt) return []
  // Match both Chinese 图片附件 marker and English "image attachment".
  // Capture group is the path between `：`/`: ` and `]`.
  const re = /\[(?:图片附件|image attachment)[：:]\s*([^\]]+)\]/g
  const out: Array<{ path: string; mime?: string }> = []
  const home = process.env.HOME || '/root'
  const mediaRootRaw = process.env.IMHUB_MEDIA_ROOT || `${home}/.agim/media`
  // Normalise media root once so the prefix check works regardless of
  // trailing slashes / dotted segments in the env override.
  const mediaRoot = pathResolve(mediaRootRaw)
  const mediaPrefix = mediaRoot.endsWith(pathSep) ? mediaRoot : mediaRoot + pathSep
  for (;;) {
    const m = re.exec(prompt)
    if (m === null) break
    const rawPath = (m[1] || '').trim()
    if (!rawPath) continue
    // Path-safety: must be absolute AND resolve to a real file UNDER
    // the media root. Use path.resolve + sep-aware prefix check so
    // siblings like `/root/.agim/media-evil/x` and traversals like
    // `/root/.agim/media/../etc/x` are rejected.
    if (!rawPath.startsWith('/')) continue
    const normalised = pathResolve(rawPath)
    if (normalised !== mediaRoot && !normalised.startsWith(mediaPrefix)) continue
    try {
      if (!fsExistsSync(normalised)) continue
      if (!fsStatSync(normalised).isFile()) continue
    } catch { continue }
    // Image-only for v1; ignore other extensions to keep providers happy.
    const lower = normalised.toLowerCase()
    if (!/\.(jpg|jpeg|png|webp|gif)$/.test(lower)) continue
    out.push({ path: normalised })
  }
  return out
}

/**
 * Tool-call heartbeat helper. Solves the "agim 没反应" anxiety during
 * long tool calls (research-shaped tools / call_agent A2A turns can
 * run > 10s under the 30-minute hard timeout).
 *
 * Behaviour:
 *   - When a tool call's onToolStart fires, schedule a one-shot push
 *     to the IM thread after IMHUB_NATIVE_HEARTBEAT_MS (default 6000).
 *   - When the call's onToolEnd fires first, cancel the pending push.
 *   - shutdown() clears any still-pending timers (turn finished cleanly).
 *
 * Suppression: handlePushOp uses the standard notification-evaluator
 * gate + the per-user rate limit (10/min default). The heartbeat is
 * intentionally short ("🔧 调用工具 X 中…") so the gate's "low signal"
 * rule rarely drops it; if operators want them muted entirely, set
 * IMHUB_NATIVE_HEARTBEAT_MS=0.
 */
function buildHeartbeats(runCtx: {
  platform: string
  channelId: string
  threadId: string
  userId: string
  callerAgent: string
}): {
  hooks: { onToolStart: (call: ToolCallRequest) => void; onToolEnd: (call: ToolCallRequest) => void }
  shutdown: () => void
} {
  // Tool-level pulse: tools that take longer than IMHUB_NATIVE_HEARTBEAT_MS
  // (default 6000) push a one-shot "🔧 调用工具 X 中…" so the user knows
  // why the bot has gone quiet. Cancelled on tool end. Set 0 to disable.
  const rawDelay = parseInt(process.env.IMHUB_NATIVE_HEARTBEAT_MS || '6000', 10)
  const toolDelayMs = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 0
  // Turn-level pulse: every IMHUB_NATIVE_TURN_HEARTBEAT_MS (default 180_000
  // = 3 min) since turn start, push a "⏳ 还在处理（已 Nm）..." so a multi-
  // step research turn that runs many sub-agents reassures the user it's
  // still alive even between tool calls. Set 0 to disable. The first
  // pulse fires after delayMs, NOT immediately, so short turns stay silent.
  const rawTurnMs = parseInt(process.env.IMHUB_NATIVE_TURN_HEARTBEAT_MS || '180000', 10)
  const turnDelayMs = Number.isFinite(rawTurnMs) && rawTurnMs > 0 ? rawTurnMs : 0

  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const startedAt = Date.now()
  let turnTimer: ReturnType<typeof setInterval> | null = null

  if (turnDelayMs > 0) {
    turnTimer = setInterval(() => {
      const elapsedMin = Math.round((Date.now() - startedAt) / 60_000)
      void handlePushOp(
        { text: `⏳ 还在处理（已 ${elapsedMin}m）…` },
        runCtx,
      ).catch(() => { /* push errors are best-effort */ })
    }, turnDelayMs)
  }

  const shutdown = (): void => {
    for (const t of pending.values()) clearTimeout(t)
    pending.clear()
    if (turnTimer) { clearInterval(turnTimer); turnTimer = null }
  }
  const noop = (): void => { /* tool heartbeat disabled via env */ }
  if (toolDelayMs === 0) return { hooks: { onToolStart: noop, onToolEnd: noop }, shutdown }
  return {
    hooks: {
      onToolStart(call) {
        const timer = setTimeout(() => {
          void handlePushOp(
            { text: `🔧 调用工具 \`${call.name}\` 中…（已 ${Math.round(toolDelayMs / 1000)}s）` },
            runCtx,
          ).catch(() => { /* push errors are best-effort */ })
          pending.delete(call.id)
        }, toolDelayMs)
        pending.set(call.id, timer)
      },
      onToolEnd(call) {
        const t = pending.get(call.id)
        if (t) { clearTimeout(t); pending.delete(call.id) }
      },
    },
    shutdown,
  }
}

// ─── AgentAdapter implementation ─────────────────────────────────────

class NativeAgentAdapter implements AgentAdapter {
  readonly name = 'native'
  readonly aliases = ['llm', 'native-llm', 'na']
  readonly kind = 'in-process' as const

  /** One-line UI hint surfaced by `/agents`: which LLM role + backend
   *  currently powers this adapter. Returns undefined when not
   *  configured (caller renders 'NOT CONFIGURED' elsewhere). */
  describe(): string | undefined {
    const picked = pickProvider()
    if (!picked) return undefined
    // 'role -> vendor:backend' so a glance at /agents tells you which
    // LLM is wired without opening config.json.
    return `role=${picked.role} -> ${picked.provider.providerType}:${picked.provider.name}`
  }

  async isAvailable(): Promise<boolean> {
    return isConfigured()
  }

  async *sendPrompt(
    sessionId: string,
    prompt: string,
    history: ChatMessage[] = [],
    opts: AgentSendOpts = {},
  ): AsyncGenerator<string> {
    const picked = pickProvider()
    if (!picked) {
      const msg = '❌ native agent: no LLM backend configured for role `native-chat` or `cheap`. Add one in `~/.agim/config.json` `llmBackends`/`llmRoles` (see docs/llm-backends.md).'
      yield msg
      return
    }
    const { provider, role } = picked

    // Build the message array. The native loop accepts a system message
    // either as the first element OR via systemPrompt; we go with the
    // dedicated field so user-supplied history doesn't get clipped by
    // a synthetic system message.
    const messages: LlmMessage[] = []
    for (const m of history) {
      // ChatMessage role is 'user' | 'assistant'; both map straight
      // through. Skip empty content to keep prompts compact.
      if (!m.content) continue
      messages.push({ role: m.role, content: m.content })
    }
    // Parse `[图片附件：/path/to/file]` / `[image attachment: ...]` markers
    // that messenger adapters inline into the prompt. Vision-capable
    // providers will encode them as image_url blocks; others just see
    // the original text and the model can acknowledge "an image was
    // attached at <path>" without inspecting bytes.
    const userMedia = parsePromptMedia(prompt)
    messages.push({ role: 'user', content: prompt, ...(userMedia.length > 0 ? { media: userMedia } : {}) })

    // Auto-compact long chats before the provider call. Op-out via
    // IMHUB_NATIVE_COMPACT_TRIGGER_CHARS=0. Failure mode is no-op.
    const compact = await maybeCompactHistory(messages)
    const effectiveMessages = compact.messages
    if (compact.compacted) {
      log.info({
        event: 'native.compact.applied',
        sessionId,
        originalChars: compact.originalChars,
        summaryChars: compact.summaryChars,
        collapsedCount: compact.collapsedCount,
      })
    }

    // Compose dispatcher: built-in first (so a stray MCP server with
    // a colliding tool name doesn't shadow `native_now` etc.), then
    // imhub built-ins (skills / memo / push / ask_user / call_agent),
    // then external MCP. v1.2.47 added the imhub layer so native sees
    // exactly the same mcp__imhub__* surface claude-code does via the
    // MCP sidecar.
    // v1.2.120 — compute the per-thread composite key once and thread
    // it through PlanMode + todo-state resolution. When the call has
    // no IM context (CLI / smoke), threadKey stays undefined → env-only
    // / synthetic-key fallback behaviour.
    const planThreadKey = (opts.platform && opts.threadId)
      ? makeThreadKey(opts.platform, opts.channelId ?? '', opts.threadId)
      : undefined
    const imhubCtx = {
      platform: opts.platform || 'native-agent',
      channelId: opts.channelId || 'default',
      threadId: opts.threadId || sessionId,
      userId: opts.userId || 'unknown',
      callerAgent: 'native',
      callerDepth: opts.callDepth ?? 0,
      // v1.2.139 — propagate parent's plan-mode to the imhub dispatcher
      // so any call_agent invocation it makes hands the flag to the
      // sub-agent (claude-code / opencode / codex / native). Without
      // this, a parent in `/plan on` could delegate a write task and
      // the child would happily run with full write access. Falls back
      // to opts.planMode for A2A-initiated runs (sub-agent itself is
      // already in plan mode).
      callerPlanMode: effectivePlanModeOn(planThreadKey) || (opts.planMode === true),
    }
    // Resolve cwd here so fs-dispatcher can constrain reads/writes to
    // the per-thread workspace subtree. Was previously resolved AFTER
    // dispatch composition; moved up so fs tools see the right root.
    const cwd = resolveAgentCwd('native', opts) || defaultAgentCwd('native')
    // T2 (single tool registry): assemble the advertised tool list, the
    // dispatch chain, AND the per-call concurrency classifier from ONE
    // source-of-truth (see tool-registry.ts). This replaced three
    // hand-maintained parallel lists (tools[] / combineDispatchers / the
    // static parallelSafeTools Set) that silently drifted when a tool was
    // added. The plan-exit dispatcher is always wired (it self-refuses off
    // plan mode); its tool is advertised only when plan mode is on.
    const assembled = assembleNativeTools({
      cwd,
      rpcCtx: opts.platform && opts.threadId
        ? {
          platform: opts.platform,
          channelId: opts.channelId ?? '',
          threadId: opts.threadId,
          userId: opts.userId ?? '',
        }
        : undefined,
      todoThreadKey: planThreadKey ?? `native:${sessionId}`,
      planExitCtx: {
        threadKey: planThreadKey ?? `native:${sessionId}`,
        runId: sessionId,
        platform: opts.platform,
        channelId: opts.channelId,
        threadId: opts.threadId,
        userId: opts.userId,
      },
      advertisePlanExit: !!(planThreadKey && effectivePlanModeOn(planThreadKey)),
      imhubCtx,
    })
    const tools = assembled.tools
    const dispatch = assembled.dispatch

    const policy = resolvePolicy(planThreadKey)
    // v1.2.60 — when the policy would silently deny a tool call,
    // escalate to the user via an IM approval card instead. Only
    // wires when we have an actual IM thread (platform + threadId);
    // CI / smoke-test runs without IM stay silent-deny so they don't
    // hang awaiting a notifier that doesn't exist.
    const askUser: PolicyApprovalGateConfig['askUser'] = (opts.platform && opts.threadId && approvalBus.hasNotifier())
      ? buildNativeAskUser({
          runId: sessionId,
          platform: opts.platform,
          channelId: opts.channelId ?? 'default',
          threadId: opts.threadId,
          userId: opts.userId ?? 'unknown',
        })
      : undefined
    const approve = buildPolicyApprovalGate({ ...policy, askUser })

    const startedAt = Date.now()
    log.info({
      event: 'native.turn.start',
      sessionId,
      role,
      backend: provider.name,
      policy: describePolicy(policy),
      tools: tools.length,
      platform: opts.platform,
      threadId: opts.threadId,
    })

    // Note: cwd is resolved above (before dispatch composition) so fs
    // tools can constrain reads/writes to the per-thread workspace.
    // Was previously resolved here — that was fine before native had
    // fs tools, but fs-dispatcher now needs the value at dispatch
    // build time.

    // ADR-0002 — prefer the inbound turn's trace id (plumbed via opts.traceId
    // from the router) so the native iteration / turn audit rows correlate
    // back to the originating IM message in SIEM joins. Fall back to a
    // self-minted id only for entry points that don't carry one (e.g. an A2A
    // in-process spawn or a direct CLI/smoke invocation).
    const traceId = opts.traceId || `native-${sessionId}-${Date.now()}`
    // Wall-clock cap for the agent loop. agim's IM-layer enforces a 30-
    // minute hard ceiling per turn (DEFAULT_TIMEOUT_MS in agent-base.ts);
    // we set the inner loop a hair below so the loop's own abort fires
    // with a clean `finishReason='aborted'` BEFORE the outer SIGTERM. The
    // agent-loop default is a conservative 5 minutes which is far too
    // short for native turns that orchestrate sub-agents via call_agent
    // (each hop can run 1-3 minutes); without this override a multi-step
    // research turn would abort mid-flight even with sub-tasks healthy.
    // Operator can override via IMHUB_NATIVE_AGENT_TIMEOUT_MS.
    const nativeTimeoutMs = (() => {
      const raw = parseInt(process.env.IMHUB_NATIVE_AGENT_TIMEOUT_MS || '', 10)
      if (Number.isFinite(raw) && raw > 0) return raw
      return 28 * 60 * 1000  // 28 min — leaves 2 min of IM-layer headroom
    })()
    const heartbeats = buildHeartbeats(imhubCtx)
    const chain = pickProviderChain()
    // chain always starts with `picked` from above — index 0 is the
    // primary; rest are fallbacks. We walk the chain only when the
    // PREVIOUS attempt ended with a transient provider error and the
    // turn produced no assistant text yet (so retrying is safe — no
    // duplicate replies).
    let result: Awaited<ReturnType<typeof runAgentLoop>> | null = null
    let usedRole = role
    let usedProvider = provider
    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i]
      usedProvider = candidate.provider
      usedRole = candidate.role
      result = await runAgentLoop({
        provider: candidate.provider,
        systemPrompt: buildSystemPrompt(candidate.provider, candidate.role, cwd, planThreadKey),
        messages: effectiveMessages,
        tools,
        dispatch,
        approve,
        callOptions: { model: opts.model },
        // v1.2.92 — actually honour IMHUB_NATIVE_AGENT_MAX_ITER (the
        // banner has been advising operators to set it since v1.2.48
        // but the reader didn't exist; default stayed at 20).
        maxIterations: resolveMaxIterations(),
        // v1.2.98 — goal-critic anchor. agent-loop runs the critic
        // periodically; if it judges the recent tool chain off-track
        // we get finishReason='off_track' and render a redirect recap.
        // Pulls the active long-task goal lazily; failures are silent
        // (critic just won't have the goal anchor, will fall back to
        // the prompt). The critic itself is disabled when
        // IMHUB_NATIVE_CRITIC=off or no `cheap` role is configured.
        criticAnchor: await (async () => {
          let goalTitle: string | undefined
          let goalBody: string | undefined
          if (opts.platform && opts.threadId) {
            try {
              const { getActiveGoal } = await import('../../../core/goals.js')
              const g = getActiveGoal(opts.platform, opts.channelId ?? '', opts.threadId)
              if (g) {
                goalTitle = g.title
                goalBody = g.body ?? undefined
              }
            } catch { /* best-effort */ }
          }
          return { prompt, goalTitle, goalBody }
        })(),
        timeoutMs: nativeTimeoutMs,
        signal: opts.signal,
        audit: {
          agent: `llm:${candidate.provider.name}`,
          intent: 'native.agent.iter',
          userId: opts.userId,
          platform: opts.platform || 'native-agent',
          traceId,
        },
        hooks: heartbeats.hooks,
        // v1.2.109 / T2 — declare read-only / pure tools parallel-safe so
        // multi-call iterations (e.g. "read these 3 files") run
        // concurrently. Now a PER-CALL classifier owned by the tool
        // registry (fail-closed: unknown / throwing → serial), replacing
        // the static per-name set.
        parallelSafeClassifier: assembled.isParallelSafe,
        // v1.2.112 — stream provider responses so partial assistant
        // text survives the IM 30-min hard timeout. Env-gated kill
        // switch (`IMHUB_NATIVE_STREAM_PARTIAL=off` + global
        // `IMHUB_AGENT_LOOP_STREAM=off`) for safety. No onPartialText
        // wired yet — that lands when we push streaming to the IM
        // client. The accumulation itself already saves the partial.
        streamPartialText: resolveNativeStreamPartial(),
      })
      if (result.finishReason !== 'error') break
      const errStr = String(result.error || '')
      const isTransient = /5\d\d|timeout|ECONN|ETIMEDOUT|fetch failed|socket hang up|408|network/i.test(errStr)
      const hasText = result.text && result.text.length > 0
      if (!isTransient || hasText || i === chain.length - 1) break
      log.warn({
        event: 'native.fallback.next',
        from: candidate.provider.name,
        nextIdx: i + 1,
        err: errStr,
      }, `provider ${candidate.provider.name} transient-failed; trying next fallback`)
    }
    heartbeats.shutdown()
    if (!result) {
      // Shouldn't happen — pickProvider above already returned the primary
      // so the chain has at least one entry. Defensive belt-and-suspenders.
      yield '❌ native agent: provider chain ended without any attempt'
      return
    }

    // v1.2.142 — Stage report. Replaces v1.2.94 auto-summary.
    //
    // Any unhappy turn ending (empty / max_iter / stuck_loop / off_track)
    // first tries to produce a *user-facing stage report* with the
    // current provider — based on what got done, what failed, and what
    // to do next. The technical "✓ tool ×N / ✗ tool ×M" recap from
    // v1.2.91 is kept ONLY as a last-resort fallback when the stage
    // report itself fails or comes back empty.
    //
    // Why the change: the operator-facing message previously dumped
    // tool-name counts, which is debugger fodder, not a deliverable.
    // Even a half-failed turn has a real *intermediate result* the
    // user can act on — the model just needs to be asked the right
    // question. See `tryStageReport` for the prompt.
    //
    // The empty/stop branch's logic now lives inside `tryStageReport`
    // — empty `result.text` is one of four kinds it covers, not a
    // special case.

    // Per-turn parent audit row that aggregates the iteration rows
    // already written by runAgentLoop. Lets /tasks#cost sum cost per
    // turn rather than per iteration.
    //
    // NOTE — moved BELOW the body-assembly block in v1.2.142 so the
    // stage-report retry cost is counted in this row. (Was above when
    // auto-summary mutated `result.usage` in place; the new flow
    // returns a separate `extraCost` from tryStageReport instead, so
    // we wait until after body assembly to log.)

    // ─── body assembly ───────────────────────────────────────────────
    //
    // Compose the user-facing reply. v1.2.142 reshuffles the order:
    // each unhappy branch FIRST tries `tryStageReport` (a natural-
    // language stage report based on what got done + what failed +
    // what to do next). Technical `composeUnfinishedTurnRecap` is
    // demoted to last-resort fallback when the stage report itself
    // fails / returns empty.

    let body = result.text
    /** Extra cost from the stage-report retry (when it runs). Added to
     *  the audit row + opts.onUsage below so /tasks#cost stays
     *  accurate. */
    let stageReportCost = 0
    const maxIter = resolveMaxIterations()

    /** Local helper — log the unhappy branch + try stage report.
     *  Returns the stage-report text on success; null when caller
     *  should fall back to its technical recap. */
    const stageOrFallback = async (
      kind: 'empty' | 'max_iter' | 'stuck_loop' | 'off_track',
      offTrackReason?: string,
    ): Promise<string | null> => {
      const stage = await tryStageReport({
        prompt,
        result,
        provider: usedProvider,
        kind,
        offTrackReason,
        model: opts.model,
        signal: opts.signal,
        sessionId,
      })
      if (stage) {
        stageReportCost += stage.costUsd ?? 0
        return stage.text
      }
      return null
    }

    if (result.finishReason === 'error') {
      body = `❌ native agent error: ${result.error ?? '(no detail)'}`
    } else if (result.finishReason === 'max_iterations') {
      log.warn({
        event: 'native.turn.max_iterations',
        sessionId,
        backend: usedProvider.name,
        role: usedRole,
        iterations: result.iterations,
        maxIter,
        toolCallCount: result.toolCalls.length,
        lastToolName: result.toolCalls.length > 0
          ? result.toolCalls[result.toolCalls.length - 1]?.name ?? null
          : null,
        elapsedMs: Date.now() - startedAt,
      }, `native turn hit max iterations cap (${result.iterations}/${maxIter}, tools=${result.toolCalls.length})`)
      body = (await stageOrFallback('max_iter'))
        ?? composeUnfinishedTurnRecap(result, 'max_iter', maxIter)
    } else if (result.finishReason === 'off_track') {
      // v1.2.98 — goal-critic flagged the recent tool chain as
      // semantically off-target. result.error carries
      // "<reason> || redirect: <suggestion>" (or just <reason> when
      // the critic had no redirect to offer). We split it back and
      // surface a recap that names the suspected drift + suggestion.
      const blob = String(result.error ?? '')
      const [reason, ...rest] = blob.split('|| redirect: ')
      const redirect = rest.join('|| redirect: ').trim()
      log.warn({
        event: 'native.turn.off_track',
        sessionId,
        backend: usedProvider.name,
        role: usedRole,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
        reason: reason.trim(),
        redirect: redirect || null,
        elapsedMs: Date.now() - startedAt,
      }, `goal-critic flagged turn as off-track: ${reason.trim()}`)
      const offTrackReason = reason.trim() + (redirect ? `；建议方向：${redirect}` : '')
      body = (await stageOrFallback('off_track', offTrackReason))
        ?? composeOffTrackRecap(result, reason.trim(), redirect)
    } else if (result.finishReason === 'stuck_loop') {
      log.warn({
        event: 'native.turn.stuck_loop',
        sessionId,
        backend: usedProvider.name,
        role: usedRole,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
        lastToolName: result.toolCalls.length > 0
          ? result.toolCalls[result.toolCalls.length - 1]?.name ?? null
          : null,
        elapsedMs: Date.now() - startedAt,
      }, `native turn stopped early — stuck loop after ${result.iterations} iter (tools=${result.toolCalls.length})`)
      body = (await stageOrFallback('stuck_loop'))
        ?? composeUnfinishedTurnRecap(result, 'stuck_loop', maxIter)
    } else if (result.finishReason === 'aborted') {
      body = '⏹ native agent aborted before completion.'
    } else if (result.finishReason === 'hallucinated_tools') {
      // v1.2.147 — agent-loop detected the model narrated a tool
      // invocation ("我现在调用 native_write_file: ```python …```")
      // without actually emitting toolCalls. Surface a recap that
      // names the failure mode + suggests a backend switch, instead
      // of shipping the lie as a normal reply.
      log.warn({
        event: 'native.turn.hallucinated_tools',
        sessionId,
        backend: usedProvider.name,
        role: usedRole,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
        textLen: (result.text || '').length,
        elapsedMs: Date.now() - startedAt,
      }, `native turn ended with hallucinated tool-call narration (no real toolCalls emitted)`)
      body = composeHallucinatedToolRecap(result, usedProvider.name)
    } else if (!body) {
      // Normal `stop` finish but the model didn't write anything. Most
      // often the model completed a tool chain and forgot to close
      // (or the chain failed badly enough that it gave up). Stage
      // report turns either case into a useful user-facing summary.
      const lastCall = result.toolCalls.length > 0
        ? result.toolCalls[result.toolCalls.length - 1]
        : null
      log.warn({
        event: 'native.turn.empty_response',
        sessionId,
        backend: usedProvider.name,
        role: usedRole,
        finishReason: result.finishReason,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
        lastToolName: lastCall?.name ?? null,
        lastToolError: lastCall?.isError ?? null,
        lastToolPreview: lastCall?.preview?.slice(0, 200) ?? null,
        elapsedMs: Date.now() - startedAt,
      }, `native turn ended with empty text (finishReason=${result.finishReason}, ` +
        `iterations=${result.iterations}, tools=${result.toolCalls.length})`)
      // Stage report only runs when there ARE tool calls to summarise;
      // an empty turn with zero tools means the model literally said
      // nothing — recap's "no tools called" branch handles that case.
      if (result.toolCalls.length > 0) {
        body = (await stageOrFallback('empty'))
          ?? composeUnfinishedTurnRecap(result, 'empty', maxIter)
      } else {
        body = composeUnfinishedTurnRecap(result, 'empty', maxIter)
      }
    }

    // ─── audit + usage (v1.2.142 moved below body assembly) ──────────
    // Per-turn parent audit row that aggregates the iteration rows
    // already written by runAgentLoop. `stageReportCost` covers any
    // extra LLM call we made while composing the user-facing message.
    const turnCostUsd = (typeof result.usage.costUsd === 'number' ? result.usage.costUsd : 0)
      + stageReportCost
    try {
      logInvocation({
        traceId,
        userId: opts.userId ?? '',
        platform: opts.platform || 'native-agent',
        agent: this.name,
        intent: 'native.agent.turn',
        promptLen: prompt.length,
        responseLen: body.length,
        durationMs: Date.now() - startedAt,
        cost: turnCostUsd,
        success: result.finishReason !== 'error' && result.finishReason !== 'aborted',
        error: result.error,
      })
    } catch { /* audit best-effort */ }

    // Surface usage to cli's per-session accumulator the same way CLI
    // adapters do (via opts.onUsage).
    if (opts.onUsage && turnCostUsd > 0) {
      try { opts.onUsage({ costUsd: turnCostUsd }) } catch { /* best-effort */ }
    }

    log.info({
      event: 'native.turn.done',
      sessionId,
      backend: usedProvider.name,
      role: usedRole,
      fellBack: usedProvider.name !== provider.name,
      finishReason: result.finishReason,
      iterations: result.iterations,
      toolCalls: result.toolCalls.length,
      stageReportCostUsd: stageReportCost > 0 ? stageReportCost : null,
      elapsedMs: Date.now() - startedAt,
    })

    yield body
  }
}

export const nativeAgentAdapter: AgentAdapter = new NativeAgentAdapter()

/** Lightweight banner for cli.ts boot log. Lets operators see at a
 *  glance whether `/cc native` will work before they try it in an IM
 *  thread. */
export function describeNativeAgent(): string {
  const picked = pickProvider()
  if (!picked) return 'native agent: NOT CONFIGURED (no llmRoles.native-chat / .cheap)'
  return `native agent: backend=${picked.provider.name} (role=${picked.role}); policy=${describePolicy(resolvePolicy())}`
}
