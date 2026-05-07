# im-hub

[English](README.md)

**IM 到 AI Agent 的万能桥梁** — 将微信 / 飞书 / Telegram / **Discord** 接入 Claude Code / Codex / Copilot / OpenCode，**或通过 ACP 接入任意自定义 Agent**。单 Node.js 进程，无需 Docker / Redis；自带浏览器仪表盘、持久化任务、多租户工作区，IM 端真正的"工具调用人审"。

<p align="center">
  <img src="assets/banner.jpg" alt="im-hub banner" width="800">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/im-hub"><img src="https://img.shields.io/npm/dw/im-hub?style=for-the-badge&logo=npm&color=green"></a>
  <a href="https://github.com/ceociocto/im-hub/actions/workflows/release.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/ceociocto/im-hub/release.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/im-hub"><img src="https://img.shields.io/npm/v/im-hub?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://discord.gg/R83CXYz5"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://x.com/lijieisme"><img src="https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
</p>

<p align="center">
  <img src="assets/screenshot-telegram.png" alt="Telegram" width="400">
  &nbsp;&nbsp;
  <img src="assets/screenshot-wechat.png" alt="WeChat" width="400">
</p>

<p align="center">
  <b>Telegram</b> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>微信</b>
</p>

```
npm install -g im-hub
im-hub config wechat   # 扫码登录微信
im-hub start           # 启动桥接 + Web UI（:3000）
```

## 0.2.13 → 0.2.23 主要升级

- **Discord 适配器**（基于 `discord.js` 的 Gateway WebSocket）
- **工具调用人审（HITL）** — Claude 调工具时自动暂停，IM 同一会话回复 `y`/`n` 即可，**或在 Web 对话界面点弹出的审批卡**
- **任务仪表盘** `/tasks`，标签覆盖 **Jobs · Background · Subtasks · Schedules · Approvals · Health · Files · Audit**（每个 tab 支持 agent 过滤、Jobs 多选批量、SSE 实时刷新）
- **多租户 Workspace** — 每个工作区独立的 Agent 白名单 + 限流，**Settings 页加完整 CRUD UI**；`/job` `/schedule` `/audit` 命令也按 creator/workspace 隔离（每个用户只看到自己的）
- **ACP Server 模式** — im-hub 自身作为 ACP 兼容 Agent（`POST /tasks`，sync + SSE）
- **持久化 Job Board** + Cron 调度器（SQLite 落地，重启不丢，30 天自动修剪）
- **智能路由**：意图分类（中英文）、断路器、Sticky 会话
- **结构化日志**（`pino`）+ 全链路 `traceId` + 审计日志 + Prometheus `/api/metrics`
- **三态主题**（浅色 / 深色 / 跟随系统），所有页面在首屏前同步应用，无闪烁
- **v0.2.16 — 安全收口（P0 + P1）**：REST/WS token 常量时比较、Schedule `notify_url` SSRF 防护、日志级别 secret redact、approval socket 路径熵 + 权限校验、`Session.addMessage` per-key 互斥
- **v0.2.17 — 可观测 + IM 文本边界（P2 + P3）**：静态页 CSP / `X-Frame-Options` / `X-Content-Type-Options`，WebSocket 连接上限 + 背压，Prometheus 标签基数白名单，新增 counter（`im_hub_audit_prune_failed_total` / `im_hub_agent_cleanup_failed_total` / `im_hub_approval_*`），UTF-16 代理对安全切分，auto-allow 指纹 5 → 10 字符，SIGINT 关停时 SQLite WAL 干净 checkpoint
- **v0.2.18 — IM 重连退避（M9）**：抽公共 `Backoff` 助手（指数 + ±50% jitter），替换 Telegram + WeChat polling 的固定 2s / 5s 重连间隔；多实例从同一次网络抖动恢复时不再锁步打 IM 平台
- **v0.2.19 — Codex sandbox + Dashboard 过滤 / Audit tab**：codex 接入 `session.planMode`（默认 sandbox 改为显式 `-s workspace-write`，关闭 auto-approval）；Jobs/Subtasks/Schedules tab 加 agent 过滤；新增 Audit tab 把 SQLite 审计日志拉到 UI
- **v0.2.20 — Web 控制台 PR-A**：三态主题管理 + 全局错误边界 + 对话内审批卡（在 Web 聊天界面直接 Allow / Deny / Allow + Auto）
- **v0.2.21 — Web 控制台 PR-B**：Health tab（每个 agent 的 breaker / 限流余量 / p50/95/99 / sparkline）+ Approvals tab（浏览并解决所有 pending HITL 审批）
- **v0.2.22 — Web 控制台 PR-C**：SSE 事件流（`/events`）替代轮询，audit / approval / job / metrics 实时推送；Settings 页加 Workspace 完整 CRUD UI
- **v0.2.23 — Web 控制台 PR-D**：Files tab 只读浏览 `~/.im-hub-workspaces/<agent>/`；Jobs tab 多选 + 批量取消/重跑；Settings 页 header / 容器重新调整布局

完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## Web 对话与任务仪表盘

```
im-hub start           # 启动后访问 http://localhost:3000
                       #   /          对话（支持对话内审批卡）
                       #   /tasks     jobs · background · subtasks · schedules
                       #              · approvals · health · files · audit
                       #   /settings  Agent · 通道 · ACP · 工作区
```

- WebSocket 实时流式响应；**仪表盘走 SSE `/events`** 推送（audit / approval / job / metrics）
- Agent 切换与对话历史
- **三态主题**（浅色 / 深色 / 跟随系统），按 tab 持久化 + 全局错误边界
- 中英双语界面，自动检测浏览器语言
- `/tasks` 同时展示持久化任务、cron 调度、**`~/.claude/bgjobs`** + **`~/.config/opencode/bgjobs`** + **`~/.codex/bgjobs`** 的后台任务（可用 `IMHUB_BGJOB_ROOTS` 覆盖）、所有会话的 subtask 平铺、agent 健康（breaker · 限流 · p50/95/99 · sparkline）、待审批列表（浏览器直接处理）以及 `~/.im-hub-workspaces/<agent>/` 的只读文件浏览器

## 核心特性

- **多路复用** — 一个实例同时对接多个 IM 与多个 Agent
- **自定义 Agent 接入** — 通过 [ACP 协议](https://agentcommunicationprotocol.dev) 接入任何 HTTP 端点；支持 `/.well-known/acp` 自动发现
- **内置 IM 通道** — 微信（iLink）、飞书（WebSocket 长连接）、Telegram（grammy）、**Discord**（discord.js）
- **内置 Agent** — Claude Code、Codex、Copilot、OpenCode（统一 `AgentBase` 适配）
- **插件架构** — 轻松扩展新 IM / Agent
- **原生 TypeScript** — 无需 Go / Docker / Redis
- **JSONL 流式输出** — 真实流式 + 多字节 UTF-8 安全

## 安装

```bash
npm install -g im-hub
```

需要 **Node.js ≥ 18**（生产推荐 ≥ 22 LTS，详见 [`docs/deployment.md`](docs/deployment.md)）。

## 快速开始

```bash
# 1. 配置至少一个 IM
im-hub config wechat        # 扫码登录
im-hub config feishu        # 飞书 App ID + Secret，无需 webhook
im-hub config telegram      # @BotFather 拿 Token
im-hub config discord       # Bot Token，详见 docs/discord-setup.md

# 2. （可选）配置 Agent CLI，多数能自动检测
im-hub config claude

# 3. （可选）通过 ACP 接入远端自定义 Agent
im-hub config agent

# 4. 启动
im-hub start
```

### 飞书（WebSocket 长连接）

- ✅ 无需 webhook
- ✅ 无需公网 IP / 域名
- ✅ 无需 ngrok 内网穿透
- ✅ 直接从本地启动

### Discord

完整流程（创建 Bot、Intents、OAuth 邀请）见 [`docs/discord-setup.md`](docs/discord-setup.md)。

### 接入你自己的 Agent

im-hub 支持 **ACP（Agent Communication Protocol）**，只要你的 Agent 暴露一个标准 HTTP 端点就能接入——业务机器人、内部工具、云服务，皆可。

```bash
im-hub config agent
# 交互式：名称、端点、认证（无 / Bearer / API Key），自动验证连接 + /.well-known/acp 自动发现
```

接入后用法和内置 Agent 一致：

```
/myagent 分析一下一季度的销售报告
```

### 把 im-hub 当作 Agent 用

im-hub 同时暴露 ACP 服务端，任何 ACP 客户端都可以以 `POST http://localhost:3000/tasks`（同步）或加 `?mode=stream`（SSE）调用，鉴权同 Web Token：`Authorization: Bearer <token>`。

## CLI 命令

```
im-hub                 # 等同 start
im-hub start           # 启动桥接 + Web UI
im-hub config wechat   # 配置微信
im-hub config feishu   # 配置飞书
im-hub config telegram # 配置 Telegram
im-hub config discord  # 配置 Discord
im-hub config claude   # 配置 Claude Code
im-hub config agent    # 接入自定义 ACP Agent
im-hub agents          # 列出可用 Agent
im-hub messengers      # 列出可用 IM
im-hub help
```

## 聊天命令

直接在 IM 里发，回包流式回到同一 thread。

| 命令 | 含义 |
|---|---|
| 任意文本 | 路由到 Agent（Sticky 会话 + 意图分类） |
| `/<agent> <内容>` | 切换 Agent 并发送（如 `/cc 解释这段代码`、`/oc`、`/cx`、`/co`） |
| `/help` | 帮助 |
| `/agents` | 列出可用 Agent |
| `/status` | 连接状态 |
| `/new` | 开新会话（清空历史） |
| `/router status\|policy\|explain\|reset` | 查看路由策略 / 预测某条消息会去哪 |
| `/audit [n]` | 最近的调用审计 |
| `/job ...` | 查看 / 取消持久化任务 |
| `/schedule ...` | 列出 / 添加 / 删除 cron 调度 |
| `/sessions` | 列出本 thread 最近的会话 |
| `/model [provider/model]` | 查看或切换会话模型 |
| `/models` | 列出当前 Agent 可用模型 |
| `/think on\|off\|...` | 切换"深度思考"模式 |
| `/stats` | Agent 调用 / 延迟 / 错误统计 |
| `y` / `n` / `批准` / `拒绝` | 同意 / 拒绝 Claude 工具调用（HITL） |

## 工具调用人审（Human-in-the-loop）

当你从 IM 启动的 Claude 任务尝试调用工具时，im-hub 会暂停它，并在同一 IM 会话发送审批卡片：

```
🔐 工具调用审批请求
工具：Bash
入参：{"command":"rm -rf node_modules"}
回复 y 批准 / n 拒绝（5 分钟内未操作将自动拒绝）
req: a3f1c0d2
```

回复 `y` / `n` / `批准` / `拒绝`，决策通过 MCP sidecar 回到 Claude，对应继续或中止执行。同一审批链路在微信 / Telegram / 飞书 / Discord 上零差异工作。可用 `IMHUB_APPROVAL_DISABLED=1` 关闭。

## 架构

```
                       ┌─── 外部触发 ────┐
                       │ cron 30s tick    │
                       │ webhook → /api/notify
                       │ REST   → /api/invoke
                       │ ACP    → /tasks (sync/SSE)
                       └────────────┬─────┘
┌─ IM 入口 ────────────────────────┼─────────────────────┐
│ 微信 iLink     （长轮询 + 心跳）                       │
│ Telegram       （grammy）                              │
│ 飞书           （Lark SDK WebSocket）                  │
│ Discord        （discord.js Gateway）                  │
│ Web Chat       （浏览器 WebSocket）                    │
└────────────────────────────────┬──────────────────────┘
                                 │ MessageContext
                                 ▼
            ┌── 路由前置 gates ─────────────────┐
            │ workspace.resolve(userId)          │
            │ rateLimiter.allow(userKey)         │
            │ traceId + pino 子 logger           │
            └────────────────┬───────────────────┘
                             ▼
            ┌── parseMessage + 意图分类 ───────┐
            │ /<cmd>     → 内置子命令            │
            │ /<agent>   → 显式切换              │
            │ default    → classifyIntent       │
            │   ├ 主题正则（中英）               │
            │   ├ 关键词画像                    │
            │   ├ Sticky 会话偏置                │
            │   └ LLM 兜底（按需）               │
            └────────────────┬───────────────────┘
                             ▼
            ┌── Agent 调用 ─────────────────────┐
            │ workspace 白名单 + 断路器          │
            │ + 可用性 TTL 缓存                 │
            │ AgentBase.sendPrompt → spawnStream│
            │  (LineBuffer · 真流式 ·           │
            │   abort/timeout · UTF-8 安全)      │
            └────────────────┬───────────────────┘
              ┌──────┬───────┼────────┬─────────┐
              ▼      ▼       ▼        ▼         ▼
          opencode claude  codex   copilot   ACP 远端
                     │
                     ▼ （工具需要审批时）
              MCP sidecar ─ unix socket ─ approvalBus
                                            └─ approvalRouter → IM 会话

┌─ Cross-cutting ───────────────────────────────────────┐
│ audit-log    (SQLite，30 天保留)                       │
│ job-board    (SQLite 持久化 + AbortController)        │
│ scheduler    (30s tick → cron → 入队)                  │
│ workspaces   (按租户隔离 Agent 白名单 / 限流)          │
│ metrics      (Prometheus 文本，/api/metrics)           │
│ session      (~/.im-hub/sessions/，append-only JSONL) │
│ pino         (traceId 全链路，生产 JSON)               │
└───────────────────────────────────────────────────────┘
```

单进程、单实例：SQLite 三件套（`audit.db` / `jobs.db` / `schedules.db`）+ 会话文件树就是全部持久化层，不依赖 Redis / MQ。

更深入的架构剖析见 [`docs/architecture/current.md`](docs/architecture/current.md)。

## 项目结构

```
im-hub/
├── src/
│   ├── core/
│   │   ├── types.ts              # 插件接口
│   │   ├── registry.ts           # 插件注册
│   │   ├── router.ts             # 消息路由
│   │   ├── session.ts            # 会话管理（append-only JSONL）
│   │   ├── workspace.ts          # 多租户工作区
│   │   ├── intent.ts             # 意图分类
│   │   ├── intent-llm.ts         # LLM 兜底（LRU 缓存）
│   │   ├── circuit-breaker.ts    # 单 Agent 断路器
│   │   ├── rate-limiter.ts       # Token bucket 限流
│   │   ├── job-board.ts          # 持久化任务 + 取消
│   │   ├── schedule.ts           # cron tick → 入队
│   │   ├── audit-log.ts          # SQLite 审计
│   │   ├── metrics.ts            # Prometheus 分位
│   │   ├── acp-server.ts         # /tasks ACP 服务端
│   │   ├── approval-bus.ts       # 工具审批 pub/sub
│   │   ├── approval-router.ts    # 审批 ↔ IM 桥
│   │   ├── bgjob-reader.ts       # ~/.claude + ~/.config/opencode bgjobs
│   │   ├── agent-base.ts         # CLI Agent 共享 spawn/stream
│   │   ├── config-schema.ts      # zod schema
│   │   ├── logger.ts             # pino + traceId
│   │   ├── sqlite-helper.ts      # 共享 prepare / PRAGMA 缓存
│   │   └── commands/             # /audit /router /job /schedule /model …
│   ├── plugins/
│   │   ├── messengers/
│   │   │   ├── wechat/           # iLink 长轮询
│   │   │   ├── feishu/           # Lark SDK WebSocket
│   │   │   ├── telegram/         # grammy
│   │   │   └── discord/          # discord.js
│   │   └── agents/
│   │       ├── claude-code/      # 含 MCP 审批 sidecar
│   │       ├── codex/
│   │       ├── copilot/
│   │       ├── opencode/
│   │       └── acp/              # ACP 客户端 + /.well-known 发现
│   ├── index.ts
│   ├── cli.ts
│   └── web/
│       ├── server.ts             # HTTP + WS + REST + ACP server
│       └── public/
│           ├── index.html         # 对话界面
│           ├── tasks.html         # 任务仪表盘
│           └── settings.html      # 设置界面
├── docs/
│   ├── architecture/{current,target}.md
│   ├── adr/{0001,0002,0003}-*.md
│   ├── deployment.md
│   ├── discord-setup.md
│   └── upgrade-plan.md
├── package.json
├── tsconfig.json
└── README.md
```

## 配置

配置文件：`~/.im-hub/config.json`

```json
{
  "messengers": ["wechat", "discord"],
  "agents": ["claude-code", "opencode"],
  "defaultAgent": "claude-code",
  "discord": {
    "botToken": "***",
    "allowedGuilds": [],
    "allowedChannels": []
  },
  "acpAgents": [
    {
      "name": "my-agent",
      "aliases": ["ma"],
      "endpoint": "https://api.example.com",
      "auth": { "type": "bearer", "token": "***" },
      "enabled": true
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

由 `zod` 在启动时与每次 PUT `/api/config` 时校验，配置错误会立即报错而不是带病运行。

## 环境要求

- **Node.js 18+**（生产建议 22 LTS+）
- **至少一个 Agent CLI**（或 ACP 远端）：
  - `npm i -g @anthropic-ai/claude-code`
  - `npm i -g @openai/codex`
  - `npm i -g @github/copilot`
  - `npm i -g opencode-ai`

## 开发

```bash
git clone https://github.com/benking007/imhub.git
cd im-hub
npm install
npm run build      # tsc + 拷贝 public/
npm run dev        # tsc --watch
npm test           # bun test
npm run typecheck  # tsc --noEmit（src + 测试）
npm start
```

## 路线图

### v0.1.x（MVP）
- [x] 微信扫码登录
- [x] Claude Code、Codex、Copilot、OpenCode Agent
- [x] 基础命令路由

### v0.2.0 — 多 IM
- [x] 飞书适配器
- [x] Telegram 适配器
- [x] 会话持久化与对话历史
- [x] ACP 自定义 Agent 接入

### v0.2.x — Web & UI
- [x] Web 对话界面（流式）
- [x] 设置页面
- [x] 双语界面（EN / 中文）

### v0.2.13 — 基础设施
- [x] 结构化日志（pino）+ traceId
- [x] zod 配置 schema 校验
- [x] AgentBase 抽象 + 可用性缓存
- [x] 审计日志（SQLite）+ `/audit`
- [x] 意图分类 + 断路器 + 限流
- [x] ACP server 模式（`POST /tasks`，sync + SSE）
- [x] `/.well-known/acp` 自动发现
- [x] 多租户 Workspace + Agent 白名单
- [x] 持久化 Job Board + cron 调度
- [x] Web `/tasks` 面板 + REST API
- [x] Prometheus 指标

### v0.2.14 — 工具审批
- [x] IM 端的工具调用人审（HITL）
- [x] MCP 审批 sidecar（claude-code adapter）

### v0.2.15 — Discord & 仪表盘
- [x] Discord IM 适配器
- [x] 任务面板接入 Claude / opencode bgjobs
- [x] Subtask 平铺列表

### v0.2.16 — 安全收口（P0 + P1）
- [x] REST + WS token 常量时比较（共享 `safe-equal`）
- [x] Schedule `notify_url` SSRF 防护（仅 http(s)；屏蔽 RFC1918 / loopback / IPv6 ULA）+ 10s fetch 超时 + `redirect:'manual'`
- [x] HTML 注入 token：用 `JSON.stringify` 取代单引号拼接
- [x] Telegram bot token 日志脱敏（pino `redact.paths` + adapter 级 scrub）
- [x] WeChat 凭证文件 `0o600`、父目录 `0o700`
- [x] Approval socket 路径用 128-bit 随机 + listen 后 `chmod 0o600` + stat 校验
- [x] Job 结果大小上限（`IMHUB_JOB_RESULT_MAX_BYTES`，默认 1 MiB）+ UTF-8 / JSON 安全截断
- [x] Job Board 30 天保留 + 6h 修剪 + `creator_id` / `workspace_id` 库内迁移
- [x] `/job` `/schedule` `/audit` 命令按 creator/workspace 隔离（老库 ownerless 行仍对所有人可见，平稳升级）
- [x] Workspace 白名单从路由层下沉到命令层
- [x] 限流器机会式自清扫（不引 setInterval）
- [x] `Session.addMessage` per-key 互斥（修读改写并发竞态）

### v0.2.17 — 可观测 + IM 文本边界（P2 + P3）
- [x] 静态页安全响应头（`X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy` / CSP）
- [x] `/api/health` 公开（k8s liveness 友好）
- [x] WebSocket 连接上限（`IMHUB_MAX_WS_CLIENTS`，默认 100）+ `bufferedAmount` 背压（4 MiB highwater）
- [x] Prometheus 标签基数白名单（`intent` / `platform` 命中外归 `'other'`）
- [x] 新增 counter：`im_hub_audit_prune_failed_total`、`im_hub_agent_cleanup_failed_total`、`im_hub_approval_pending` / `im_hub_approval_requests_total` / `im_hub_approval_resolved_total{result=allow|deny|timeout}`
- [x] `intent-llm` 缓存键 SHA-256 + prompt 截 256 字符（防 LRU 内存膨胀）
- [x] auto-allow 指纹长度 5 → 10（`git status` ≠ `git stash` ≠ `git submo`）
- [x] UTF-16 代理对安全切分（emoji 在切点上不再渲染成 `□`）
- [x] Telegram HTML 转义补 `'` / `"`（approval-card `<a href="...">` 防御）
- [x] approval-bus 缓冲溢出回 `{type:"fatal"}` 而非静默 destroy
- [x] SIGINT 关停时 SQLite WAL 干净 checkpoint
- [x] traceId 12 hex → 16 hex（`~2^48` → `~2^64`）
- [x] WeChat ilink-client 剩余 4 处 fetch 加超时
- [x] Discord 输入提示 interval 配 `AbortController`（不再与 `client.destroy()` 抢 channel）
- [x] WeChat `contextTokens` 在心跳 tick 上周期清扫
- [x] CI 锁文件修复（腾讯镜像 URL → `https://registry.npmjs.org/`）

### v0.2.18 — IM 重连退避（M9）
- [x] 抽公共 `Backoff` 助手（指数 + ±jitter，RNG 可注入做确定性测试）
- [x] Telegram `runPollingLoop`：固定 2s / 5s setTimeout → `Backoff(2s, 60s, 0.5)`；30s 健康运行阈值会重置 backoff
- [x] WeChat ilink `pollLoop`：内联 `Math.pow(2,n-1)` → `Backoff(2s, 30s, 0.5)`；getUpdates 成功路径调用 reset

### v0.2.19 — Codex sandbox + Dashboard 过滤 / Audit tab
- [x] Codex 接入 `session.planMode`；默认 sandbox 从 `--full-auto` 改为显式 `-s workspace-write`
- [x] Jobs / Subtasks / Schedules 三个 tab 加 agent 下拉过滤（`OwnerOpts.agent` 全链路下沉）
- [x] 新增 Audit tab，把 SQLite 审计日志拉到 UI；`GET /api/audit?agent=&days=&user=&intent=`

### v0.2.20 — Web 控制台 PR-A：主题 + 错误边界 + 对话内审批
- [x] 三态主题（浅色 / 深色 / 跟随系统），`<head>` 同步应用避免闪烁
- [x] `_app.js` 共享工具：`window.imhub.{theme,i18n,api,showError}` + 自动安装的错误边界
- [x] `/` 对话内审批卡（Allow / Deny / Allow + Auto），点击走 WS `approval-action` 回 `approvalBus.resolvePending()`，跟 Telegram inline-button 同一条路径
- [x] `approval-router` 导出 `bindButtonHandlerForPlatform(platform)`，给延迟注册的 messenger（web 是其中之一）调用，避免 install-before-register 时序问题

### v0.2.21 — Web 控制台 PR-B：Health + Approvals tab
- [x] Health tab：每个 agent 的 breaker 状态（closed/open/half-open）、限流余量、p50/95/99 延迟、调用次数 / 成功率 / 成本 / 冷却 + 60 次轮询的 p95 sparkline
- [x] Approvals tab：列出所有 pending HITL 审批（reqId / threadId / tool / 等待时长 / registeredAt），浏览器侧直接 Allow / Deny / Allow + Auto
- [x] 后端：`GET /api/agent-health` / `GET /api/approvals` / `POST /api/approvals/:reqId/resolve`
- [x] `approval-bus.PendingApproval` 增 `input` + `registeredAt`；register / cancel 时 emit `'approval'` 事件给 SSE 用

### v0.2.22 — Web 控制台 PR-C：SSE 事件流 + Workspace CRUD UI
- [x] `src/core/event-bus.ts` — 类型化 publish/subscribe（audit / approval / job / metrics）+ 200 条 ring buffer
- [x] `GET /events` SSE 端点 — token 走 `?token=`，25s 心跳，listener 错误吞掉
- [x] Dashboard 接 `EventSource('/events?token=...')`，事件触发只刷可见 tab；轮询保留作为 fallback；`approval requested` 事件让 Approvals tab 标签闪一下高亮
- [x] Settings 页 Workspace 卡 — 列表 + 新增 / 编辑 / 删除（编辑时 id 锁定，default 行不可编辑/删除）
- [x] 后端 `GET/POST/PATCH/DELETE /api/workspaces` + `WorkspaceRegistry.{remove(id), listFull()}`；mutation persist 回 `~/.im-hub/config.json`

### v0.2.23 — Web 控制台 PR-D：Files tab + Jobs 批量 + Settings 美化
- [x] Files tab — 只读浏览 `~/.im-hub-workspaces/<agent>/`，左目录树 / 右内容窗，1 MiB 上限，NUL byte 探测二进制 → base64
- [x] 路径 traversal 防御：agent 名必须在 `registry.listAgents()` 白名单；resolve 后路径必须等于或位于 `defaultAgentCwd(agent)` base 之下
- [x] Jobs tab 多选 + 全选 + 隐藏式批量工具栏；选中态跨刷新保留
- [x] `POST /api/jobs/batch-cancel` / `batch-run` 接受 `{ ids: number[] }`（最多 100），per-id 失败不互相阻断
- [x] Settings header 重写（`.brand` + `.controls` 双分组）— 修复语言 `<select>` 拉伸成满屏宽问题；容器 720→880，header sticky，toast / `.btn-danger:hover` 改主题变量

### v0.3.0
- [ ] 钉钉适配器
- [ ] Slack 适配器
- [ ] 飞书 / Discord 卡片按钮版审批（替代纯文本）
- [ ] Cron `nextOccurrence` 内部 UTC 化（DST 安全，CR-2026-05-06 的 M5）
- [ ] 多实例事件总线（Redis Streams / NATS）让 SSE 在多副本间也能跨进程
- [ ] Workspace 成员选择 UI（当前 CSV 输入对运维好用但易错）

## 社区 <a name="wechat-group"></a>

有问题？欢迎在 [X](https://x.com/lijieisme) 或 Discord 上交流。

<p align="center">
  <a href="https://discord.gg/R83CXYz5">
    <img src="https://img.shields.io/badge/加入_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord">
  </a>
  &nbsp;
  <a href="https://x.com/lijieisme">
    <img src="https://img.shields.io/badge/关注_X-000000?style=for-the-badge&logo=x&logoColor=white" alt="X">
  </a>
</p>

<p align="center">
  <img src="assets/wechat-group" alt="原作者微信" width="180"><br>
  <sub><i>原作者联系方式</i></sub>
</p>

## 许可证

MIT
