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
import { mkdir, writeFile, access } from 'node:fs/promises'
import type { AgentSendOpts } from './types.js'
import { AGIM_WORKSPACES } from './agim-paths.js'

/** Root for all per-agent IM workspaces. Kept stable so memory persists.
 *  Honors the `AGIM_WORKSPACES_ROOT` env override; otherwise resolves via
 *  core/agim-paths. */
export function agimWorkspacesRoot(): string {
  return process.env.AGIM_WORKSPACES_ROOT || AGIM_WORKSPACES
}

/** Default cwd for a given agent under the workspaces root. */
export function defaultAgentCwd(agentName: string): string {
  return join(agimWorkspacesRoot(), agentName)
}

/** Env var name for an explicit override on a given agent. */
function envKeyFor(agentName: string): string {
  // claude-code -> AGIM_CLAUDE_CODE_CWD
  return `AGIM_${agentName.replace(/-/g, '_').toUpperCase()}_CWD`
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
 * Bootstrap the workspaces for the two built-in CLI agents we ship by
 * default. Safe to call multiple times. Returns a summary suitable for
 * logging.
 *
 * Other agents (codex, ACP-imported) don't need cwd isolation
 * either because they don't have per-cwd memory, or because they're
 * remote — they'll pass through with cwd undefined like before.
 */
export async function bootstrapAgentWorkspaces(): Promise<Array<{ agent: string; dir: string }>> {
  const result: Array<{ agent: string; dir: string }> = []

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
    dir: await ensureAgentWorkspace('claude-code', { filename: 'CLAUDE.md', content: claudeSeed }),
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
    dir: await ensureAgentWorkspace('opencode', { filename: 'AGENTS.md', content: opencodeSeed }),
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
- bgjob 数据目录：~/.codex/bgjobs/（与 claude / opencode 隔离）
  使用方式：\`/root/.codex/scripts/bgjob start <name> -- <cmd...>\`
- AGENTS.md 与 opencode 同名但工作区分离 —— codex 只读本目录的 AGENTS.md，
  不会读 ~/.agim-workspaces/opencode/AGENTS.md
`

  result.push({
    agent: 'codex',
    dir: await ensureAgentWorkspace('codex', { filename: 'AGENTS.md', content: codexSeed }),
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
    dir: await ensureAgentWorkspace('antigravity', { filename: 'AGENTS.md', content: antigravitySeed }),
  })

  const nativeSeed = `# agim native — 角色定义 + 工作区说明

> 这是 agim 自带的 in-process LLM agent（\`/agim\`，兼容 \`/na\` / \`/llm\`）的工作目录。
> 不同于 claude-code / opencode / codex，native 没有外部 CLI 进程；它把
> 这里当作"自己的家"。
>
> 文件位置：${defaultAgentCwd('native')}/AGENTS.md
>
> ⚠️ 本文件整体会被 native 在**每次回话前作为 system prompt 顶部注入**。
> 编辑本文件可以直接改变 native 的身份 / 语气 / 行为边界 — 一改即生效，
> 无需重启服务。重定向到其它路径可设 \`AGIM_NATIVE_AGENT_ROLE_FILE=...\`。

## 你是谁（角色定义）

你是 Agim，一个冷静严谨的助理。

> 想换个人设？把本节改成你想要的，例如：
> "你是月魁，一个老牌华尔街交易员 …"
> 改完无需重启，下一轮对话即生效。

## 你怎么说话（风格）

- 回复一律用中文短句，禁用 emoji
- 不知道就直说，不要编造

## 你怎么动手（工具与边界）

- 三个 native 内置工具：\`native_echo\` / \`native_now\` / \`native_random_uuid\`
- agim 自身的 MCP 工具（\`mcp__agim__*\`）：技能、备忘录、push、ask_user、call_agent
- 运营方配置的外部 MCP server 工具（\`mcp_<server>_*\`）
- 涉及钱 / 交易 / 删除：先 dry-run 给用户看，得确认再执行

## 工作目录

- 本目录目前所有 IM 线程共享，未做 per-thread 隔离
- 想给某条线程独立 cwd，可设 \`AGIM_NATIVE_CWD=/some/path\` 覆盖

## 注意

- IM 单条消息硬超时 30 分钟，长任务请走 bgjob 或 call_agent 拆分
- 当前 cwd 不是代码仓库；要查代码请去 /root/workspace/...
`

  result.push({
    agent: 'native',
    dir: await ensureAgentWorkspace('native', { filename: 'AGENTS.md', content: nativeSeed }),
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
    dir: await ensureAgentWorkspace('cursor', { filename: 'AGENTS.md', content: cursorSeed }),
  })

  return result
}
