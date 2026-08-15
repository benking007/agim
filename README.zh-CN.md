# Agim · 阿吉姆

[English](README.md)

Agim 是一个 **IM 到 AI Agent 的桥接系统**。
它强调“可用性与可运维性”：投递尽量不丢（at-least-once）、会话可续、审批可控、链路可观测。

## 项目重点

- **桥接优先**：微信 / 飞书 / 钉钉 / 邮件接入多类 Agent。Telegram / Discord 默认隐藏，需 `AGIM_ENABLE_GLOBAL_IM=1`。
- **后端灵活**：Claude Code、Codex、GitHub Copilot CLI、OpenCode、Cursor、Kimi Code、Qoder、PI、MiMo Code、Antigravity、Agim Agent（进程内 LLM）。
- **AI 能力成套**：记忆、技能、聚焦（Focus）、Loop 工程、子代理（`call_agent` / `call_agents`）、心跳、提醒、备忘、结构化提问。
- **运行可靠**：SQLite outbox（at-least-once 投递）、重启恢复、任务看板、审计日志。生产环境硬依赖 Node 原生 `better-sqlite3`；无 SQLite 时 outbox 不可用。
- **安全默认开启**：token 鉴权、敏感路径拦截。工具自动审批**默认关闭**（`AGIM_AUTO_APPROVE=0`）；单人自用可设 `AGIM_AUTO_APPROVE=1`（接入 IM 时还需严格发送者白名单）。

## 快速开始

需要 **Node.js ≥ 22.19**。安装时需能编译 `better-sqlite3`（`gcc/g++`、`make`、`python3`）。

安装后运行 `agim`（或 `agim go`）。第一次会启动服务并打开浏览器向导：选一个模型、粘贴 API Key，然后直接聊天。

```bash
npm install -g agim-cli
agim
```

首次运行会：

1. 检测本机可用的 Agent（Claude Code / Codex / GitHub Copilot CLI / Cursor / Kimi Code / Qoder / PI / MiMo Code / Antigravity / Agim Agent 等）。
2. 如果还没有可用 Agent，启动 Agim 并打开 `http://localhost:3000/setup`，在浏览器里选 DeepSeek / Kimi / GLM / MiMo / Ollama 并粘贴一个 API Key。
3. 打印 Web 控制台地址。首次启动会把一次性 token 写到 `~/.agim/web-bootstrap-token`（需要时用 `agim token bootstrap` 查看）。本机 `127.0.0.1` 访问通常可免登。

默认 Web 控制台：`http://localhost:3000` · 首次向导：`/setup`  
跳过会写入 `setupSkipped`，`/setup` 仍可打开。详见 [`docs/first-run-setup.md`](docs/first-run-setup.md)。

- 对话：`/`
- 移动端 Portal：`/m/chat`（`/` Skills·Commands、`@` 工作区、Focus / Loop 底栏等，见 [`docs/portal-composer.md`](docs/portal-composer.md)）
- 原生壳：iOS [`apps/ios`](apps/ios) · macOS [`apps/macos`](apps/macos)（均包装 `/m/chat`，见 [`docs/macos-shell.md`](docs/macos-shell.md)）
- 任务：`/tasks`（Loop 审计：`/tasks/loops`）
- 设置：`/settings`

忘记入口或 token 时：

```bash
agim web
```

本机体检：

```bash
agim doctor
```

跑通 Web 对话后，再到设置里连接微信 / 飞书 / 钉钉等 IM 渠道。
`agim quickstart` 会作为兼容别名保留。

常用 CLI 入口：

| 命令 | 什么时候用 |
|---|---|
| `agim` | 首次运行进入设置向导；之后显示入口菜单 |
| `agim go` | 启动服务并打开首次向导（已有可用 Agent 时直接进入聊天） |
| `agim web` | 忘记控制台地址、服务状态或 token 路径 |
| `agim web --open` | 用默认浏览器打开 Web 控制台 |
| `agim web --start --open` | 后台启动服务并一步打开 Web |
| `agim config` | 继续配置 Agent、IM、Web、管理员 |
| `agim doctor` | 不知道卡在哪里时做本机体检 |
| `agim start --bg` / `status` / `restart` / `stop` | 已配置后的服务运维 |

## 如何选择 Agent 后端

| 场景 | 推荐路径 |
|---|---|
| 编码与复杂任务 | `claude-code` / `codex` / `copilot` / `opencode` / `cursor` / `kimi-code` / `qoder` / `pi` / `mimo` / `antigravity` |
| 低成本 API 直连 | `agim`（别名 `native`）+ `llmBackends` |

Agim Agent 配置详见：`docs/llm-backends.md`（含 DeepSeek V4：§8.1 兼容要点、§8.2 API 协议 / beta、§8.3 RPC）。

内置 Agent 清单与能力说明：`docs/agents.md`

## 核心 AI 能力

| 能力 | 说明 | 文档 |
|---|---|---|
| 长期记忆 | facts + persona，可选向量召回 | `docs/memory-and-vector.md` |
| Skills | `SKILL.md` 统一技能层 | `docs/skills.md` |
| 聚焦 Focus | 会话级注意力锚点（`/focus`） | `docs/architecture/focus.md` |
| Loop 工程 | 对齐 → 派工 → 验收（`/loop`；Agim 粘性父代理；Portal 底栏） | `docs/architecture/loop-engineering.md` |
| 子代理 / A2A | 嵌套 `call_agent` / `call_agents` + 专长画像 | `docs/architecture/subagent.md`、`docs/architecture/agent-profiles.md` |
| 心跳调度 | 周期性主动执行（`/heartbeat`） | `docs/architecture/reminders.md` |
| ask_user | Agent 发起结构化选择题 | `docs/ask-user.md` |
| 提醒 | 一次性/周期性提醒 | `docs/architecture/reminders.md` |
| 备忘 | 5W1H 持久记录，支持位置信息 | `docs/im-workspaces-guide.md` |

## 安全与合规

- Web 默认开启 token 鉴权。
- 工具自动审批**默认关闭**（`AGIM_AUTO_APPROVE=0`）：变更类工具走 IM/Web 审批卡。单人自用可设 `AGIM_AUTO_APPROVE=1`；若已接入 IM，还需配置严格 `AGIM_ALLOWED_USERS=platform:userId,...`（或显式 `AGIM_AUTO_APPROVE_OPEN_IM=1`）。
- 敏感路径默认拒绝访问。
- Self-protect 会拦截 Agent 杀/重启 agim 进程。
- 聊天 `/restart` **仅 IM 管理员**可用。Web 控制台与 Portal `/m/chat` 会拒绝；请用设置 → 服务 → Restart，或终端 `agim restart`（见 [`docs/runbook.md`](docs/runbook.md) §4）。
- Telegram / Discord 需 `AGIM_ENABLE_GLOBAL_IM=1`（国内部署默认关闭）。

安全详情：`docs/security-hardening.md`

## 常用聊天命令

| 命令 | 用途 |
|---|---|
| `/cc` `/oc` `/cx` `/co` `/cs` `/kimi` `/qd` `/pi` `/mimo` `/agy` `/na` … | 切换/指定 agent |
| `/new` | 新会话 |
| `/focus` `/loop` `/plan` | 聚焦、Loop 工程、Plan 模式 |
| `/skill` `/skills` | 技能 |
| `/model` `/models` | 查看/切换模型 |
| `/abort` | 中止当前 Agent 轮次 |
| `/btw ...` | 旁路提问（不插队阻塞主队列） |
| `/approval` | 会话级审批规则 |
| `/heartbeat` `/remind` `/memo` | 心跳 / 提醒 / 备忘 |
| `/job` `/cron` `/audit` `/stats` `/outbox` `/a2a` | 运行时 / 投递 / A2A 可观测 |
| `/agents` `/help` `/status` | 发现与服务状态 |
| `/restart` `/stop` | IM 管理员服务控制（Web/`/m/chat` 拒绝 `/restart`） |

完整列表在聊天里发 `/help`。

## 最小配置示例

`~/.agim/config.json`

```json
{
  "messengers": [],
  "agents": ["agim", "claude-code"],
  "defaultAgent": "agim",
  "llmBackends": [
    {
      "name": "default-agim",
      "provider": "openai-compat",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini"
    }
  ],
  "llmRoles": {
    "cheap": "default-agim",
    "finance": "default-agim"
  }
}
```

IM 可选——`messengers` 留空即为纯 Web 控制台；之后再在设置或 `agim config` 里加微信 / 飞书 / 钉钉。

密钥与配置文件分离存储。任务派发（编码 / 金融分析 / 采集）可在 **Settings → LLM → 任务派发速查** 用下拉配置（见 [`docs/llm-backends.md`](docs/llm-backends.md) §6.1）。

## 运维与架构

- 部署：`docs/deployment.md`
- 运维手册：`docs/runbook.md`
- 架构立场：`docs/architecture-bridge-and-agim-agent.md`
- 大模型与派发速查：`docs/llm-backends.md`
- 本机 Unix RPC（可选 `llm_complete` / 静态 token，供同机服务）：见 `CHANGELOG.md` Unreleased
- 版本记录：`CHANGELOG.md`

## 文档导航

请从 `docs/README.md` 开始。

## 迁移说明

当前公开入口统一使用 Agim 命名：

- 命令：`agim`
- 环境变量：`AGIM_*`
- 数据目录：`~/.agim` 与 `~/.agim-workspaces`

`/goal` 已退役——请改用聚焦（`/focus`）与 Loop（`/loop`）（`docs/goals.md`、`docs/architecture/focus.md`）。

## 开发

```bash
git clone https://github.com/benking007/agim.git
cd agim
npm ci
npm --prefix src/web-app ci
npm run build
npm run lint
npm run typecheck
npm test
```

## 许可证

MIT
