# im-hub-pro

[English](README.md)

**IM 到 AI Agent 的万能桥梁** — 将微信 / 飞书 / Telegram / Discord 接入 Claude Code / Codex / Copilot / OpenCode，或通过 ACP 接入任意自定义 Agent。单 Node.js 进程，无需 Docker / Redis。

> 原 [`im-hub`](https://www.npmjs.com/package/im-hub) 的产品化分支。配置目录（`~/.im-hub/`）、环境变量（`IMHUB_*`）、HTTP 头（`X-IM-Hub-Token`）保持不变——无缝升级。详见[从 im-hub 迁移](#从-im-hub-迁移)。

## 亮点

- **4 种 IM 通道，4+ 种 Agent** — 微信（图片 / 文件 / 语音）、飞书、Telegram、Discord；Claude Code、Codex、Copilot、OpenCode，以及任意 ACP 端点
- **浏览器控制台** — 对话界面、任务面板（Jobs / 调度 / 审批 / 健康 / 文件 / 审计）、设置页含工作区 CRUD
- **工具调用人审（HITL）** — Claude 调用工具时暂停，IM 回复 `y`/`n` 或在页面点卡片审批；全平台一致
- **微信和 Telegram 富媒体** — 接收图片、文件、视频；语音消息支持微信 STT、OpenAI Whisper、whisper.cpp 转写
- **智能路由** — 意图分类（中英文）、Sticky 会话、断路器、限流器
- **多租户工作区** — 按工作区隔离 Agent 白名单、限流、命令级 ACL
- **持久化任务与定时** — SQLite 落地，重启不丢，30 天自动修剪
- **可观测** — 结构化日志（pino + traceId）、Prometheus 指标、审计日志
- **安全** — 常量时鉴权、SSRF 防护、凭证文件权限、审批 socket 熵值

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 快速开始

```bash
npm install -g im-hub-pro    # 需要 Node.js ≥ 18（推荐 ≥ 22 LTS）

# 配置至少一个 IM
im-hub-pro config wechat        # 扫码登录
im-hub-pro config feishu        # 飞书 App ID + Secret，无需 webhook
im-hub-pro config telegram      # @BotFather 拿 Token
im-hub-pro config discord       # Bot Token，详见 docs/discord-setup.md

# （可选）通过 ACP 接入远端自定义 Agent
im-hub-pro config agent

# 启动
im-hub-pro start
```

浏览器访问 `http://localhost:3000` — 对话 `/`、任务 `/tasks`、设置 `/settings`。

### 从 `im-hub` 迁移

```bash
npm uninstall -g im-hub
npm install -g im-hub-pro
im-hub-pro start          # 配置、环境变量、Header 全部不变
```

## 功能一览

| 分类 | 内容 |
|------|------|
| **IM 通道** | 微信（iLink — 图片 / 文件 / 语音 / 视频）、飞书（WebSocket）、Telegram（grammy — 图片 / 语音 / 音频）、Discord（discord.js） |
| **Agent** | Claude Code、Codex、Copilot、OpenCode（统一 `AgentBase`）；任何 HTTP Agent 通过 ACP 接入 |
| **Web 控制台** | 流式对话、三态主题（浅 / 深 / 跟随系统）、中英双语、SSE 实时仪表盘 |
| **工具人审** | IM 端 + 页面内审批卡；Claude MCP sidecar |
| **任务** | SQLite 持久化 Job Board + cron 调度；批量操作；后台任务读取 |
| **路由** | 意图分类、断路器、限流、Sticky 会话、LLM 兜底 |
| **工作区** | 多租户；Agent 白名单 + 限流；命令级 ACL |
| **可观测** | pino 结构化日志、traceId、Prometheus `/api/metrics`、SQLite 审计 |
| **ACP** | 客户端（连接远端 Agent）+ 服务端（im-hub-pro 自身作为 ACP Agent） |

## CLI 命令

```
im-hub-pro start           # 启动桥接 + Web UI
im-hub-pro config wechat   # 配置微信
im-hub-pro config feishu   # 配置飞书
im-hub-pro config telegram # 配置 Telegram
im-hub-pro config discord  # 配置 Discord
im-hub-pro config claude   # 配置 Claude Code
im-hub-pro config agent    # 接入自定义 ACP Agent
im-hub-pro agents          # 列出可用 Agent
im-hub-pro messengers      # 列出可用 IM
```

## 聊天命令

| 命令 | 含义 |
|------|------|
| 任意文本 | 路由到 Agent（Sticky 会话 + 意图分类） |
| `/<agent> <内容>` | 切换 Agent — `/cc`、`/oc`、`/cx`、`/co` |
| `/new` | 开新会话（清空历史） |
| `/model [provider/model]` | 查看或切换模型 |
| `/think on\|off` | 切换深度思考模式 |
| `/job`、`/schedule`、`/audit`、`/stats` | 管理任务、调度、审计、统计 |
| `/router status\|explain` | 查看路由策略 |
| `y` / `n` / `批准` / `拒绝` | 同意 / 拒绝 Claude 工具调用 |

## 工具调用人审

当 Claude 尝试调用工具时，im-hub-pro 会暂停并发送审批卡：

```
🔐 工具调用审批请求
工具：Bash
入参：{"command":"rm -rf node_modules"}
回复 y 批准 / n 拒绝（5 分钟内未操作将自动拒绝）
```

在 IM 回复 `y` / `n`，或在 Web 界面点 Allow / Deny。微信、Telegram、飞书、Discord 行为一致。`IMHUB_APPROVAL_DISABLED=1` 可关闭。

## 架构

```
┌─ IM 入口 ────────────────────────────────────────┐
│ 微信 iLink     （长轮询 + 图片/语音/文件）        │
│ Telegram       （grammy + 图片/语音/音频）        │
│ 飞书           （Lark SDK WebSocket）             │
│ Discord        （discord.js Gateway）             │
│ Web Chat       （浏览器 WebSocket）               │
└───────────────────────┬──────────────────────────┘
                        │ MessageContext
                        ▼
          ┌── 路由前置 gates ─────────────────┐
          │ workspace · 限流器 · traceId      │
          └────────────────┬──────────────────┘
                           ▼
          ┌── 意图路由 ───────────────────────┐
          │ 命令 → 内置处理                    │
          │ /agent → 显式切换                  │
          │ 默认 → 分类（正则/关键词/          │
          │         Sticky/LLM 兜底）          │
          └────────────────┬──────────────────┘
                           ▼
          ┌── Agent 调用 ─────────────────────┐
          │ 断路器 + spawn stream              │
          └───┬──────┬──────┬──────┬──────┬───┘
              ▼      ▼      ▼      ▼      ▼
          claude  opencode codex copilot  ACP
              │
              ▼ （工具审批）
        MCP sidecar → approvalBus → IM 会话

┌─ Cross-cutting ──────────────────────────────────┐
│ SQLite（审计 · 任务 · 调度）                      │
│ 会话（append-only JSONL）                         │
│ Prometheus 指标 · pino 结构化日志                  │
└──────────────────────────────────────────────────┘
```

单进程，零外部依赖——SQLite + 会话文件就是全部持久化层。

深入架构详见 [`docs/architecture/current.md`](docs/architecture/current.md)。

## 配置

配置文件：`~/.im-hub/config.json`（启动时 zod 校验）

```json
{
  "messengers": ["wechat", "telegram"],
  "agents": ["claude-code", "opencode"],
  "defaultAgent": "claude-code",
  "telegram": { "botToken": "***" },
  "acpAgents": [
    {
      "name": "my-agent",
      "endpoint": "https://api.example.com",
      "auth": { "type": "bearer", "token": "***" }
    }
  ],
  "workspaces": [
    {
      "id": "team-data",
      "name": "数据团队",
      "agents": ["opencode", "my-agent"],
      "members": ["user-123"],
      "rateLimit": { "rate": 30, "intervalSec": 60, "burst": 60 }
    }
  ]
}
```

## 环境要求

- **Node.js ≥ 18**（推荐 ≥ 22 LTS）
- 至少一个 Agent CLI 或 ACP 端点：
  - `npm i -g @anthropic-ai/claude-code`
  - `npm i -g @openai/codex`
  - `npm i -g @github/copilot`
  - `npm i -g opencode-ai`

## 开发

```bash
git clone https://github.com/benking007/imhub.git && cd imhub
npm install
npm run build      # tsc + 拷贝 public/
npm run dev        # tsc --watch
npm test           # bun test
npm run lint       # biome lint
npm run typecheck  # tsc --noEmit
```

## 部署

systemd、Docker、nginx、监控与升级详见 [`docs/deployment.md`](docs/deployment.md)。

## 路线图

### 已完成

| 版本 | 主题 |
|------|------|
| v0.1.x | MVP — 微信 + 4 种 Agent + 命令路由 |
| v0.2.0 | 多 IM — 飞书、Telegram、会话持久化、ACP |
| v0.2.13 | 基础设施 — 日志、审计、意图、任务、指标、工作区 |
| v0.2.14 | 工具调用人审（HITL） |
| v0.2.15 | Discord 适配器 + 任务面板 |
| v0.2.16–17 | 安全收口 + 可观测 |
| v0.2.18–19 | IM 重连退避、Codex sandbox、仪表盘过滤 |
| v0.2.20–23 | Web 控制台 — 主题、审批、SSE、文件、批量操作 |
| v0.2.30 | 生产硬化 — 会话隔离、WS 串行、回环监听 |
| v0.2.35 | 微信和 Telegram 富媒体 — 图片 / 文件 / 语音 / 视频 |

### v0.3.0（下一版）

- [ ] 钉钉适配器
- [ ] Slack 适配器
- [ ] 飞书 / Discord 卡片按钮版审批
- [ ] 多实例事件总线（Redis Streams / NATS）
- [ ] 工作区成员选择 UI

## 社区

<p align="center">
  <a href="https://discord.gg/R83CXYz5">
    <img src="https://img.shields.io/badge/加入_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord">
  </a>
  &nbsp;
  <a href="https://x.com/lijieisme">
    <img src="https://img.shields.io/badge/关注_X-000000?style=for-the-badge&logo=x&logoColor=white" alt="X">
  </a>
</p>

## 许可证

MIT
