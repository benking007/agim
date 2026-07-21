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
import { mkdir, writeFile, access, readFile, appendFile } from 'node:fs/promises'
import type { AgentSendOpts } from './types.js'
import { AGIM_HOME, AGIM_WORKSPACES } from './agim-paths.js'
import { agimBgjobScript, agimBgjobsDir } from './bgjob-install.js'

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

/** Managed IM / bgjob SOP block for the default Agim Agent AGENTS.md.
 *  Upserted on every bootstrap so existing installs pick up revisions
 *  without wiping operator persona edits outside the markers. */
export const AGIM_IM_OPS_START = '<!-- agim:im-ops:start -->'
export const AGIM_IM_OPS_END = '<!-- agim:im-ops:end -->'

export function buildAgimImOpsBlock(): string {
  return `${AGIM_IM_OPS_START}
## IM 回复硬规范

回复对象是聊天界面（微信 / 飞书 / Telegram / Discord / Web Portal），不是终端。

| 维度 | 规范 |
|---|---|
| 默认体裁 | 短 paragraph + 简短 bulleted list；**禁 markdown 表格**（多数 IM 不渲染会变成纯文本墙）|
| 标题 | 单回复内最多用 1 级 \`##\`，**避免 H1** |
| 代码块 | ≤10 行或 ≤300 字符可内联；**更长写文件并给路径**，不要把长代码塞进 IM |
| 链接 | 直接贴纯 URL（\`https://x.com/path\`），**不用** \`[text](url)\` |
| Emoji | 默认禁用；除非用户明确要求 |
| 长输出 | 超过 ~50 行的列表/数据：摘要要点 + 落盘文件给路径 |
| 错误反馈 | 一句话核心错因，附"需要详情吗？"；不主动贴 stack trace |
| 多步进度 | 关键节点更新一次（找到了 / 改了什么 / 卡在哪），不每步都报 |

## 任务超时与 bgjob 切换

**单消息硬超时约 30 分钟**（agim IM / Web 桥接层）。超时后中间状态可能不可回收。
遇到任务先估时，再选路径：

| 估时 | 路径 |
|---|---|
| < 5 分钟 | 同步直接做 |
| 5–10 分钟 | 同步做，但**每 1–2 分钟落盘一次中间产物**（写文件），保证崩溃前有产物 |
| **> 10 分钟** | **强制 bgjob**（见下方启动方式）|
| 不可估 | 先跑 3–5 分钟试探小样本，看吞吐外推后再选路径 |

**任何**预估 >10 分钟的任务：先把 plan + 估时摆给用户确认，**不擅自开干**。

### 如何启动 bgjob

用 \`agim_exec\` 调用**绝对路径** wrapper（\`agim start\` 会安装到 \`${agimBgjobScript()}\`；bare \`bgjob\` 不行；也不要用 \`nohup … &\`——会随父 shell 一起死）：

\`\`\`text
${agimBgjobScript()} start <slug> -- <cmd...>
\`\`\`

跟进：

\`\`\`text
${agimBgjobScript()} status <slug>
${agimBgjobScript()} tail <slug>
${agimBgjobScript()} list --running
\`\`\`

数据目录：\`${agimBgjobsDir()}\`（**各 agent 共用**；Web 控制台 Tasks → Background + Portal 小精灵「进行中」可跟踪）。
脚本本身先用 \`agim_write_file\` 写好再 \`bgjob start\`；启动成功后立刻把完整 job id + 日志路径回给用户，然后结束本轮同步回合。任务退出后 Agim 会自动往原对话推送结果（可选 \`AGIM_BGJOB_AUTOSUMMARY=on\` 附日志摘要）。

\`long_task\` / \`/goal\` 是跨回合目标跟踪，**不是**后台进程；长跑批处理 / 训练 / 大批量抓取请用 bgjob。

## 长期记忆与项目档案

| 类型 | 位置 | 何时用 |
|---|---|---|
| 工作区记忆 | 本目录 \`MEMORY.md\` | 跨会话沉淀的偏好 / 事实（框架会注入） |
| 项目档案 | 本目录 \`PROJECTS/<slug>.md\` | 单个长期主题的状态档（目标 / 进度 / 关键决定 / 待办） |
| session 摘要（可选） | 本目录 \`SESSIONS/YYYY-MM-DD-<topic>.md\` | 重要会话沉淀 |

与其他 agent 工作区（\`~/.agim-workspaces/claude-code/\` 等）互不读取。

## IM 通道已知限制

- 无交互式 stdin：用户下一条消息是新一轮，不能在同一回合里"等输入"
- 消息多为单次返回；超长内容拆条或落盘
- 无 GUI / 图表查看：要给图就写到路径让用户自取，或走邮件类 skill
- markdown 兼容差：表格 / 复杂引用 / HTML 可能乱排；部分客户端单消息 4–8 KB 截断

## 资源路径速查

| 项 | 路径 |
|---|---|
| 本工作区 | \`~/.agim-workspaces/agim/\` |
| 角色书 | 本目录 \`AGENTS.md\`（可另加 \`AGENTS.local.md\` 覆盖） |
| Agim 状态目录 | \`${AGIM_HOME}\` |
| bgjob wrapper | \`${agimBgjobScript()}\` |
| bgjob 数据 | \`${agimBgjobsDir()}\` |
| 真正的代码仓库 | \`/root/workspace/...\`（**当前 cwd 不是代码仓库**）|
${AGIM_IM_OPS_END}`
}

function appendSeparator(raw: string): string {
  if (raw.length === 0) return ''
  if (raw.endsWith('\n\n')) return ''
  if (raw.endsWith('\n')) return '\n'
  return '\n\n'
}

/**
 * Upsert the managed IM / bgjob SOP into Agim Agent's AGENTS.md.
 * Replaces an existing marked block in place; otherwise appends.
 * No-op for other agents.
 */
export async function ensureAgimImOpsGuide(
  agentName: string,
  filename = roleFileForAgent(agentName),
): Promise<string | null> {
  const id = (agentName === 'native' || agentName === 'agim') ? 'agim' : agentName
  if (id !== 'agim') return null

  const explicit = process.env[envKeyFor(agentName)]
  const dir = explicit || defaultAgentCwd(agentName)
  const guidePath = join(dir, filename)
  const block = buildAgimImOpsBlock()

  let raw = ''
  try {
    raw = await readFile(guidePath, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return null
    throw err
  }

  const start = raw.indexOf(AGIM_IM_OPS_START)
  const end = raw.indexOf(AGIM_IM_OPS_END)
  if (start >= 0 && end > start) {
    const afterEnd = end + AGIM_IM_OPS_END.length
    const next = `${raw.slice(0, start)}${block}${raw.slice(afterEnd)}`
    if (next !== raw) await writeFile(guidePath, next, 'utf8')
    return guidePath
  }

  await appendFile(guidePath, `${appendSeparator(raw)}${block}\n`, 'utf8')
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
): Promise<string | null> {
  const explicit = process.env[envKeyFor(agentName)]
  const dir = explicit || defaultAgentCwd(agentName)
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
 *   2. If we're in an IM context (threadId + platform both present), pin to
 *      `~/.agim-workspaces/<agent>/`.
 *   3. Otherwise return undefined → adapter inherits agim's cwd. This
 *      keeps web/scheduler/intent-llm judge paths exactly as they were.
 */
export function resolveAgentCwd(agentName: string, opts: AgentSendOpts): string | undefined {
  const explicit = process.env[envKeyFor(agentName)]
  if (explicit) return explicit

  if (opts.threadId && opts.platform) {
    return defaultAgentCwd(agentName)
  }

  return undefined
}

/**
 * Idempotent: create the workspace dir and seed initial CLAUDE.md / AGENTS.md
 * if they don't exist. Existing files are NEVER overwritten — the user is free
 * to evolve them by hand or have the agent itself rewrite them via
 * auto-memory.
 *
 * Honors AGIM_<AGENT>_CWD overrides — if set, we bootstrap THAT path
 * instead. Skips bootstrapping when the override is empty / unset and we
 * compute it from defaultAgentCwd; either way the resolved path is what
 * spawnStream will pass as cwd.
 */
export async function ensureAgentWorkspace(
  agentName: string,
  seed: { filename: string; content: string },
): Promise<string> {
  const explicit = process.env[envKeyFor(agentName)]
  const dir = explicit || defaultAgentCwd(agentName)
  await mkdir(dir, { recursive: true })

  const seedPath = join(dir, seed.filename)
  let existingContent: string | null = null
  try {
    await access(seedPath)
    // already exists — leave the user's customizations alone but read
    // to scan for injection signals (R13 B2).
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

  const claudeSeed = `# Claude Code — IM 入口工作区

> 这是 agim 通过 IM 唤起 Claude Code 时的专用工作目录。
> 与你直接在终端里跑 \`claude\` 时使用的全局配置 (~/.claude/CLAUDE.md) 隔离。
>
> 文件位置：${defaultAgentCwd('claude-code')}/CLAUDE.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 Claude Code。
回复要简洁、可在 IM 里阅读，避免大段代码块除非用户明确要求代码。

## 长期项目记忆

- 你自己的 auto-memory 落在本目录的 \`memory/MEMORY.md\`
- 长期项目档案手写在本目录下，由 Claude 自己读取与维护
- 与终端里的 Claude 互不干扰，可以分头记录不同侧重

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息的硬超时是 30 分钟（agim 层），长任务必须走 bgjob
`

  result.push({
    agent: 'claude-code',
    dir: await seedAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: claudeSeed }),
  })

  const opencodeSeed = `# OpenCode — IM 入口工作区

> 这是 agim 通过 IM 唤起 opencode 时的专用工作目录。
> 与你直接在终端里跑 \`opencode\` 时使用的全局配置 (~/.config/opencode/AGENTS.md) 隔离。
>
> 文件位置：${defaultAgentCwd('opencode')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 opencode。
回复要简洁、可在 IM 里阅读，避免大段代码块除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下的 PROJECT.md，由 opencode 自己读取与维护
- 与终端里的 opencode 互不干扰，可以分头记录不同侧重

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息的硬超时是 30 分钟（agim 层），长任务必须走 bgjob
`

  result.push({
    agent: 'opencode',
    dir: await seedAgentWorkspace('opencode', { filename: 'AGENTS.md', content: opencodeSeed }),
  })

  const codexSeed = `# Codex — IM 入口工作区

> 这是 agim 通过 IM 唤起 OpenAI Codex CLI 时的专用工作目录。
> 与你直接在终端里跑 \`codex\` 时使用的全局配置 (~/.codex/config.toml) 隔离。
>
> 文件位置：${defaultAgentCwd('codex')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 Codex。
回复要简洁、可在 IM 里阅读，避免大段代码块除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode 工作区互不干扰
- 与终端里的 codex 互不干扰，可以分头记录不同侧重

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息的硬超时是 30 分钟（agim 层），长任务必须走 bgjob
- bgjob：\`~/.agim/scripts/bgjob start <name> -- <cmd...>\`（\`agim start\` 安装；数据 \`~/.agim/bgjobs/\`）
- AGENTS.md 与 opencode 同名但工作区分离 —— codex 只读本目录的 AGENTS.md，
  不会读 ~/.agim-workspaces/opencode/AGENTS.md
`

  result.push({
    agent: 'codex',
    dir: await seedAgentWorkspace('codex', { filename: 'AGENTS.md', content: codexSeed }),
  })

  const antigravitySeed = `# Antigravity — IM 入口工作区

> 这是 agim 通过 IM 唤起 Google Antigravity (agy) 时的专用工作目录。
> 与你直接在终端里跑 \`agy\` 时使用的 \`~/.gemini/antigravity-cli/\` 隔离。
>
> 文件位置：${defaultAgentCwd('antigravity')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 Antigravity。
回复要简洁、可在 IM 里阅读，避免大段代码块除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode / codex 工作区互不干扰
- agy 自己的 conversation 历史落在 ~/.gemini/antigravity-cli/conversations/，由 agim 通过
  \`--conversation <uuid>\` 续接，无需手工管理

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息的硬超时是 30 分钟（agim 层），长任务必须走 bgjob
- agy 启动时 agim 自动通过 \`--add-dir <cwd>\` 把本目录加进可信工作区，
  无需在 ~/.gemini/antigravity-cli/settings.json 的 trustedWorkspaces 手填
`

  result.push({
    agent: 'antigravity',
    dir: await seedAgentWorkspace('antigravity', { filename: 'AGENTS.md', content: antigravitySeed }),
  })

  const kimiSeed = `# Kimi Code — IM 入口工作区

> 这是 agim 通过 IM 唤起 Kimi Code CLI (\`/kimi\` / \`/km\`) 时的专用工作目录。
> 与你直接在终端跑 \`kimi\` 时使用的全局配置 (\`~/.kimi-code/\`) 隔离。
>
> 文件位置：${defaultAgentCwd('kimi-code')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 Kimi Code。
回复发到 IM 聊天里，保持简洁；不要长 code block 除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode / codex / antigravity / cursor 工作区互不干扰
- kimi 自己的 session 历史由 ~/.kimi-code/session_index.jsonl 索引，agim 通过 \`--session <id>\` 续接，无需手工管理

## 工具与审批

- agim 会通过 \`~/.kimi-code/mcp.json\` 注入 \`mcp__agim__*\` 工具，包括 memory、memo、reminder、ask_user、call_agent、read_skill 等
- 需要执行命令或改文件时，优先使用 \`mcp__agim__agim_bash\` / \`mcp__agim__agim_write\` / \`mcp__agim__agim_edit\`，用户审批后才会真正执行

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息硬超时 30 分钟，长任务请走 bgjob
- Kimi Code 的 \`-p\` 非交互模式当前不能和 \`--plan\` 同用；agim 会提供独立 workspace 和审批版 \`mcp__agim__*\` 工具，但 Kimi 内置写文件 / shell 权限仍按 Kimi 自身权限规则处理
`

  result.push({
    agent: 'kimi-code',
    dir: await seedAgentWorkspace('kimi-code', { filename: 'AGENTS.md', content: kimiSeed }),
  })

  const qoderSeed = `# Qoder — IM 入口工作区

> 这是 agim 通过 IM 唤起 Qoder CLI (\`/qoder\` / \`/qd\`) 时的专用工作目录。
> 与你直接在终端跑 \`qodercli\` 时使用的全局配置 (\`~/.qoder/\`) 隔离。
>
> 文件位置：${defaultAgentCwd('qoder')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 Qoder。
回复发到 IM 聊天里，保持简洁；不要长 code block 除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode / codex / antigravity / cursor / kimi 工作区互不干扰
- qoder 自己的 session 历史由 Qoder CLI 管理；agim 会捕获 stream-json 里的 \`session_id\` 并用 \`--resume <id>\` 续接

## 工具与审批

- agim 会通过 \`--mcp-config\` 临时注入 \`mcp__agim__*\` 工具，包括 memory、memo、reminder、ask_user、call_agent、read_skill 等
- 这些工具会带着当前 IM thread 的 \`AGIM_RUN_ID\` 回到 agim approval bus
- Web / IM 是非交互入口；agim 会默认允许 Qoder 调用 WebSearch、WebFetch 与 \`mcp__agim__*\` 工具，避免因无法弹授权而卡住
- Qoder 内置 Bash / Edit / Write / NotebookEdit / Cron* 等变更型工具由 agim 禁用；需要执行命令或改文件时，使用 \`mcp__agim__agim_bash\` / \`mcp__agim__agim_write\` / \`mcp__agim__agim_edit\`，用户审批后才会真正执行
- 管理员可用 \`AGIM_QODER_PERMISSION_MODE\` 覆盖 Qoder 权限模式（default / accept_edits / bypass_permissions / dont_ask / auto）

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息硬超时 30 分钟，长任务请走 bgjob
- 计划模式下 agim 继续传递 planMode 给 A2A 子任务
`

  result.push({
    agent: 'qoder',
    dir: await seedAgentWorkspace('qoder', { filename: 'AGENTS.md', content: qoderSeed }),
  })

  const piSeed = `# PI — IM 入口工作区

> 这是 agim 通过 IM / Web 唤起 PI CLI (\`/pi\` / \`/pi-agent\`) 时的专用工作目录。
> 与你直接在终端跑 \`pi\` 时使用的项目上下文隔离。
>
> 文件位置：${defaultAgentCwd('pi')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）或 Web 控制台唤起的 PI。
回复会发回聊天窗口，保持简洁；不要长 code block 除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode / codex / antigravity / cursor / kimi / qoder 工作区互不干扰
- PI 自己的 session 存在本目录的 \`.pi-sessions/\` 下；agim 会捕获 JSON stream 的 \`session.id\` 并用 \`--session <id>\` 续接

## 工具与审批

- agim 会通过 PI extension 临时注入 \`mcp__agim__*\` 工具，包括 memory、memo、reminder、ask_user、call_agent、read_skill 等
- 这些工具会带着当前 IM thread 的 \`AGIM_RUN_ID\` 回到 agim approval bus，按当前用户与会话隔离
- Web / IM 默认启用 PI 的 read / grep / find / ls 以及 \`mcp__agim__*\` 工具
- PI 内置 bash / edit / write 不开放；需要执行命令或改文件时，使用 \`agim_bash\` / \`agim_write\` / \`agim_edit\`，用户审批后才会真正执行

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息硬超时 30 分钟，长任务请走 bgjob
- 计划模式下 agim 会保持 PI 只读工具集，并继续传递 planMode 给 A2A 子任务
`

  result.push({
    agent: 'pi',
    dir: await seedAgentWorkspace('pi', { filename: 'AGENTS.md', content: piSeed }),
  })

  const mimoSeed = `# MiMo Code — IM 入口工作区

> 这是 agim 通过 IM / Web 唤起 MiMo Code CLI (\`/mimo\` / \`/mo\`) 时的专用工作目录。
> 与你直接在终端跑 \`mimo\` 时使用的项目上下文隔离。
>
> 文件位置：${defaultAgentCwd('mimo')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）或 Web 控制台唤起的 MiMo Code。
回复会发回聊天窗口，保持简洁；不要长 code block 除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode / codex / antigravity / cursor / kimi / qoder / pi 工作区互不干扰
- MiMo 自己的 session 历史由 MiMo CLI 管理；agim 会捕获 JSON stream 里的 session id 并用 \`--session <id>\` 续接

## 工具与审批

- agim 会通过 \`MIMOCODE_CONFIG_CONTENT\` 临时注入 \`mcp__agim__*\` 工具，包括 memory、memo、reminder、ask_user、call_agent、read_skill 等
- 这些工具会带着当前 IM thread 的 \`AGIM_RUN_ID\` 回到 agim approval bus，按当前用户与会话隔离
- MiMo 自带的 websearch / webfetch 在 IM 场景默认允许，用于获取当前公开信息
- MiMo 原生 bash / edit / task / external_directory 由 agim 禁用；需要执行命令或改文件时，使用 \`mcp__agim__agim_bash\` / \`mcp__agim__agim_write\` / \`mcp__agim__agim_edit\`，用户审批后才会真正执行

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息硬超时 30 分钟，长任务请走 bgjob
- 模型切换使用 \`provider/model\`，例如 \`/model kimi/kimi-k2-0711-preview\`
`

  result.push({
    agent: 'mimo',
    dir: await seedAgentWorkspace('mimo', { filename: 'AGENTS.md', content: mimoSeed }),
  })

  const copilotSeed = `# GitHub Copilot CLI — IM 入口工作区

> 这是 agim 通过 IM / Web 唤起 GitHub Copilot CLI (\`/copilot\` / \`/co\`) 时的专用工作目录。
> 与你直接在终端跑 \`copilot\` 时使用的项目上下文隔离。
>
> 文件位置：${defaultAgentCwd('copilot')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）或 Web 控制台唤起的 GitHub Copilot CLI。
回复会发回聊天窗口，保持简洁；不要长 code block 除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode / codex / antigravity / cursor / kimi / qoder / pi / mimo 工作区互不干扰
- Copilot 自己的 session 由 agim 预分配 UUID，并用 \`--session-id <uuid>\` 续接

## 工具与审批

- agim 会通过 \`--additional-mcp-config\` 临时注入 \`mcp__agim__*\` 工具，包括 memory、memo、reminder、ask_user、call_agent、read_skill 等
- 这些工具会带着当前 IM thread 的 \`AGIM_RUN_ID\` 回到 agim approval bus，按当前用户与会话隔离
- Copilot 原生 shell / write / edit / delete / move 等 mutation 类工具会被 agim deny；需要执行命令或改文件时，使用 \`mcp__agim__agim_bash\` / \`mcp__agim__agim_write\` / \`mcp__agim__agim_edit\`，用户审批后才会真正执行

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息硬超时 30 分钟，长任务请走 bgjob
- 模型切换使用 GitHub Copilot CLI 支持的模型 id，例如 \`/model gpt-5-mini\`
`

  result.push({
    agent: 'copilot',
    dir: await seedAgentWorkspace('copilot', { filename: 'AGENTS.md', content: copilotSeed }),
  })

  const nativeSeed = `# Agim Agent — IM 入口工作区

> 这是 agim 自带的 in-process LLM agent（\`/agim\`，兼容 \`/na\` / \`/llm\`）的工作目录。
> 不同于 claude-code / opencode / codex，Agim Agent 没有外部 CLI 进程；它把
> 这里当作"自己的家"。
>
> 文件位置：${defaultAgentCwd('agim')}/AGENTS.md
>
> ⚠️ 本文件整体会被 Agim Agent 在**每次回话前作为 system prompt 顶部注入**。
> 编辑本文件可以直接改变身份 / 语气 / 行为边界 — 一改即生效，
> 无需重启服务。重定向到其它路径可设 \`AGIM_NATIVE_AGENT_ROLE_FILE=...\`。
> \`AGENTS.local.md\`（同目录）会追加在本文件之后，用于个人覆盖。

## 你是谁（角色定义）

你是 Agim，一个冷静严谨的助理，被 IM / Web 入口唤起。

> 想换个人设？把本节改成你想要的，例如：
> "你是月魁，一个老牌华尔街交易员 …"
> 改完无需重启，下一轮对话即生效。

## 你怎么说话（风格）

- 回复一律用中文短句，禁用 emoji
- 不知道就直说，不要编造

${buildAgimImOpsBlock()}

## 你怎么动手（工具与边界）

- 内置工具：\`agim_echo\` / \`agim_now\` / \`agim_sleep_ms\` / \`agim_random_uuid\`
- 文件系统：\`agim_read_file\` / \`agim_write_file\` / \`agim_list_dir\` / \`agim_glob\` / \`agim_grep\`
- Web：\`agim_web_fetch\` / \`agim_web_search\`
- Shell：\`agim_exec\`（始终审批门控；长任务用上方 bgjob SOP）
- agim MCP（\`mcp__agim__*\`）：技能、备忘录、push、ask_user、call_agent、long_task、complete_goal
- 运营方配置的外部 MCP server 工具（\`mcp_<server>_*\`）
- 涉及钱 / 交易 / 删除：先 dry-run 给用户看，得确认再执行

## 工作目录

- 本目录目前所有 IM 线程共享，未做 per-thread 隔离
- 想给某条线程独立 cwd，可设 \`AGIM_NATIVE_CWD=/some/path\` 覆盖
- 当前 cwd 不是代码仓库；要查代码请去 /root/workspace/...
`

  result.push({
    agent: 'agim',
    dir: await seedAgentWorkspace('agim', { filename: 'AGENTS.md', content: nativeSeed }),
  })

  const cursorSeed = `# Cursor — IM 入口工作区

> 这是 agim 通过 IM 唤起 Cursor CLI (\`/cs\`) 时的专用工作目录。
> 与你直接在终端跑 \`cursor-agent\` 时使用的全局配置 (\`~/.cursor/cli-config.json\`) 隔离。
>
> 文件位置：${defaultAgentCwd('cursor')}/AGENTS.md

## 角色

你是被 IM 入口（微信 / Telegram / Feishu / Discord 等）唤起的 Cursor。
回复发到 IM 聊天里，保持简洁；不要长 code block 除非用户明确要求代码。

## 长期项目记忆

- 长期项目档案手写在本目录下（PROJECT.md 或自定义文件名）
- 本目录下的 \`memory/\` 目录用于手写笔记，与 Claude / opencode / codex / antigravity 工作区互不干扰
- cursor 自己的 chat 历史落在 \`~/.cursor/chats/\`，由 agim 通过 \`--resume <session_id>\` 续接，无需手工管理

## 注意

- 当前 cwd 不是真正的代码仓库；要查代码请去 /root/workspace/...
- IM 单条消息硬超时 30 分钟，长任务请走 bgjob
- agim 用 \`--trust --force --approve-mcps\` 启动 cursor，所有 cursor 侧 tool 默认自动放行；agim 自己的 \`mcp__agim__*\` 仍走 approval-bus
`

  result.push({
    agent: 'cursor',
    dir: await seedAgentWorkspace('cursor', { filename: 'AGENTS.md', content: cursorSeed }),
  })

  return result
}
