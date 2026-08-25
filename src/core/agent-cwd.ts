// Per-agent working directory resolution for the IM context.
//
// Both Claude Code and opencode key their per-project memory / history off
// the spawned process's cwd. When agim runs as a systemd service, that cwd
// is "/" — so every IM thread, every direct-terminal session, and every
// background scheduler tick all share the SAME global memory bucket. This
// is the root cause of:
//
//   - The IM-only Claude not being able to carry a distinct CLAUDE.md role
//   - The user's terminal MEMORY.md getting polluted by IM auto-saves
//   - opencode's AGENTS.md being unable to differ between IM and terminal
//
// Fix: when we detect we're in an IM call (threadId + platform both set),
// pin the agent into a stable per-agent workspace under
// `~/.agim-workspaces/<agent>/`. Non-IM calls (web UI, scheduler,
// intent-llm judge) keep the inherited cwd, preserving prior behavior.
//
// Override path: `AGIM_<AGENT>_CWD` env var beats everything (e.g.
// `AGIM_CLAUDE_CODE_CWD=/srv/foo`). Useful for migration tests and for
// future per-tenant deployments.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { mkdir, writeFile, access, readFile, appendFile } from 'node:fs/promises'
import type { AgentSendOpts } from './types.js'
import { AGIM_WORKSPACES } from './agim-paths.js'
import { currentAccountUserId } from './accounts.js'

/** Portable bgjob wrapper expression for role books / prompts.
 *  Shell expands this to an absolute path on any user home (Linux / macOS).
 *  Do NOT bake host-specific `/home/<user>/...` into AGENTS.md. */
export const AGIM_BGJOB_WRAPPER_EXPR = '"${AGIM_HOME:-$HOME/.agim}/scripts/bgjob"'
export const AGIM_BGJOBS_DIR_EXPR = '${AGIM_HOME:-$HOME/.agim}/bgjobs'
export const AGIM_HOME_EXPR = '${AGIM_HOME:-$HOME/.agim}'

/** Root for all per-agent IM workspaces. Kept stable so memory persists.
 *  Honors the `AGIM_WORKSPACES_ROOT` env override; otherwise resolves via
 *  core/agim-paths. */
export function agimWorkspacesRoot(): string {
  return process.env.AGIM_WORKSPACES_ROOT || AGIM_WORKSPACES
}

/** Default cwd for a given agent under the workspaces root. */
export function defaultAgentCwd(agentName: string): string {
  // Naming v2: registry id `agim` (legacy `native` maps to the same tree).
  const id = (agentName === 'native' || agentName === 'agim') ? 'agim' : agentName
  return join(agimWorkspacesRoot(), id)
}

/** Filesystem-safe account id for `~/.agim-workspaces/users/<id>/`. */
export function sanitizeAccountWorkspaceId(userId: string): string {
  const trimmed = userId.trim()
  if (!trimmed) return 'unknown'
  return trimmed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}

/** Registered members only (`usr_*`). Ignores loopback / token / `web:` actors. */
export function isAccountWorkspaceUserId(userId: string | undefined | null): userId is string {
  return typeof userId === 'string' && /^usr_[A-Za-z0-9_-]+$/.test(userId)
}

/** Show `~/…` when the path is inside the current home; otherwise keep absolute. */
export function toDisplayWorkspacePath(absPath: string): string {
  const home = homedir().replace(/\\/g, '/')
  const normalized = absPath.replace(/\\/g, '/')
  if (normalized === home) return '~'
  if (normalized.startsWith(`${home}/`)) return `~${normalized.slice(home.length)}`
  return absPath
}

export type AgentWorkspaceDirOpts = {
  dir?: string
  workspaceRoot?: string
}

/** Per-account agent cwd: `~/.agim-workspaces/users/<userId>/<agent>/`. */
export function agentCwdForAccount(agentName: string, userId: string): string {
  const id = (agentName === 'native' || agentName === 'agim') ? 'agim' : agentName
  return join(agimWorkspacesRoot(), 'users', sanitizeAccountWorkspaceId(userId), id)
}

/**
 * Root shown in Agent Files. Env `AGIM_<AGENT>_CWD` still wins; otherwise
 * a logged-in account gets its own tree so members cannot browse each
 * others' files (or the shared IM workspace).
 */
export function resolveAgentFilesRoot(agentName: string, accountUserId?: string): string {
  const explicit = process.env[envKeyFor(agentName)]
  if (explicit?.trim()) return explicit.trim()
  if (isAccountWorkspaceUserId(accountUserId)) return agentCwdForAccount(agentName, accountUserId)
  return defaultAgentCwd(agentName)
}

/**
 * Agent workspace root for role / memory / PROJECTS — not the Portal
 * subdirectory bound as process cwd.
 *
 * Env `AGIM_<AGENT>_CWD` wins (same as bootstrap). Portal `workspacePath`
 * never moves this root: selected folders are for project file I/O only.
 */
export function resolveAgentWorkspaceRoot(agentName: string): string {
  const explicit = process.env[envKeyFor(agentName)]
  if (explicit?.trim()) return explicit.trim()
  const accountUserId = currentAccountUserId()
  if (isAccountWorkspaceUserId(accountUserId)) {
    return agentCwdForAccount(agentName, accountUserId)
  }
  return defaultAgentCwd(agentName)
}

/**
 * Ephemeral hint when Portal binds a subdirectory as the working directory.
 * Project files follow `workspacePath`; AGENTS.md / MEMORY.md stay at root.
 */
export function buildPortalWorkspaceHint(agentName: string, workspacePath: string): string {
  const cwd = workspacePath.trim()
  const root = resolveAgentWorkspaceRoot(agentName)
  const lines = [
    '## Portal workspace',
    `Working directory: \`${cwd}\``,
    'Treat this path as the project root for listing, reading, and writing project files unless the user names another path.',
  ]
  if (cwd && cwd !== root) {
    lines.push(
      `Workspace root: \`${root}\``,
      'Keep AGENTS.md / CLAUDE.md, MEMORY.md, PROJECTS, and Loop reports at the workspace root. Do not move them into the working directory.',
    )
  }
  return lines.join('\n')
}

/** Env var name for an explicit override on a given agent. */
function envKeyFor(agentName: string): string {
  // claude-code -> AGIM_CLAUDE_CODE_CWD
  return `AGIM_${agentName.replace(/-/g, '_').toUpperCase()}_CWD`
}

export function roleFileForAgent(agentName: string): string {
  return agentName === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md'
}

export const AGIM_MEMORY_LINK_START = '<!-- agim:memory-link:start -->'
const AGIM_MEMORY_LINK_END = '<!-- agim:memory-link:end -->'
const AGIM_MEMORY_LINK_BLOCK = `${AGIM_MEMORY_LINK_START}
## Agim 工作区记忆 / Workspace memory

- 如果本工作区根目录存在 \`MEMORY.md\`，在开始处理 Agim 对话前先读取它。
- Treat \`MEMORY.md\` as operator-maintained long-term context for this agent.
- 如果它与本轮用户消息或更高优先级指令冲突，以当前消息和更高优先级指令为准。
${AGIM_MEMORY_LINK_END}`

/** Managed IM / bgjob SOP — baseline for EVERY IM agent workspace
 *  (Agim / Claude / opencode / Codex / …). Upserted on bootstrap into
 *  each agent's CLAUDE.md / AGENTS.md; operator edits outside the markers
 *  are preserved. Paths are portable shell expressions, never host-absolute.
 *
 *  Upgrade policy: never rewrite the whole role file. Seed only creates
 *  missing files; existing AGENTS.md / CLAUDE.md are patched solely inside
 *  these markers after a content diff. Put `AGIM_IM_OPS_FREEZE` anywhere in
 *  the file (or set AGIM_IM_OPS_REFRESH=off) to opt out of managed refresh. */
export const AGIM_IM_OPS_START = '<!-- agim:im-ops:start -->'
export const AGIM_IM_OPS_END = '<!-- agim:im-ops:end -->'
/** Opt-out marker: when present, bootstrap will not refresh im-ops. */
export const AGIM_IM_OPS_FREEZE = '<!-- agim:im-ops:freeze -->'

function normalizeAgentId(agentName: string): string {
  return (agentName === 'native' || agentName === 'agim') ? 'agim' : agentName
}

/** Shared 「对话逻辑」block — also embedded in Agim seed above 任务执行. */
export function buildAgimDialogueLogicSection(): string {
  return `## 对话逻辑

用户问结论、分析、建议或「发生了什么」时，**必须在对话里给全用户需要决策的内容**（结论、关键依据、可执行动作）。

### Web / Portal / macOS·iOS 壳 / TUI（\`platform=web|tui\`）
这些渠道渲染完整 Markdown。**禁止**「仅摘要 + 落盘 / Viewer 链接」代替正文；长文直接写进对话。
（运行时也会硬展开：\`<im-summary>/<full-md>\` 取全文；检测到「报告已落盘：*.md」且文件更长时会把正文并入回复。）

### IM 客户端（微信 / 企微 / 钉钉 / 飞书 / QQ / Telegram / Discord / Email 等）
- 长内容（**超过 8k**）可落盘，文末附路径；即便落盘，也应尽量在对话里给全决策要点。
- 启用 Viewer 时：可总结为单条约 4–8 KB 要点，正文落盘，消息末附 Viewer 地址；也可用 \`<im-summary>/<full-md>\` 信封。`
}

export function buildAgimImOpsBlock(
  agentName = 'agim',
  opts: { includeDialogueLogic?: boolean; workspaceRoot?: string } = {},
): string {
  const id = normalizeAgentId(agentName)
  const roleFile = roleFileForAgent(id === 'agim' ? 'agim' : agentName)
  const workspaceRoot = (opts.workspaceRoot ?? `~/.agim-workspaces/${id}`).replace(/\/+$/, '')
  const isAgim = id === 'agim'
  // Agim seed already places 「对话逻辑」above 任务执行 (outside markers).
  // Other agents only get it via this managed block.
  const includeDialogue = opts.includeDialogueLogic ?? !isAgim
  const invokeHow = isAgim
    ? '后台任务必须使用 `agim_exec` 调用，且路径需展开为绝对路径；禁止直接使用裸 `bgjob` 或 `nohup … &`。'
    : '后台任务必须通过本 agent 的 shell / Bash 工具调用，且路径需展开为绝对路径；禁止直接使用裸 `bgjob` 或 `nohup … &`。'
  const writeHow = isAgim
    ? '如果需要编写脚本，先调用 `agim_write_file` 将脚本写入文件，再用 bgjob 启动。'
    : '如果需要编写脚本，先将脚本写入文件，再用 bgjob 启动。'
  const dialogue = includeDialogue ? `${buildAgimDialogueLogicSection()}\n\n` : ''

  return `${AGIM_IM_OPS_START}
${dialogue}## 长时间任务与 bgjob 后台执行

遇到任务请先预估耗时，再选择执行路径：

| 预估耗时 | 执行方式 |
|-----------|-----------|
| < 5 分钟 | 同步直接完成 |
| 5–10 分钟 | 同步执行，但**每隔 1–2 分钟将中间结果写入文件**，确保即使意外中断也有产物留下 |
| > 10 分钟 | **强制使用 bgjob 后台执行**（见下方启动方法） |
| 无法预估 | 先取小样本运行 3–5 分钟，根据吞吐量推算总耗时，再选择路径 |

**任何预估超过 10 分钟的任务**：必须先向用户展示执行计划和预估时间，**获得确认后才能启动**，禁止擅自开始。

### bgjob 启动方法

首次使用前，先执行 \`agim start\` 将 bgjob wrapper 安装到 \`~/.agim/scripts/bgjob\`（可通过环境变量 \`AGIM_HOME\` 覆盖根目录）。
${invokeHow}
启动命令模板：
\`\`\`bash
${AGIM_BGJOB_WRAPPER_EXPR} start <slug> -- <要执行的命令...>
\`\`\`

查看状态：
\`\`\`bash
${AGIM_BGJOB_WRAPPER_EXPR} status <slug>
${AGIM_BGJOB_WRAPPER_EXPR} tail <slug>
${AGIM_BGJOB_WRAPPER_EXPR} list --running
\`\`\`

数据存放目录：\`${AGIM_BGJOBS_DIR_EXPR}\`（所有 agent 共用；可在 Web 控制台的 Tasks → Background 和 Portal 小精灵“进行中”查看进度）。

**流程要求**：
- ${writeHow}
- 启动成功后，立即向用户回复完整的 job id 和日志路径，然后结束当前同步回合。
- 任务退出后，系统会自动向原对话推送结果（若设置 \`AGIM_BGJOB_AUTOSUMMARY=on\` 还会附加日志摘要）。

**注意**：跑批处理、模型训练、大批量数据抓取等长任务请一律使用 bgjob。

## 长期记忆与项目档案

| 档案类型 | 存储位置（相对于工作区根目录） | 用途 |
|-----------|--------------------------------|------|
| 工作区记忆 | \`MEMORY.md\` | 跨会话沉淀的用户偏好、事实信息 |
| 项目档案 | \`PROJECTS/<slug>.md\` | 长期主题的**归档**（目标/进度/关键决定/待办/完整分析副本） |
| Loop 详细报告 | \`PROJECTS/loops/<session>-<loopId>.md\` | Portal 结案后用户同意时，Agent 撰写并落盘；聊天展示全文 |
| 会话摘要（可选） | \`SESSIONS/YYYY-MM-DD-<topic>.md\` | 重要会话的沉淀 |

工作区根目录为 \`${workspaceRoot}/\`，不同 agent 的工作区之间互不读取。

## 资源路径速查

| 项目 | 路径 |
|------|------|
| 当前工作区 | \`${workspaceRoot}/\` |
| 角色约束文件 | 工作区根目录下的 \`${roleFile}\` |
| Agim 状态目录 | \`${AGIM_HOME_EXPR}\` |
| bgjob wrapper | \`${AGIM_BGJOB_WRAPPER_EXPR}\` |
| bgjob 数据目录 | \`${AGIM_BGJOBS_DIR_EXPR}\` |
${AGIM_IM_OPS_END}`
}

function appendSeparator(raw: string): string {
  if (raw.length === 0) return ''
  if (raw.endsWith('\n\n')) return ''
  if (raw.endsWith('\n')) return '\n'
  return '\n\n'
}

function normalizeRoleText(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
}

function countChangedLines(before: string, after: string): number {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = Math.max(a.length, b.length)
  let changed = 0
  for (let i = 0; i < n; i++) {
    if ((a[i] ?? '') !== (b[i] ?? '')) changed++
  }
  return changed
}

export type ImOpsUpsertPlan =
  | { kind: 'skip-refresh-disabled' }
  | { kind: 'skip-frozen' }
  | { kind: 'skip-unchanged' }
  | { kind: 'append'; next: string }
  | { kind: 'patch'; next: string; changedLines: number; beforeBlock: string; afterBlock: string }

/**
 * Pure planner for managed im-ops upsert. Never rewrites the whole file —
 * only appends a missing block, or patches the marked section when the
 * desired block actually differs (diff-gated).
 */
export function planImOpsUpsert(raw: string, block: string): ImOpsUpsertPlan {
  const refresh = (process.env.AGIM_IM_OPS_REFRESH || '').trim().toLowerCase()
  if (refresh === 'off' || refresh === '0' || refresh === 'false' || refresh === 'no') {
    return { kind: 'skip-refresh-disabled' }
  }
  if (raw.includes(AGIM_IM_OPS_FREEZE)) return { kind: 'skip-frozen' }

  const start = raw.indexOf(AGIM_IM_OPS_START)
  const end = raw.indexOf(AGIM_IM_OPS_END)
  if (start >= 0 && end > start) {
    const afterEnd = end + AGIM_IM_OPS_END.length
    const beforeBlock = raw.slice(start, afterEnd)
    // Diff gate: identical managed content → no write (version bumps must
    // not touch an already-correct AGENTS.md).
    if (normalizeRoleText(beforeBlock) === normalizeRoleText(block)) {
      return { kind: 'skip-unchanged' }
    }
    const next = `${raw.slice(0, start)}${block}${raw.slice(afterEnd)}`
    if (normalizeRoleText(next) === normalizeRoleText(raw)) {
      return { kind: 'skip-unchanged' }
    }
    return {
      kind: 'patch',
      next,
      changedLines: countChangedLines(beforeBlock, block),
      beforeBlock,
      afterBlock: block,
    }
  }

  return { kind: 'append', next: `${raw}${appendSeparator(raw)}${block}\n` }
}

/**
 * Upsert the managed IM / bgjob SOP into an agent's role file
 * (AGENTS.md / CLAUDE.md). Applies to **all** IM agent workspaces.
 *
 * Safety rules (upgrade / version bump):
 *   - Never overwrite the entire role file.
 *   - Content outside `<!-- agim:im-ops:* -->` is always preserved.
 *   - Existing managed block is replaced only when a content diff exists.
 *   - Freeze marker / AGIM_IM_OPS_REFRESH=off skips refresh entirely.
 */
export async function ensureAgimImOpsGuide(
  agentName: string,
  filename = roleFileForAgent(agentName),
  opts?: AgentWorkspaceDirOpts,
): Promise<string | null> {
  const explicit = process.env[envKeyFor(agentName)]
  const dir = opts?.dir ?? explicit ?? defaultAgentCwd(agentName)
  const guidePath = join(dir, filename)
  const block = buildAgimImOpsBlock(agentName, { workspaceRoot: opts?.workspaceRoot })

  let raw = ''
  try {
    raw = await readFile(guidePath, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return null
    throw err
  }

  const plan = planImOpsUpsert(raw, block)
  if (plan.kind === 'skip-refresh-disabled' || plan.kind === 'skip-frozen' || plan.kind === 'skip-unchanged') {
    return guidePath
  }

  if (plan.kind === 'patch') {
    const { logger } = await import('./logger.js')
    logger.info({
      component: 'agent-cwd',
      event: 'agent.guide.im_ops_patched',
      agent: agentName,
      file: guidePath,
      changedLines: plan.changedLines,
    }, 'im-ops managed block updated after diff (persona outside markers preserved)')
    await writeFile(guidePath, plan.next, 'utf8')
    return guidePath
  }

  await writeFile(guidePath, plan.next, 'utf8')
  return guidePath
}

/**
 * Migration hook for the Web-created MEMORY.md file. We preserve the user's
 * CLAUDE.md / AGENTS.md content and append one managed block that teaches
 * external CLI agents to read MEMORY.md from their pinned Agim workspace.
 */
export async function ensureAgentMemoryLink(
  agentName: string,
  filename = roleFileForAgent(agentName),
  opts?: AgentWorkspaceDirOpts,
): Promise<string | null> {
  const explicit = process.env[envKeyFor(agentName)]
  const dir = opts?.dir ?? explicit ?? defaultAgentCwd(agentName)
  const guidePath = join(dir, filename)

  let raw = ''
  try {
    raw = await readFile(guidePath, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return null
    throw err
  }
  if (raw.includes(AGIM_MEMORY_LINK_START)) return guidePath

  await appendFile(guidePath, `${appendSeparator(raw)}${AGIM_MEMORY_LINK_BLOCK}\n`, 'utf8')
  return guidePath
}

/**
 * Resolve the cwd to spawn an agent CLI in.
 *
 * Decision order:
 *   1. Env override `AGIM_<AGENT>_CWD` always wins.
 *   2. Explicit Portal / web `opts.workspacePath` (resolved directory).
 *   3. If we're in an IM context (threadId + platform both present), pin to
 *      `~/.agim-workspaces/<agent>/`.
 *   4. Otherwise return undefined → adapter inherits agim's cwd. This
 *      keeps scheduler/intent-llm judge paths exactly as they were.
 */
export function resolveAgentCwd(agentName: string, opts: AgentSendOpts): string | undefined {
  const explicit = process.env[envKeyFor(agentName)]
  if (explicit) return explicit

  const portal = typeof opts.workspacePath === 'string' ? opts.workspacePath.trim() : ''
  if (portal) return portal

  if (opts.threadId && opts.platform) {
    const accountUserId = currentAccountUserId()
    if (isAccountWorkspaceUserId(accountUserId)) {
      const dir = agentCwdForAccount(agentName, accountUserId)
      try { mkdirSync(dir, { recursive: true }) } catch { /* spawn still gets the path */ }
      return dir
    }
    return defaultAgentCwd(agentName)
  }

  return undefined
}

/**
 * Idempotent: create the workspace dir and seed initial CLAUDE.md / AGENTS.md
 * if they don't exist.
 *
 * **Existing files are NEVER overwritten** — not on version bump, not when
 * the packaged seed template changes. Operators may freely edit persona /
 * rules; only the marked im-ops block is eligible for diff-gated refresh
 * via `ensureAgimImOpsGuide`.
 *
 * Honors AGIM_<AGENT>_CWD overrides — if set, we bootstrap THAT path
 * instead. Skips bootstrapping when the override is empty / unset and we
 * compute it from defaultAgentCwd; either way the resolved path is what
 * spawnStream will pass as cwd.
 */
export async function ensureAgentWorkspace(
  agentName: string,
  seed: { filename: string; content: string },
  opts?: AgentWorkspaceDirOpts,
): Promise<string> {
  const explicit = process.env[envKeyFor(agentName)]
  const dir = opts?.dir ?? explicit ?? defaultAgentCwd(agentName)
  await mkdir(dir, { recursive: true })

  const seedPath = join(dir, seed.filename)
  let existingContent: string | null = null
  try {
    await access(seedPath)
    // already exists — leave the user's customizations alone but read
    // to scan for injection signals (R13 B2). Never rewrite with seed.
    try {
      const { readFile } = await import('node:fs/promises')
      existingContent = await readFile(seedPath, 'utf8')
    } catch { /* not fatal — skip the scan */ }
  } catch {
    await writeFile(seedPath, seed.content, 'utf8')
  }

  // R13 B2 — scan AGENTS.md / CLAUDE.md content for the most obvious
  // prompt-injection signatures and audit-log any hits. We don't
  // block the agent from starting (operator's own edits can hit
  // false positives) but we surface the warning so post-incident
  // forensics can correlate "agent did something weird" with
  // "operator-edited guide contained 'always allow'".
  if (existingContent !== null) {
    try {
      const { scanForInjectionAttempts } = await import('./prompt-injection-guard.js')
      const scan = scanForInjectionAttempts(existingContent)
      if (scan.suspicious) {
        const { logger } = await import('./logger.js')
        logger.warn({
          component: 'agent-cwd',
          event: 'agent.guide.injection_signals',
          agent: agentName,
          file: seedPath,
          matched: scan.matched,
        }, `${seed.filename} contains prompt-injection-style language; review the file`)
        try {
          const { logAuditEvent } = await import('./audit-log.js')
          logAuditEvent({
            eventType: 'config.put',
            actor: 'system',
            target: seedPath,
            outcome: 'ok',
            details: { reason: 'agent_guide_injection_signals', matched: scan.matched },
          })
        } catch { /* best-effort */ }
      }
    } catch { /* best-effort scan */ }
  }

  return dir
}

/**
 * Bootstrap the workspaces for the built-in agents we ship by default.
 * Safe to call multiple times. Returns a summary suitable for logging.
 */
export async function bootstrapAgentWorkspaces(): Promise<Array<{ agent: string; dir: string }>> {
  const { BOOTSTRAP_AGENT_IDS, roleSeedForAgent } = await import('./agent-workspace-seeds.js')
  const result: Array<{ agent: string; dir: string }> = []

  async function seedAgentWorkspace(
    agent: string,
    seed: { filename: string; content: string },
  ): Promise<string> {
    const dir = await ensureAgentWorkspace(agent, seed)
    await ensureAgentMemoryLink(agent, seed.filename)
    await ensureAgimImOpsGuide(agent, seed.filename)
    return dir
  }

  for (const agent of BOOTSTRAP_AGENT_IDS) {
    const filename = roleFileForAgent(agent)
    const seed = roleSeedForAgent(agent, {
      fileLocation: `${defaultAgentCwd(agent)}/${filename}`,
      workspaceRoot: `~/.agim-workspaces/${agent}`,
    })
    result.push({ agent, dir: await seedAgentWorkspace(agent, seed) })
  }

  return result
}
