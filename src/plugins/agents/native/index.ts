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
  buildMcpDispatcher,
  combineDispatchers,
  getProvider,
  getAllMcpTools,
  type LlmMessage,
  type LlmProvider,
  type ToolDef,
} from '../../../core/llm/index.js'
import {
  buildBuiltinDispatcher,
  getBuiltinTools,
} from '../../../core/llm/builtin-dispatcher.js'
import {
  buildPolicyApprovalGate,
  describePolicy,
  type ApprovalMode,
  type PolicyApprovalGateConfig,
} from '../../../core/llm/policy-approval-gate.js'
import {
  buildImhubDispatcher,
  getImhubTools,
} from '../../../core/llm/imhub-dispatcher.js'
import {
  buildFsDispatcher,
  getFsTools,
} from '../../../core/llm/fs-dispatcher.js'
import {
  buildWebDispatcher,
  getWebTools,
} from '../../../core/llm/web-dispatcher.js'
import {
  buildExecDispatcher,
  getExecTools,
} from '../../../core/llm/exec-dispatcher.js'
import { listSkills } from '../../../core/skills/loader.js'
import { describeRegistry as describeMcpRegistry } from '../../../core/llm/mcp-registry.js'
import { resolveAgentCwd, defaultAgentCwd } from '../../../core/agent-cwd.js'
import { handlePushOp } from '../../../core/push-rpc.js'
import { approvalBus } from '../../../core/approval-bus.js'
import { randomUUID as _nativeRandomUUID } from 'node:crypto'
import type { ToolCallRequest } from '../../../core/llm/provider-base.js'
import { maybeCompactHistory } from '../../../core/llm/auto-compact.js'
import { existsSync as fsExistsSync, statSync as fsStatSync, readFileSync as fsReadFileSync } from 'node:fs'
import { resolve as pathResolve, sep as pathSep, join as pathJoin } from 'node:path'
import { sanitizeForInjection, scanForInjectionAttempts } from '../../../core/prompt-injection-guard.js'

const log = rootLogger.child({ component: 'native-agent' })

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
function buildSystemPrompt(provider: LlmProvider, role: string, cwd: string): string {
  const skills = listSkills()
  const skillsBlock = skills.length
    ? skills.map((s) => `  - ${s.name}: ${s.description}`).join('\n')
    : '  (no skill cards loaded; see docs/skills.md to add one)'
  const mcpReg = describeMcpRegistry()
  const externalMcp = mcpReg.servers.length
    ? mcpReg.servers
        .map((s) => `  - ${s.name} (${s.connected ? `${s.toolCount} tools` : `disconnected${s.error ? `: ${s.error}` : ''}`})`)
        .join('\n')
    : '  (none configured)'

  const lines: string[] = []

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

/** Read <cwd>/AGENTS.md (if present) and prepare it for injection into
 *  the system prompt. Returns '' on missing file / read failure / empty
 *  content. Sanitises text length (8000 char cap) and scans for the
 *  classic prompt-injection signals ("ignore previous instructions",
 *  "always allow", etc.); when matches are found we still inject (the
 *  operator likely wrote them deliberately) but log a warn + audit
 *  hit so post-incident forensics can correlate. Honours
 *  IMHUB_NATIVE_AGENT_ROLE_FILE for a non-default location. */
export function readOperatorRole(cwd: string): string {
  const override = process.env.IMHUB_NATIVE_AGENT_ROLE_FILE
  const path = override && override.length > 0 ? override : pathJoin(cwd, 'AGENTS.md')
  if (!fsExistsSync(path)) return ''
  let raw = ''
  try { raw = fsReadFileSync(path, 'utf-8') } catch { return '' }
  const trimmed = raw.trim()
  if (!trimmed) return ''
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
  return sanitizeForInjection(trimmed, 8000)
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

/** Read IMHUB_NATIVE_AGENT_MAX_ITER, clamp to [1, 100], default 20.
 *  v1.2.92 — previously this env var was named in the user-facing
 *  banner ("raise IMHUB_NATIVE_AGENT_MAX_ITER") but NOTHING in code
 *  read it. Now actually wired into runAgentLoop. */
function resolveMaxIterations(): number {
  const raw = process.env.IMHUB_NATIVE_AGENT_MAX_ITER
  if (!raw?.trim()) return 20
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 20
  return Math.min(Math.max(n, 1), 100)
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
function resolvePolicy(): PolicyApprovalGateConfig {
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
  ]
  const effectiveAllow = mode === 'allow-list'
    ? Array.from(new Set([...autoAllow, ...defaultBuiltins]))
    : autoAllow
  return { mode, autoAllow: effectiveAllow, denyList }
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
    const imhubCtx = {
      platform: opts.platform || 'native-agent',
      channelId: opts.channelId || 'default',
      threadId: opts.threadId || sessionId,
      userId: opts.userId || 'unknown',
      callerAgent: 'native',
      callerDepth: opts.callDepth ?? 0,
    }
    // Resolve cwd here so fs-dispatcher can constrain reads/writes to
    // the per-thread workspace subtree. Was previously resolved AFTER
    // dispatch composition; moved up so fs tools see the right root.
    const cwd = resolveAgentCwd('native', opts) || defaultAgentCwd('native')
    const dispatch = combineDispatchers(
      buildBuiltinDispatcher(),
      buildFsDispatcher({ cwd }),
      buildWebDispatcher(),
      buildExecDispatcher({
        cwd,
        // v1.2.97 — when this thread has a usable RunContext, hand it
        // to exec-dispatcher so every spawned child inherits a fresh
        // RPC token bound to the thread. Enables the Python-RPC bridge
        // (bgjob worker → agim parent → memo/skill/push). Tokens are
        // per-spawn, expire in 24h, and only authorise THIS thread.
        rpcCtx: opts.platform && opts.threadId
          ? {
            platform: opts.platform,
            channelId: opts.channelId ?? '',
            threadId: opts.threadId,
            userId: opts.userId ?? '',
          }
          : undefined,
      }),
      buildImhubDispatcher(imhubCtx),
      buildMcpDispatcher(),
    )

    // Compose tool list the same way (built-in → fs → web → exec → imhub → external MCP).
    // Provider tool roster wins on duplicate names via "later
    // definition wins" semantics inside the provider, but our naming
    // is namespaced (`native_*`, `mcp__imhub__*`, `mcp_<server>_*`)
    // so collisions are not expected in practice.
    const tools: ToolDef[] = [
      ...getBuiltinTools(),
      ...getFsTools(),
      ...getWebTools(),
      ...getExecTools(),
      ...getImhubTools(),
      ...getAllMcpTools(),
    ]

    const policy = resolvePolicy()
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

    const traceId = `native-${sessionId}-${Date.now()}`
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
        systemPrompt: buildSystemPrompt(candidate.provider, candidate.role, cwd),
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

    // v1.2.94 — auto-summary retry. When the loop ended naturally
    // (`stop`) with empty assistant text BUT we had a real tool chain,
    // the model usually did the work and just forgot to write the
    // closing sentence the user actually wants to read. Re-prompt the
    // SAME provider once with no tools and a compact transcript of
    // what just happened. Cost is bounded (one extra small call,
    // 60s deadline, tools=[] so it can't keep chaining). On failure
    // or empty output we fall through to v1.2.91 recap as before.
    if (
      !result.text
      && result.finishReason === 'stop'
      && result.toolCalls.length > 0
      && usedProvider
    ) {
      try {
        // Build a compact transcript: tool name + 300-char preview per
        // call. Capped at the most recent 20 calls so even a runaway
        // chain doesn't blow the prompt budget.
        const recent = result.toolCalls.slice(-20)
        const transcript = recent
          .map((t, i) => {
            const status = t.isError ? '✗ FAILED' : '✓'
            const preview = (t.preview ?? '').trim().slice(0, 300).replace(/\s+/g, ' ')
            return `${i + 1}. [${status}] ${t.name}\n   ${preview}${(t.preview?.length ?? 0) > 300 ? '…' : ''}`
          })
          .join('\n')
        const summaryMessages: LlmMessage[] = [
          {
            role: 'system',
            content:
              '你是 agim native 智能体。刚才你为用户调用了一系列工具拿到了结果，但忘记给收尾文字。' +
              '现在请用中文给用户一个清晰、完整、可读的最终回答——整合工具结果、不要再调任何工具、不要要求用户再做什么。',
          },
          { role: 'user', content: prompt },
          {
            role: 'user',
            content:
              `[刚才执行的工具调用，共 ${result.toolCalls.length} 次，` +
              `下面是最近 ${recent.length} 次的摘要]\n${transcript}\n\n` +
              `[请基于上面的工具结果，给用户最终的中文答案]`,
          },
        ]
        log.info({
          event: 'native.turn.auto_summary.start',
          sessionId,
          backend: usedProvider.name,
          toolCallCount: result.toolCalls.length,
        }, `attempting auto-summary retry for empty-text turn (${result.toolCalls.length} tools)`)
        const retry = await usedProvider.chat(summaryMessages, {
          model: opts.model,
          timeoutMs: 60_000,
          signal: opts.signal,
        })
        if (retry.text && retry.text.trim().length > 0) {
          log.info({
            event: 'native.turn.auto_summary.ok',
            sessionId,
            backend: usedProvider.name,
            textLen: retry.text.length,
            costUsd: retry.usage?.costUsd ?? null,
          }, `auto-summary produced ${retry.text.length} chars`)
          // Replace the text. Preserve everything else (toolCalls,
          // iterations, finishReason) for downstream audit accuracy.
          result = { ...result, text: retry.text }
          // Add the retry's cost to the turn's usage so /tasks#cost
          // sums correctly. retry.usage may be undefined for some
          // providers; only patch the field when present.
          if (retry.usage?.costUsd != null) {
            const base = typeof result.usage.costUsd === 'number' ? result.usage.costUsd : 0
            result = { ...result, usage: { ...result.usage, costUsd: base + retry.usage.costUsd } }
          }
        } else {
          log.warn({
            event: 'native.turn.auto_summary.empty',
            sessionId,
            backend: usedProvider.name,
          }, 'auto-summary retry also returned empty text — falling through to recap')
        }
      } catch (err) {
        log.warn({
          event: 'native.turn.auto_summary.failed',
          sessionId,
          backend: usedProvider.name,
          err: err instanceof Error ? err.message : String(err),
        }, 'auto-summary retry threw — falling through to recap')
      }
    }

    // Per-turn parent audit row that aggregates the iteration rows
    // already written by runAgentLoop. Lets /tasks#cost sum cost per
    // turn rather than per iteration.
    try {
      logInvocation({
        traceId,
        userId: opts.userId ?? '',
        platform: opts.platform || 'native-agent',
        agent: this.name,
        intent: 'native.agent.turn',
        promptLen: prompt.length,
        responseLen: result.text.length,
        durationMs: Date.now() - startedAt,
        cost: typeof result.usage.costUsd === 'number' ? result.usage.costUsd : 0,
        success: result.finishReason !== 'error' && result.finishReason !== 'aborted',
        error: result.error,
      })
    } catch { /* audit best-effort */ }

    // Surface usage to cli's per-session accumulator the same way CLI
    // adapters do (via opts.onUsage). agim's cost dashboard reads from
    // the audit table either way, but the in-memory session usage panel
    // wants it pushed here too.
    if (opts.onUsage && typeof result.usage.costUsd === 'number') {
      try { opts.onUsage({ costUsd: result.usage.costUsd }) } catch { /* best-effort */ }
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
      elapsedMs: Date.now() - startedAt,
    })

    // Compose the user-facing reply. Failure modes surface as ASCII
    // banners so the IM user sees something concrete rather than
    // silence (and so logs in /tasks#cost have a non-empty
    // response_len to filter on).
    let body = result.text
    if (result.finishReason === 'error') {
      body = `❌ native agent error: ${result.error ?? '(no detail)'}`
    } else if (result.finishReason === 'max_iterations') {
      // v1.2.92 — replaced the static "raise IMHUB_NATIVE_AGENT_MAX_ITER"
      // banner with a structured recap that lists the tool work
      // already done, names the most-recent step, and offers three
      // continuation paths (continue / split task / raise cap).
      log.warn({
        event: 'native.turn.max_iterations',
        sessionId,
        backend: usedProvider.name,
        role: usedRole,
        iterations: result.iterations,
        maxIter: resolveMaxIterations(),
        toolCallCount: result.toolCalls.length,
        lastToolName: result.toolCalls.length > 0
          ? result.toolCalls[result.toolCalls.length - 1]?.name ?? null
          : null,
        elapsedMs: Date.now() - startedAt,
      }, `native turn hit max iterations cap (${result.iterations}/${resolveMaxIterations()}, tools=${result.toolCalls.length})`)
      body = composeUnfinishedTurnRecap(result, 'max_iter', resolveMaxIterations())
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
      body = composeOffTrackRecap(result, reason.trim(), redirect)
    } else if (result.finishReason === 'stuck_loop') {
      // v1.2.95 — agent-loop's stuck-loop detector cut us off after
      // three consecutive identical (name + isError + preview) tool
      // calls. Saves the rest of the iteration budget and tells the
      // user exactly where the model got stuck.
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
      body = composeUnfinishedTurnRecap(result, 'stuck_loop', resolveMaxIterations())
    } else if (result.finishReason === 'aborted') {
      body = '⏹ native agent aborted before completion.'
    } else if (!body) {
      // v1.2.89 — diagnostic log: tell the three known triggers
      // apart in the audit trail.
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
      // v1.2.91 — render a structured recap instead of the opaque
      // "(native agent returned an empty response)" banner. Most
      // empty-text turns aren't actual failures: the model
      // completed a tool chain (search, fetch, ask_user, …) and
      // simply omitted the closing summary. To the IM user this
      // looked like the agent froze mid-task. The recap surfaces
      // what got done, why we think it stopped, and concrete
      // next-step options so the conversation can continue
      // instead of dying on the spot.
      body = composeUnfinishedTurnRecap(result, 'empty', resolveMaxIterations())
    }
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
