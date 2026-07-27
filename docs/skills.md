# agim skills engine

Drop a `SKILL.md` into `~/.agim/skills/<name>/` and every CLI agent
(Claude Code / Codex / OpenCode) plus **Agim Agent** (`agim`, alias `native`) can use it.

## What a skill is

A skill is a directory containing exactly one `SKILL.md` file. The
file's YAML frontmatter declares:

```yaml
---
name: my-skill
description: One-line summary the LLM uses to decide whether to load this skill.
always: false                                # optional; default false
metadata: '{"agim":{"requires":{"bins":["jq"],"env":["DATA_DIR"]}}}'
---
```

Then the markdown body — read on-demand by the agent — describes what
to do, with optional `scripts/`, `references/`, and `assets/`
subdirectories the body can reference.

## Three-tier progressive disclosure

Modelled on nanobot's design, but agim-owned. The token budget grows
only when the agent actually needs the skill:

| tier | what is loaded | when | cost |
|---|---|---|---|
| **1** | name + description per skill | every turn (auto-injected into system prompt) | ~30–50 tokens per skill |
| **2** | full SKILL.md body | on-demand via `mcp__agim__read_skill('name')` | one body per request |
| **3** | files in `scripts/`, `references/`, `assets/` | on-demand via the agent's normal file-read tool, when the body references them | per-file |

Compared to bundling every skill body into the system prompt, this
keeps even a 20-skill install affordable: only the skills the user's
current request matches pay tier-2 cost.

## Discovery scope

agim scans two directories on boot (cached for 5 min; `/skill refresh`
to force a re-scan):

```
~/.agim/skills/<name>/SKILL.md          # operator-owned, highest priority
<agim-dist>/skills/builtin/<name>/SKILL.md   # bundled with agim
```

**Workspace shadowing**: a workspace skill with the same `name` as a
built-in replaces the built-in entirely. Lets operators customise a
shipped skill without forking the install tree.

The loader does NOT scan per-agent workspaces (e.g.
`~/.agim-workspaces/<agent>/skills/`). Those are managed by the CLI
agent itself; this loader exclusively populates agim's shared
injection so every agent sees the same skill set.

Override discovery paths for tests / custom deployments:

| env var | purpose |
|---|---|
| `AGIM_SKILLS_WORKSPACE_DIR` | absolute path; replaces `~/.agim/skills` |
| `AGIM_SKILLS_BUILTIN_DIR` | absolute path; replaces bundled dir |

## SKILL.md frontmatter reference

| key | type | meaning |
|---|---|---|
| `name` | string | Stable identifier. Used in `read_skill('name')` and `/skill show <name>`. Required. |
| `description` | string | One-line summary the LLM reads to decide whether to fetch the body. Required. Capped at 400 chars. |
| `always` | bool | When `true`, the body is INLINED in tier-1 (every prompt sees it). Use sparingly — every always-on skill burns tokens on every turn. Default `false`. |
| `metadata` | JSON string | Currently used for `metadata.agim.requires.{bins,env}`. The legacy nanobot key `metadata.openclaw.requires` is also accepted for skills written for nanobot. |

The parser is intentionally minimal (regex-only) and tolerant — fancy
YAML features fall back to "ignore that field" rather than crashing
the loader.

## requires checking

```yaml
metadata: '{"agim":{"requires":{"bins":["jq","gh"],"env":["GITHUB_TOKEN"]}}}'
```

- `bins`: every listed binary must be on PATH (synchronous PATH probe;
  follows `PATHEXT` on Windows).
- `env`: every listed env var must be non-empty.

If any check fails, the skill stays in the roster but is flagged
`unavailable` with a one-line reason ("missing bin `jq`", "missing env
`GITHUB_TOKEN`"). It still gets injected into tier-1 — that way the
agent can tell the user "the X skill is available but needs `jq`
installed, please run `brew install jq`" instead of silently
pretending it doesn't exist.

## Slash command

```
/skill                 list (same as /skill list)
/skill help
/skill list            roster with status flags
/skill show <name>     full SKILL.md body
/skill refresh         force a disk re-scan
/skill check           list with requires detail
```

Aliases: `/skills`, `/技能`.

Status flags:

- ✅ available
- ⭐ available + `always:true`
- ⏸ unavailable (with reason)

## MCP tools on the CLI sidecar

Sticky CLI parents share the Agim MCP sidecar (PI uses its extension).
Besides skills, the sidecar exposes Subagent dispatch:

| Tool | Purpose |
|------|---------|
| `mcp__agim__call_agent` | Spawn one nested worker; parent keeps the user reply |
| `mcp__agim__call_agents` | Fan-out / join multiple workers (`tasks[]`) |

**Loop Engineering stays Agim-only** — `loop_verdict` / Focus tools are
**not** on the sidecar. Full contract:
[`architecture/cli-subagent-dispatch.md`](./architecture/cli-subagent-dispatch.md).

### `mcp__agim__read_skill`

```ts
mcp__agim__read_skill({
  op?: 'read' | 'list' | 'refresh',   // default 'read'
  name?: string,                       // required for 'read'
})
```

Results:

- `read`: `{ op:'read', name, body, available, unavailableReason? }`
- `list`: `{ op:'list', skills: [{name, description, source, available, always}] }`
- `refresh`: `{ op:'refresh', total }`

Agents are steered (via the tool description) to call `read` only when
the user's request matches a skill description from their system
prompt's `[agim skills available …]` block — i.e. tier-2 fetch is
intentional, not exploratory.

## Tier-1 injection format

The router prepends this block (alongside persona / reminder context)
before sending the user's prompt to the agent:

```
[agim skills available — read full body with mcp__agim__read_skill(name)]
- agim-self: Reference card for agim's built-in slash commands and MCP tools.
- repo-ops: GitHub repo housekeeping helpers (unavailable: missing bin `gh`)
- ship-version: One-skill workflow for cutting an npm release [always]

### Always-on skill: ship-version
…full body inlined here…
```

The wrapper text matches nanobot's pattern so models trained on its
docs feel at home. Bounded to 32 injected skills. Fill order is
bucket-aware (`agim-*` → non-ECC builtin → workspace → ECC top-picks →
ECC remainder clusters), not pure alphabetical — see
`rankSkillBucket` in `src/core/skills/loader.ts`.

## Storage / packaging

- Built-in skills live under `src/core/skills/builtin/<name>/SKILL.md`
  in the agim source tree.
- `npm run build` copies `src/core/skills/builtin` to
  `dist/core/skills/builtin` so npm-installed agim retains the bundled
  set.
- Workspace skills are not packaged — operators drop them into
  `~/.agim/skills/` after install.

## Bundled pack (curated)

The install ships **38** builtins:

| Bucket | Count | Examples |
|---|---|---|
| **Agim-native** | 12 | `agim-self`, `agim-memory`, `skill-creator`, `github`, `tmux`, `weather`, … |
| **ECC curated** | 26 | harness / methodology / product / security (see below) |

Attribution for the ECC subset: `src/core/skills/builtin/ECC_NOTICE.md`
(+ `ECC_LICENSE`). Disable the whole ECC pack with:

```
AGIM_INCLUDE_ECC_SKILLS=off
```

### ECC curated 26 (= default `ECC_TOP_PICKS`)

These names are both the installed ECC directories and the system-prompt
injection top-picks (`ECC_TOP_PICKS_DEFAULT` in `src/core/skills/loader.ts`).
Override with `AGIM_SKILLS_ECC_PICKS=name1,name2,...`.

**Harness / loops / eval**

- `agent-eval` — 编码 Agent 横向对比（通过率 / 成本 / 时间）
- `agent-harness-construction` — Agent 动作空间与工具定义优化
- `agent-introspection-debugging` — Agent 失败的结构化自检与恢复
- `agentic-engineering` — 评估驱动开发与成本感知路由
- `autonomous-agent-harness` — 全自主 Agent 系统（持久记忆 / 定时任务）
- `autonomous-loops` — 自主循环架构（顺序管道至多 Agent DAG）
- `continuous-learning-v2` — 基于钩子的本能学习与技能演化
- `verification-loop` — 会话综合验证系统
- `prompt-optimizer` — 分析意图并输出优化后的提示词
- `cost-aware-llm-pipeline` — API 成本优化（模型路由 / 缓存 / 重试）
- `context-budget` — 上下文窗口占用审计与优化建议
- `team-agent-orchestration` — 多 AI 代理团队编排

**Methodology / product / content**

- `architecture-decision-records` — 架构决策记录（ADR）捕获
- `article-writing` — 长文 / 博客 / 教程 / 通讯写作
- `benchmark` — 性能基线测量与回归检测
- `blueprint` — 多会话多 Agent 工程项目分步蓝图
- `code-tour` — 生成 CodeTour 分步代码导览
- `coding-standards` — 跨项目编码规范
- `tdd-workflow` — TDD 工作流
- `api-design` — REST API 设计规范（命名 / 状态码 / 分页 / 限流）
- `backend-patterns` — 后端架构与服务端最佳实践
- `product-capability` — 产品功能范围与核心竞争力定义
- `product-lens` — 多维产品分析透镜（技术 / 用户 / 商业）
- `regex-vs-llm-structured-text` — 正则与 LLM 处理结构化文本对比

**Security**

- `security-scan` — 扫描 Claude Code 配置（CLAUDE.md / settings / MCP / hooks）找安全风险
- `security-bounty-hunter` — 猎取可远程利用、适合赏金提交的高价值漏洞

Framework / language / industry specialty ECC packs (django, kotlin,
healthcare, media, Claude-Code ops tooling, …) were pruned from the
default install. Re-add equivalents under `~/.agim/skills/` if needed.

## What's NOT in Stage 3

- **Web UI list / editor**: planned for Stage 4 (`/web/skills` page).
- **Per-thread skill subscriptions**: every thread sees the global
  roster today. Future: `/skill enable <name>` / `/skill disable
  <name>` per thread.
- **Marketplace / fetch from URL**: install a curated remote SKILL by
  name. Future P2 item.
- **Hot-reload on file write**: 5-min cache TTL + `/skill refresh`. A
  filesystem watcher could narrow this gap.

## Failure modes

| symptom | cause | fix |
|---|---|---|
| Skill not showing up in `/skill list` | missing or malformed frontmatter | check for the opening `---` and `description: <text>` line; tail `~/.agim/logs/*.log` for `skills.parse.no_frontmatter` / `no_description` |
| Skill shows as ⏸ unavailable | required bin / env missing | install the bin or set the env; `/skill refresh` |
| Agent ignores the skill | description is too vague — model didn't match user intent | rewrite the description so the LLM can pattern-match user requests |
| Always-on skill body missing from prompt | body file unreadable | check file permissions; loader warns `skills.body_read_failed` |
