# 当前架构总览

本文描述 Agim **拆解后**的运行形态与代码布局，不包含历史阶段叙事。  
产品立场（桥接 vs Agim Agent）见 [`../architecture-bridge-and-agim-agent.md`](../architecture-bridge-and-agim-agent.md)。

## 1. 系统定位

Agim 是一个**单进程 IM-to-Agent 网关**（Node.js ≥ 22.19 / TypeScript）：

- 向上接 IM / Web / ACP 请求
- 向下编排 CLI agent 与 Agim Agent（进程内 LLM，registry id `agim`）
- 中间统一做路由、权限、会话、审计、投递与恢复

无 Docker、无 Redis；Web UI 默认 `:3000`，ACP 默认 `:9090`。

## 2. 运行拓扑

```text
IM / Web / API / ACP ingress
      │
      ▼
Message normalize (platform, user, thread, trace)
      │
      ▼
Pre-route gates
  - auth / role / allowlist
  - workspace resolve
  - rate limit
      │
      ▼
Router (core/router.ts)
  - explicit command
  - sticky session
  - intent fallback
      │
      ▼
AgentAdapter
  - CLI agents (claude-code, codex, …)
  - agim (进程内 agent-loop)
  - acp
      │
      ▼
Message sink / outbox
      │
      ▼
IM delivery + Web / TUI views
```

## 3. 架构原则（拆解后）

| 原则 | 含义 |
|---|---|
| **组合根只装配** | `cli.ts`、`web/server.ts` 负责接线、生命周期与 prefix 委托，不承载业务细节 |
| **域模块自洽** | REST / WS / CLI 子流程落在独立文件；域模块可依赖 `auth` / `http-utils`，不互相形成蜘蛛网 |
| **门面兼容** | `approval-bus.ts`、`agent-loop.ts`、`use-chat.ts` 等保留稳定 import 路径，内部再 export 子模块 |
| **防回潮** | `npm run check:file-budget` 对组合根设硬上限，超限失败；大文件软警告 |

## 4. 组合根与模块地图

### 4.1 进程入口

| 组合根 | 职责 | 预算上限（约） |
|---|---|---|
| `src/cli.ts` | Commander 命令注册；`start` 委托 `cli/start-runtime` | 700 行 |
| `src/web/server.ts` | HTTP 服务器创建、鉴权短路、按 pathname **prefix 委托**域 API、挂 WS | 1100 行 |
| `src/core/approval-bus.ts` | 审批总线门面（re-export + 少量编排） | 1200 行 |
| `src/core/llm/agent-loop.ts` | Agim Agent 主循环门面 | 80 行 |
| `src/web-app/.../use-chat.ts` | SPA 聊天 hook 门面 | 400 行 |
| `src/web-app/.../agent-portal.tsx` | Portal 页面组合 | 1000 行 |

### 4.2 分层示意

```text
┌─────────────────────────────────────────────────────────────┐
│  Surfaces                                                    │
│  cli.ts · web/server.ts · acp-server · messengers · SPA      │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
        ┌───────▼────────┐            ┌───────▼────────┐
        │ cli/* runtime  │            │ web/*-api.ts   │
        │ start / inbound│            │ auth · ws-chat │
        └───────┬────────┘            └───────┬────────┘
                │                             │
                └──────────────┬──────────────┘
                               ▼
                ┌──────────────────────────────┐
                │ core/                        │
                │ router · session · registry  │
                │ approval/* · message-sink    │
                │ job-board · config-store     │
                └──────────────┬───────────────┘
                               ▼
                ┌──────────────────────────────┐
                │ agents / adapters / llm loop │
                └──────────────────────────────┘
```

## 5. 核心模块清单

### 5.1 编排与状态（`src/core/`）

| 模块 | 作用 |
|---|---|
| `router.ts` | 路由与会话主编排 |
| `session.ts` | 会话状态与历史 |
| `registry.ts` | agent / messenger 注册与查找 |
| `message-sink.ts` | 统一投递（含 outbox） |
| `approval-bus.ts` + `approval/*` | 工具审批与跨通道交互 |
| `approval-router.ts` | IM / Web 按钮与文本回调路由 |
| `ask-user-rpc.ts` | 结构化提问（单选/多选/自定义） |
| `job-board.ts` | 任务与调度持久层 |
| `config-store.ts` | `config.json` 原子读写与跨进程锁 |
| `llm/agent-loop*.ts` | Agim Agent 主循环（拆成 types/config/stream/stuck/helpers/run） |

### 5.2 CLI 运行时（`src/cli/`）

| 模块 | 作用 |
|---|---|
| `start-runtime.ts` | `agim start`：装载配置、启 messenger / Web / ACP、接线 |
| `messenger-inbound.ts` | IM 入站规范化与投递到 router |
| `handle-message.ts` | 单条消息处理与 agent 调用边界 |
| `graceful-shutdown.ts` | 信号与有序停机 |
| `start-context.ts` | start 共享上下文类型 |

### 5.3 Web 层（`src/web/`）

**基础能力**

| 模块 | 作用 |
|---|---|
| `http-utils.ts` | JSON / 错误响应等共用 HTTP 助手 |
| `auth.ts` | Token 提取、校验、admin、login/logout |
| `serial-queue.ts` | 串行写队列（配置等） |
| `static-serve.ts` | 静态资源与 HTML |
| `ws-chat.ts` | WebSocket 聊天协议与会话推送 |

**域 API（由 `server.ts` prefix 委托）**

| 模块 | 典型前缀 |
|---|---|
| `config-api.ts` | `/api/config` |
| `env-api.ts` | `/api/env` |
| `jobs-api.ts` | `/api/jobs`、`/api/bgjobs`、reminders… |
| `service-api.ts` | `/api/service/*` |
| `memory-api.ts` | `/api/memory/*` |
| `chat-media-api.ts` | 聊天媒体上传/下载 |
| `workspaces-api.ts` | `/api/workspaces` |
| `workspace-files-api.ts` | `/api/workspace-files` |
| `messengers-api.ts` | `/api/messengers/*`、notify、invoke… |
| `viewer-api.ts` | `/api/viewer/*` |
| `health-api.ts` | `/api/health`、metrics… |
| `approvals-api.ts` | `/api/approvals` |
| `search-api.ts` | 搜索 |
| `workspace-skills-api.ts` | `/api/skills` |
| `agim-skills-api.ts` | `/api/agim-skills` |
| `memos-api.ts` | memos / loc |
| `outbox-a2a-api.ts` | outbox / a2a / artifacts |
| `llm-api.ts` | `/api/llm/*` |
| `mcp-api.ts` | `/api/mcp/*` |
| `background-tasks-api.ts` | heartbeat / goals / asks |

路由合同：见 [`../endpoint-contracts.md`](../endpoint-contracts.md)。  
提取器扫描整个 `src/web/*.ts`（不再只读 `server.ts`）。

### 5.4 Approval 子包（`src/core/approval/`）

| 模块 | 作用 |
|---|---|
| `types.ts` | 类型 |
| `policy.ts` | 默认策略（含 auto-approve 安全默认） |
| `fingerprint.ts` | 同类请求指纹 |
| `pending.ts` | 待决表 |
| `socket-rpc.ts` | 与 agent / UI 的 socket RPC |

对外仍优先从 `approval-bus.ts` 导入，保持兼容。

### 5.5 SPA（`src/web-app/`）

| 区域 | 布局 |
|---|---|
| 聊天状态 | `hooks/use-chat.ts`（门面）+ `hooks/chat/*`（types / reducer / ws-handlers） |
| Portal | `components/m-portal/agent-portal.tsx` + header / empty / message-list / explore / voice / pet / side-panel / composer… |
| API facade | `src/lib/api/endpoints.ts`（手工维护；与 `tools/endpoints.json` 合同校验） |

## 6. 关键数据流

### 6.1 IM → Agent → 投递

1. Messenger adapter 收消息 → `cli/messenger-inbound` 规范化  
2. `cli/handle-message` / `core/router` 选 agent 与 workspace  
3. `AgentAdapter.invoke`（CLI 子进程或 `agent-loop-run`）  
4. 流式事件经 sink / WS / IM 投递；高风险工具走 `approval-bus`

### 6.2 Web REST

1. `server.ts`：CORS / auth / admin 闸门  
2. pathname prefix → `handleXxxApi`  
3. 域模块读写 `config-store`、job-board、memory 等  
4. JSON 响应；敏感写路径要求 admin

### 6.3 WebSocket 聊天

1. upgrade：`verifyClient`（IP 限流 + Origin + token）  
2. `ws-chat.handleClientMessage`：chat / abort / approval-action…  
3. 与 `active-runs`、router、approval-router 协作推送

### 6.4 审批 / ask_user

1. Agent 发起审批或 `ask_user`  
2. `approval-bus` 受理并落 pending  
3. `approval-router` 分发到 IM 按钮或 Web WS  
4. 用户决策回传 resolver，agent 继续

TUI 侧两类交互合并为统一决策面板（方向键 / Space / Enter）。

## 7. 数据与状态

默认目录：`~/.agim/`

常见持久化：

- `config.json`（主配置；经 `config-store` 排队 + 文件锁 + 原子 rename，`0600`）
- `tokens.json` / `web-bootstrap-token`（访问令牌）
- `llm-secrets.json`（LLM 密钥）
- `web-thread-owners.json`（Web 线程归属）
- `*.db`（审计、任务、记忆、投递等）
- `sessions/`（会话数据）

新增配置写入口不得直接 `writeFile(config.json)`；字段级修改用 `updateConfigObject()`。

工作目录与记忆隔离：[`agent-cwd-and-memory.md`](./agent-cwd-and-memory.md)。

## 8. Agent 抽象

所有后端经统一 `AgentAdapter`：

- 输入：prompt、history、context、signal  
- 输出：流式文本 + usage + 可选 session id  
- 能力：fallback、A2A、审批、skills、记忆注入  

CLI agent 与 Agim Agent（`agim`）是**并列后端**，不是两套系统。后端清单权威源：[`../agents.md`](../agents.md)。

## 9. 安全边界（摘要）

默认策略要点：

- Web token 鉴权；敏感 GET/写路径需 admin  
- IM：无严格 sender allowlist 时抑制 auto-approve（见 `AGIM_AUTO_APPROVE*`）  
- 主 Agent 审批：composer「替我审批 / 请求审批」或 Settings → Policy（`/api/policy/auto-approve`）；子代理始终代审  

- `exec` cwd 限制在 workspace（除非显式放开）  
- bwrap 掩蔽解析后的 `AGIM_HOME` / `~/.agim`  
- 媒体下载 realpath + 非 admin 需 thread 归属  

详见 [`../security-hardening.md`](../security-hardening.md)。

## 10. 可观测与运维

- 结构化日志 + `traceId`  
- `/tasks`、健康与 metrics API  
- 手册：[`../runbook.md`](../runbook.md)

## 11. 防回潮与合同

| 检查 | 命令 | 作用 |
|---|---|---|
| 文件预算 | `npm run check:file-budget` | 组合根硬上限；>800 行软警告 |
| 端点合同 | `npm run check:contracts` | `src/web/*.ts` ↔ `endpoints.json` ↔ SPA facade |
| 发布门禁 | `npm run verify:release` | 含上述检查 |

新增 Web 路由：改对应 `*-api.ts`（必要时只在 `server.ts` 加 prefix）→ `npm --prefix src/web-app run update-endpoints` → `check:contracts`。

## 12. 扩展配方（简表）

| 要做什么 | 落点 |
|---|---|
| 新 REST 资源 | 新建或扩展 `src/web/<domain>-api.ts`，在 `server.ts` 增加 prefix 委托 |
| 新 CLI 子命令 | `cli.ts` 注册；重逻辑放 `src/cli/` 或 `src/core/` |
| 新审批策略 | `core/approval/policy.ts`（勿把策略塞回组合根） |
| 改 agent 主循环 | `core/llm/agent-loop-*.ts`；保持 `agent-loop.ts` 门面稳定 |
| 改 Portal UI | `m-portal/*` 子组件；页面壳保持薄 |
| 新 agent 后端 | 遵循 [`../agent-integration-sop.md`](../agent-integration-sop.md) |

## 13. 演进计划（编排）

- [`subagent.md`](./subagent.md)：**Subagent 概念 SSOT**（≠ 多 sticky Agent；同族 pro/flash 与跨 adapter A2A 统一为 SubagentRun）
- [`focus.md`](./focus.md)：**Focus 概念 SSOT**（注意力锚点；废弃 goal；文档先行）
- [`loop-engineering.md`](./loop-engineering.md)：**Loop 概念 SSOT**（Focus 上的执行–观察闭环；`/loop`；Phase C；文档先行）
- [`orchestration-roadmap.md`](./orchestration-roadmap.md)：分阶段实施（Phase A → B → C）

在现有 job 树 / activity-WS /（将迁为）focus+critic 之上加薄编排；跨 adapter 仍走 `callAgentByName`，同族 spawn 补齐 role/backend。

## 14. 推荐阅读顺序

1. [`../../README.md`](../../README.md) / [`../../README.zh-CN.md`](../../README.zh-CN.md)  
2. [`../architecture-bridge-and-agim-agent.md`](../architecture-bridge-and-agim-agent.md)  
3. 本文（模块地图与数据流）  
4. [`subagent.md`](./subagent.md) · [`loop-engineering.md`](./loop-engineering.md) · [`orchestration-roadmap.md`](./orchestration-roadmap.md)（若做 Subagent / 长工程）  
5. [`../endpoint-contracts.md`](../endpoint-contracts.md)  
6. [`../security-hardening.md`](../security-hardening.md)  
7. [`../llm-backends.md`](../llm-backends.md) · [`../runbook.md`](../runbook.md) · [`../adr/`](../adr/)  
