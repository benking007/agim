// Shared runtime pieces for Agim Agent.
//
// The old in-process native AgentAdapter has been retired. Agim Agent is now
// implemented by the pi-agent-core backed adapter, registered
// under the public `native` / `agim` names. This module keeps only the shared
// prompt, policy, operator-role, and media helpers used by that single adapter.

import { randomUUID } from 'node:crypto'
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { join as pathJoin, resolve as pathResolve, sep as pathSep } from 'node:path'
import { approvalBus } from '../../../core/approval-bus.js'
import { type LlmProvider, getAnyProvider, getProvider } from '../../../core/llm/index.js'
import { describeRegistry as describeMcpRegistry } from '../../../core/llm/mcp-registry.js'
import {
  describePolicy,
  type ApprovalMode,
  type PolicyApprovalGateConfig,
} from '../../../core/llm/policy-approval-gate.js'
import type { ToolCallRequest } from '../../../core/llm/provider-base.js'
import { effectivePlanModeOn } from '../../../core/plan-mode-state.js'
import { expandToolNameList } from '../../../core/llm/tool-names.js'
import { sanitizeForInjection, scanForInjectionAttempts } from '../../../core/prompt-injection-guard.js'
import { buildSkillsSummary } from '../../../core/skills/loader.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'native-agent' })
const WORKSPACE_MEMORY_FILE = 'MEMORY.md'

const TOOL_CALL_DISCIPLINE_PROMPT = [
  '## 工具调用纪律（agim 框架级硬约束）',
  '',
  '- 禁止用文本"描述/演练"工具调用；想用工具就直接发 toolCalls，不要先用纯文本预告。',
  '- 工具调用必须真的发生：如果当轮没真正发出 toolCalls，就不要输出"已经写好 / 已经存好 / 已经调了 X"这类口径，不要假装调用了又没调。',
  '- 用户追问"做了吗 / 写好了吗 / 又没消息了"，先回顾本轮 toolCalls 历史；没有就直接坦白"没调成"，禁止编造。',
  '- write / edit / exec 类副作用工具一次性写完整调用，不要分两步"先承诺再调用"。',
].join('\n')

export function isToolDisciplineOn(): boolean {
  const raw = (process.env.AGIM_NATIVE_TOOL_DISCIPLINE ?? '').toLowerCase().trim()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no' || raw === 'disable')
}

export function buildSystemPrompt(
  provider: LlmProvider,
  role: string,
  cwd: string,
  threadKey?: string,
): string {
  const skillsBlock = buildSkillsSummary().trim()
    || '(no skill cards loaded; see docs/skills.md to add one)'
  const mcpReg = describeMcpRegistry()
  const externalMcp = mcpReg.servers.length
    ? mcpReg.servers
      .map((s) => `  - ${s.name} (${s.connected ? `${s.toolCount} tools` : `disconnected${s.error ? `: ${s.error}` : ''}`})`)
      .join('\n')
    : '  (none configured)'

  const lines: string[] = []
  if (isToolDisciplineOn()) {
    lines.push('[agim framework rule — tool-call discipline]')
    lines.push(TOOL_CALL_DISCIPLINE_PROMPT)
    lines.push('[/agim framework rule]')
    lines.push('')
  }

  const opRole = readOperatorRole(cwd)
  if (opRole) {
    lines.push('[operator role definition]')
    lines.push(opRole)
    lines.push('[/operator role definition]')
    lines.push('')
  }

  const workspaceMemory = readWorkspaceMemory(cwd)
  if (workspaceMemory) {
    lines.push('[workspace memory: MEMORY.md]')
    lines.push('Operator-maintained long-term notes for this Agim agent. Current user, developer, and system instructions take precedence if they conflict.')
    lines.push(workspaceMemory)
    lines.push('[/workspace memory]')
    lines.push('')
  }

  lines.push(
    `You are agim native — agim's in-process LLM agent talking to a user over an IM platform.`,
    '',
    'Runtime:',
    `  Backend:           ${provider.providerType}:${provider.name}`,
    `  Role:              ${role}`,
    `  Working directory: ${cwd}`,
    '',
  )

  if (isPlanModeOn(threadKey)) {
    lines.push(
      '⚠ Plan mode is ACTIVE',
      '  - You MUST produce a read-only plan; agim_write_file and agim_exec are HARD-BLOCKED.',
      '  - Use read tools freely: agim_read_file / agim_list_dir / agim_glob / agim_grep / agim_web_fetch / agim_web_search.',
      '  - When the plan is ready, call agim_exit_plan_mode({ plan }) so the user can approve or reject it.',
      '',
    )
  }

  lines.push(
    'Tools available beyond the four native built-ins (echo / now / sleep / random_uuid):',
    '  - agim built-in MCP tools (mcp__agim__*): read_skill, list_skills, save_memo, search_memos, update_memo, delete_memo, push_message, ask_user, call_agent, long_task, complete_goal',
    '  - native filesystem tools: agim_read_file, agim_write_file, agim_list_dir, agim_glob, agim_grep — full filesystem access by default (set AGIM_NATIVE_FS_RESTRICT=1 to confine to your workspace cwd; sensitive paths always denied)',
    '  - native web tools: agim_web_fetch, agim_web_search. Private IPs blocked by default.',
    '  - agim_exec(command, timeout_ms?, cwd?): run shell commands. Always approval-gated.',
    '  - External MCP servers configured by the operator:',
    externalMcp,
    '',
    'Agim Skills system-prompt injection:',
    skillsBlock,
    '',
    'Guidance:',
    '  - Be terse; avoid filler. Prefer tool use over guessing.',
    '  - When uncertain, call mcp__agim__ask_user(question, choices[]) instead of free-form back-and-forth.',
    '  - When the user references something they told the bot before, search memos via mcp__agim__search_memos.',
    '  - For file/list/search/fetch requests, use native tools first; reserve call_agent for work that genuinely needs another CLI agent.',
    '  - Closure rule: after a tool chain, write a short Chinese summary before stopping.',
    '',
    'Verification subagent:',
    '  - After a substantive result, use call_agent with a fresh verifier when a second pass is valuable.',
    "  - Synthesize, don't delegate understanding: state the exact claim and how to verify it.",
    '  - Give the verifier a self-contained brief; it does not see this conversation.',
  )
  return lines.join('\n')
}

interface OperatorRoleCacheEntry { mtimeMs: number; size: number; content: string }
const operatorRoleCache = new Map<string, OperatorRoleCacheEntry>()

function readRoleFile(path: string): string {
  let st: import('node:fs').Stats
  try {
    st = fsStatSync(path)
  } catch {
    operatorRoleCache.delete(path)
    return ''
  }
  const cached = operatorRoleCache.get(path)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.content

  let raw = ''
  try { raw = fsReadFileSync(path, 'utf-8') } catch { operatorRoleCache.delete(path); return '' }
  const trimmed = raw.trim()
  if (!trimmed) {
    operatorRoleCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, content: '' })
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
  operatorRoleCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, content })
  return content
}

export function readOperatorRole(cwd: string): string {
  const override = process.env.AGIM_NATIVE_AGENT_ROLE_FILE
  if (override && override.length > 0) return readRoleFile(override)
  if (!isWorkspaceTrusted()) return ''
  const parts: string[] = []
  for (const p of [pathJoin(cwd, 'AGENTS.md'), pathJoin(cwd, 'AGENTS.local.md')]) {
    const c = readRoleFile(p)
    if (c) parts.push(c)
  }
  return parts.join('\n\n')
}

export function readWorkspaceMemory(cwd: string): string {
  if (!isWorkspaceTrusted()) return ''
  return readRoleFile(pathJoin(cwd, WORKSPACE_MEMORY_FILE))
}

export function isWorkspaceTrusted(): boolean {
  const raw = (process.env.AGIM_NATIVE_TRUST_WORKSPACE ?? '').toLowerCase().trim()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no')
}

const DEFAULT_ROLE_FALLBACK: string[] = ['native-chat', 'cheap']

function resolveRole(): string[] {
  const raw = process.env.AGIM_NATIVE_AGENT_ROLE
  if (raw?.trim()) return [raw.trim(), ...DEFAULT_ROLE_FALLBACK]
  return DEFAULT_ROLE_FALLBACK.slice()
}

function pickProvider(): { provider: LlmProvider; role: string } | null {
  for (const role of resolveRole()) {
    const p = getProvider(role)
    if (p) return { provider: p, role }
  }
  const fallback = getAnyProvider()
  if (fallback) return { provider: fallback, role: 'auto' }
  return null
}

function splitEnvList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Canonical local mutation tools blocked while Plan Mode is active.
 * Exported so the pi-native hard gate and policy gate cannot drift apart. */
export const PLAN_MODE_DENY_TOOLS: ReadonlySet<string> = new Set([
  'agim_write_file',
  'agim_exec',
])

export function resolvePolicy(threadKey?: string): PolicyApprovalGateConfig {
  const mode = (process.env.AGIM_NATIVE_AGENT_MODE || 'allow-list').toLowerCase() as ApprovalMode
  const autoAllow = splitEnvList(process.env.AGIM_NATIVE_AGENT_AUTOALLOW)
  const denyList = splitEnvList(process.env.AGIM_NATIVE_AGENT_DENYLIST)
  // Default autoAllow list is empty — when AGIM_AUTO_APPROVE=1 (default),
  // the approval bus handles auto-approval for all tools after safety
  // checks. Operators can still populate AGIM_NATIVE_AGENT_AUTOALLOW to
  // pre-approve specific tools even when auto-approve is off.
  const effectiveAllow = autoAllow
  const effectiveDeny = isPlanModeOn(threadKey)
    ? Array.from(expandToolNameList([...denyList, ...PLAN_MODE_DENY_TOOLS]))
    : denyList
  return { mode, autoAllow: effectiveAllow, denyList: effectiveDeny }
}

export function isPlanModeOn(threadKey?: string): boolean {
  return effectivePlanModeOn(threadKey)
}

export function buildNativeAskUser(opts: {
  runId: string
  platform: string
  channelId: string
  threadId: string
  userId: string
}): (call: ToolCallRequest, signal?: AbortSignal) => Promise<'allow' | 'deny'> {
  const baseCtx = {
    platform: opts.platform,
    channelId: opts.channelId,
    threadId: opts.threadId,
    userId: opts.userId,
    callerAgent: 'agim',
  }
  return async (call: ToolCallRequest, signal?: AbortSignal): Promise<'allow' | 'deny'> => {
    if (signal?.aborted) return 'deny'
    const reqId = randomUUID()
    return await new Promise<'allow' | 'deny'>((resolve, reject) => {
      let settled = false
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      const finish = (decision: 'allow' | 'deny') => {
        if (settled) return
        settled = true
        cleanup()
        resolve(decision)
      }
      const onAbort = () => {
        // If registration has reached pendingById this drains the card now.
        // If it has not, the registration continuation below retries.
        approvalBus.cancelPendingByReqId(reqId, 'approval cancelled: agent turn aborted')
        finish('deny')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      void approvalBus.registerSyntheticPending({
        runId: opts.runId,
        reqId,
        toolName: call.name,
        input: call.arguments,
        ctx: baseCtx,
        dispatch: (decision) => finish(decision.behavior),
      }).then(() => {
        // Covers abort racing before _registerPending inserted the request.
        if (signal?.aborted) {
          approvalBus.cancelPendingByReqId(reqId, 'approval cancelled: agent turn aborted')
        }
      }).catch((err) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      })
    })
  }
}

export function parsePromptMedia(prompt: string): Array<{ path: string; mime?: string }> {
  if (!prompt) return []
  const re = /\[(?:图片附件|image attachment)[：:]\s*([^\]]+)\]/g
  const out: Array<{ path: string; mime?: string }> = []
  const home = process.env.HOME || '/root'
  const mediaRootRaw = process.env.AGIM_MEDIA_ROOT || `${home}/.agim/media`
  const mediaRoot = pathResolve(mediaRootRaw)
  const mediaPrefix = mediaRoot.endsWith(pathSep) ? mediaRoot : mediaRoot + pathSep
  for (;;) {
    const m = re.exec(prompt)
    if (m === null) break
    const rawPath = (m[1] || '').trim()
    if (!rawPath?.startsWith('/')) continue
    const normalised = pathResolve(rawPath)
    if (normalised !== mediaRoot && !normalised.startsWith(mediaPrefix)) continue
    try {
      if (!fsExistsSync(normalised)) continue
      if (!fsStatSync(normalised).isFile()) continue
    } catch { continue }
    if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(normalised)) continue
    out.push({ path: normalised })
  }
  return out
}

export function describeNativeAgent(): string {
  const picked = pickProvider()
  if (!picked) return 'Agim Agent: NOT CONFIGURED (no usable llmBackends + API key)'
  return `Agim Agent: backend=${picked.provider.name} (role=${picked.role}); policy=${describePolicy(resolvePolicy())}`
}
