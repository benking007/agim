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
| `core/job-board.ts` | 任务与调度持久层 |
| `web/server.ts` | Web/REST/WS 入口 |

## 4. 数据与状态

默认目录：`~/.agim/`

常见持久化对象：

- `config.json`（主配置）
- `tokens.json`（访问令牌）
- `llm-secrets.json`（LLM 密钥）
- `*.db`（审计、任务、记忆、投递等）
- `sessions/`（会话数据）

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

## 8. 推荐阅读顺序

1. `../../README.md` 或 `../../README.zh-CN.md`
2. `../architecture-bridge-and-native.md`
3. `../llm-backends.md`
4. `../runbook.md`
5. `../adr/`
