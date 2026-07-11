# 当前架构总览

本文描述 Agim 的当前运行形态，不包含历史阶段叙事。

## 1. 系统定位

Agim 是一个**单进程 IM-to-Agent 网关**：

- 向上接 IM / Web / ACP 请求
- 向下编排 CLI agent 与 native LLM agent
- 中间统一做路由、权限、会话、审计、投递与恢复

## 2. 运行拓扑

```text
IM / Web / API ingress
      │
      ▼
Message normalize (platform, user, thread, trace)
      │
      ▼
Pre-route gates
  - auth / role
  - workspace resolve
  - rate limit
      │
      ▼
Router
  - explicit command
  - sticky session
  - intent fallback
      │
      ▼
Agent invocation layer (AgentAdapter)
  - claude-code
  - codex
  - opencode
  - cursor
  - kimi-code
  - qoder
  - pi
  - antigravity
  - native
  - acp
      │
      ▼
Message sink / outbox
      │
      ▼
IM delivery + web views
```

## 3. 核心模块

| 模块 | 作用 |
|---|---|
| `core/router.ts` | 路由与会话主编排 |
| `core/session.ts` | 会话状态与历史管理 |
| `core/registry.ts` | agent/messenger 注册与查找 |
| `core/message-sink.ts` | 统一投递入口（含 outbox） |
| `core/approval-bus.ts` | 工具审批与跨流程交互总线 |
| `core/approval-router.ts` | 审批按钮与 IM 回调路由 |
| `core/ask-user-rpc.ts` | 结构化提问（单选/多选/自定义输入） |
| `core/job-board.ts` | 任务与调度持久层 |
| `web/server.ts` | Web/REST/WS 入口 |
| `cli-ui/tui/*` | 本地 TUI 交互层（含决策面板） |

## 4. 数据与状态

默认目录：`~/.agim/`

常见持久化对象：

- `config.json`（主配置）
- `tokens.json`（访问令牌）
- `llm-secrets.json`（LLM 密钥）
- `*.db`（审计、任务、记忆、投递等）
- `sessions/`（会话数据）

主配置统一由 `core/config-store.ts` 持久化：同进程请求先排队，不同进程通过
`config.json.lock` 协调完整的读改写事务，最终使用同目录临时文件、`fsync` 与原子
`rename` 替换，并保持 `0600` 权限。新增 Web/CLI 配置入口不得直接调用
`writeFile(config.json, ...)`；字段级修改应使用 `updateConfigObject()`，避免覆盖其他入口
刚写入的配置。

## 5. Agent 抽象

所有 agent 后端都通过统一 `AgentAdapter` 接口接入：

- 输入：prompt、history、context、signal
- 输出：流式文本 + usage + 可选 session id 回写
- 特性：支持 fallback、A2A、审批、技能与记忆注入

这让 CLI agent 与 native agent 成为“并列后端”，而不是两套系统。

## 6. 安全边界

默认策略：

- Web token 鉴权开启
- 敏感路径访问拦截
- 高风险工具可审批
- 审计日志记录关键操作

详见：`../security-hardening.md`

## 7. 可观测与运维

- 日志：结构化日志 + trace 上下文
- 任务：`/tasks` 面板查看执行状态
- 健康：`/api/health`
- 指标：`/api/metrics`

运维手册：`../runbook.md`

## 8. 交互决策层（审批 + ask_user）

Agim 在用户决策交互上有两条并行能力，并复用同一套回调通道：

- **工具审批**：控制高风险工具调用（允许 / 拒绝 / 同类自动允许）
- **结构化提问（ask_user）**：用于业务消歧与用户决策（单选/多选/自定义输入）

核心链路：

1. Agent 发起审批或 `ask_user`
2. `approval-bus` 统一受理并分发
3. `approval-router` 将按钮回调或文本回复路由到对应 resolver
4. resolver 产出结构化结果并回传给 agent 继续执行

在 TUI 中，两类交互已合并为统一决策面板：

- 审批：方向键选择 + Enter 确认
- ask_user 单选：方向键选择 + Enter
- ask_user 多选：方向键选择 + Space 勾选 + Enter 提交
- ask_user 自定义输入：选中后进入文本输入态

## 9. 推荐阅读顺序

1. `../../README.md` 或 `../../README.zh-CN.md`
2. `../architecture-bridge-and-native.md`
3. `../llm-backends.md`
4. `../runbook.md`
5. `../adr/`
