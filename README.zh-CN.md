# Agim · 阿吉姆

[English](README.md)

Agim 是一个 **IM 到 AI Agent 的桥接系统**。
它强调“可用性与可运维性”：消息不丢、会话可续、审批可控、链路可观测。

## 项目重点

- **桥接优先**：微信 / 飞书 / 钉钉 / 邮件接入多类 Agent。
- **后端灵活**：Claude Code、Codex、GitHub Copilot CLI、OpenCode、Cursor、Kimi Code、Qoder、PI、MiMo Code、Antigravity、native LLM、ACP 远端 Agent。
- **AI 能力成套**：记忆、技能、长目标、心跳、提醒、备忘、结构化提问。
- **运行可靠**：SQLite outbox、重启恢复、任务看板、审计日志。
- **安全默认开启**：token 鉴权、工具审批、敏感路径拦截。

## 快速开始

先不用配置 IM，也不用理解 systemd / token / 工作区。先把 Web 控制台跑起来，确认能和一个 Agent 对话：

```bash
npm install -g agim-cli
agim go
```

`agim go` 会做三件事：

1. 检测本机可用的 Agent（Claude Code / Codex / GitHub Copilot CLI / Cursor / Kimi Code / Qoder / PI / MiMo Code / Agim Agent 等）。
2. 如果没有可用 Agent，引导你配置 Agim Agent 的大模型 API。
3. 后台启动 Agim，并打印 Web 控制台地址和首次访问 token。

默认 Web 控制台：`http://localhost:3000`

- 对话：`/`
- 任务：`/tasks`
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
| `agim` | 不确定该运行哪个命令时，打开引导入口菜单 |
| `agim go` | 第一次安装后，先跑通 Agent + Web |
| `agim web` | 忘记控制台地址、服务状态或 token 路径 |
| `agim web --open` | 用默认浏览器打开 Web 控制台 |
| `agim web --start --open` | 后台启动服务并一步打开 Web |
| `agim config` | 继续配置 Agent、IM、Web、管理员 |
| `agim doctor` | 不知道卡在哪里时做本机体检 |
| `agim start --bg` / `status` / `restart` / `stop` | 已配置后的服务运维 |

## 如何选择 Agent 后端

| 场景 | 推荐路径 |
|---|---|
| 编码与复杂任务 | `claude-code` / `codex` / `copilot` / `opencode` / `cursor` / `kimi-code` / `qoder` / `pi` / `mimo` |
| 低成本 API 直连 | `native` + `llmBackends` |
| 自定义远端执行器 | ACP (`acpAgents`) |

native 配置详见：`docs/llm-backends.md`

内置 Agent 清单与能力说明：`docs/agents.md`

## 核心 AI 能力

| 能力 | 说明 | 文档 |
|---|---|---|
| 长期记忆 | facts + persona，可选向量召回 | `docs/memory-and-vector.md` |
| Skills | `SKILL.md` 统一技能层 | `docs/skills.md` |
| 长目标 | 会话级持续目标（`/goal`） | `docs/goals.md` |
| 心跳调度 | 周期性主动执行（`/heartbeat`） | `docs/architecture/reminders.md` |
| ask_user | Agent 发起结构化选择题 | `docs/ask-user.md` |
| 提醒 | 一次性/周期性提醒 | `docs/architecture/reminders.md` |
| 备忘 | 5W1H 持久记录，支持位置信息 | `docs/im-workspaces-guide.md` |
| A2A | Agent 间调用与可追踪链路 | `CHANGELOG.md` |

## 安全与合规

- Web 默认开启 token 鉴权。
- 工具调用默认走审批门。
- 敏感路径默认拒绝访问。
- 海外 IM 可按需启用，国内部署可保持关闭。

安全详情：`docs/security-hardening.md`

## 常用 IM 命令

| 命令 | 用途 |
|---|---|
| `/cc ...` `/oc ...` `/cx ...` `/co ...` `/cs ...` `/kimi ...` `/qd ...` `/pi ...` `/mimo ...` `/na ...` | 切换/指定 agent |
| `/new` | 新会话 |
| `/model` `/models` | 查看/切换模型 |
| `/goal ...` | 管理长目标 |
| `/heartbeat ...` | 管理心跳任务 |
| `/remind ...` | 管理提醒 |
| `/memo ...` | 管理备忘 |
| `/job ...` `/cron ...` `/audit ...` `/stats` | 运维命令 |
| `/outbox ...` | 投递队列操作 |
| `/a2a ...` | A2A 可观测 |

## 最小配置示例

`~/.agim/config.json`

```json
{
  "messengers": ["wechat-ilink"],
  "agents": ["claude-code", "native"],
  "defaultAgent": "claude-code",
  "llmBackends": [
    {
      "name": "default-native",
      "provider": "openai-compat",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini"
    }
  ],
  "llmRoles": {
    "cheap": "default-native"
  }
}
```

密钥与配置文件分离存储。

## 运维与架构

- 部署：`docs/deployment.md`
- 运维手册：`docs/runbook.md`
- 架构立场：`docs/architecture-bridge-and-native.md`
- 版本记录：`CHANGELOG.md`

## 文档导航

请从 `docs/README.md` 开始。

## 迁移说明

当前公开入口统一使用 Agim 命名：

- 命令：`agim`
- 环境变量：`AGIM_*`
- 数据目录：`~/.agim` 与 `~/.agim-workspaces`

## 开发

```bash
git clone https://github.com/benking007/agim.git
cd agim
npm install --no-package-lock
npm --prefix src/web-app install
npm run build
npm run lint
npm run typecheck
npm test
```

## 许可证

MIT
