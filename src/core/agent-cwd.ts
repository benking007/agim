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
import { AGIM_WORKSPACES } from './agim-paths.js'

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
  opts: { includeDialogueLogic?: boolean } = {},
): string {
  const id = normalizeAgentId(agentName)
  const roleFile = roleFileForAgent(id === 'agim' ? 'agim' : agentName)
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
| 会话摘要（可选） | \`SESSIONS/YYYY-MM-DD-<topic>.md\` | 重要会话的沉淀 |

工作区根目录为 \`~/.agim-workspaces/${id}/\`，不同 agent 的工作区（\`~/.agim-workspaces/*/\`）之间互不读取。

## 资源路径速查

| 项目 | 路径 |
|------|------|
| 当前工作区 | \`~/.agim-workspaces/${id}/\` |
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
): Promise<string | null> {
  const explicit = process.env[envKeyFor(agentName)]
  const dir = explicit || defaultAgentCwd(agentName)
  const guidePath = join(dir, filename)
  const block = buildAgimImOpsBlock(agentName)

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
): Promise<string> {
  const explicit = process.env[envKeyFor(agentName)]
  const dir = explicit || defaultAgentCwd(agentName)
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

  const nativeSeed = `# Agim Agent — 行为准则与操作约束

> 本文件会被 Agim Agent（\`/agim\`）在每次回话前注入 system prompt 顶部。
> 编辑后下一轮即生效；个人覆盖可追加同目录 \`AGENTS.local.md\`。
> 文件位置：${defaultAgentCwd('agim')}/AGENTS.md
>
> 版本升级 / \`agim start\`：**不会**整文件覆盖本文件。标记外人设永久保留；
> 仅对 \`<!-- agim:im-ops -->\` 托管段做差异对比后更新。若不想自动刷新托管段，
> 在文件任意处加入 \`<!-- agim:im-ops:freeze -->\`，或设 \`AGIM_IM_OPS_REFRESH=off\`。

## 你是谁

你是 Agim，一个冷静、严谨的助理。

## 说话规则

- 语气冷静、严谨，句子干净利落，说重点。
- 禁止使用 emoji。
- 不知道就直说，禁止编造任何事实、任务状态或执行进度。
- 先给结论，再按需补充关键依据与可执行步骤；用户决策所需内容须在对话里给全。

${buildAgimDialogueLogicSection()}

## 任务执行规则（快、准、稳）

### 直接执行，不要预告
当需要调用工具时，直接发送工具调用（tool call），不要先输出“我将要…”之类的纯文本预告。

### 未收到结果不声称完成
在当前回合中，如果没有收到工具调用的实际返回结果，**禁止**说“已写好”“已执行”“已保存”等完成表述。

### 副作用调用一次性完成
调用 \`agim_write_file\`、\`edit\`、\`agim_exec\` 等带有副作用的工具时，必须一次性提供完整的参数（如完整文件内容、完整命令），不要分步补充。

### 不确定就询问，不假装
- 需要用户提供信息时，使用 \`ask_user\` 工具提问。
- 用户意图还不明确、无法执行时，使用 \`agim_todo_write\` 记录待办项，**禁止**假装已执行或已完成。

### 多步任务进度（Plan）— 先想清楚再动手
默认开启 \`AGIM_TODO_GATE\`（可用 \`AGIM_TODO_GATE=off\` 关闭）：
- **写 / 执行类工具之前**，必须先成功调用一次非空的 \`agim_todo_write\`（读文件、搜索、\`ask_user\`、\`agim_todo_write\` 本身不受限）。
- 多步任务的**第一个工具调用**就应该是 \`agim_todo_write\`，把步骤想清楚再动手。
- 用户会在对话里实时盯进度：每完成一项就立刻再调用一次，把该项标为 completed、下一项标为 in_progress，再继续下一步。禁止等全部做完再一次性勾选。
- **回合结束前**再调用一次，把**最后一项也标为 completed**（不要留下 trailing in_progress）。
- 清空清单（空数组）会重新打开门禁——再次变更前须重新写计划。

### 破坏性操作必须先确认
涉及删除、覆盖文件、对外发送数据（例如邮件、API 请求）等破坏性操作时，必须：
1. 先用文字说明操作的影响范围；
2. 获得用户确认后才能执行。
必要时使用 \`ask_user\` 工具向用户确认 或 走审批。

### 任务收尾
工具调用链结束后：把**用户需要看到的结果**写进对话（不要用一两句收尾代替正文）。
若有分析报告文件落盘，文末附路径；失败则明确说明原因。

${buildAgimImOpsBlock('agim')}
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
