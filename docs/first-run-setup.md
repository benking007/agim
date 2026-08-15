# 首次引导（`/setup`）

安装后的目标是：**启动服务 → 浏览器打开 `/setup` → 选一个模型 → 填一个 API Key → ping → 进聊天**。  
CLI 只负责启动和给出地址；配置在浏览器里完成。`agim config` / `agim setup-llm` 仍是高级路径。

IM 里的 `/setup` 命令（管理员邀请等）与 Web 路由 `/setup` **不是同一件事**。本页只讲 Web 首次向导。

## 1. 推荐路径

```bash
npm install -g agim-cli
agim
```

`agim` 与 `agim go` 在首次安装时行为相同：跳过 CLI 菜单，启动服务，并打开：

```text
http://localhost:3000/setup
```

向导三步：

1. **选模型**：DeepSeek（推荐）/ Kimi / GLM / MiMo / 自定义 / 本地 Ollama
2. **填 API Key**：只写入本机 `~/.agim/llm-secrets.json`（权限 600）
3. **保存并测试**：ping 通过后进入聊天（`/?welcome=1`）

Ollama 无需 Key，默认 Base URL 为 `http://localhost:11434/v1`。

`/setup` 是常驻路由。已经配置过也可以再打开，用来加模型或改 Key。设置页 **Settings → LLM** 与向导共用同一套 Quick-enable 卡片。

## 2. 什么算「首次」

`GET /api/onboarding/status` 与 CLI（`agim` / `agim go`）共用同一套判定（`getOnboardingStatus()`）。

| 条件 | `firstRun` | `reason` | 行为 |
|------|------------|----------|------|
| 没有可用 CLI Agent，也没有可用 LLM Key | `true` | `no-usable-agent` | `agim` 直开 `/setup`；`/` 与 `/m/chat` 重定向到 `/setup` |
| 已有可用 LLM Key（`llmBackends` + 能解析到的 secret） | `false` | `ready` | 正常聊天；`/setup` 显示「已完成」 |
| 本机已有可用 CLI Agent（如 Claude Code） | `false` | `cli-agent-available` | 不强制向导；`agim go` 走启动 + 聊天 |
| 配置了 `setupSkipped: true` | `false` | 仍按上面算可用性 | 不再自动跳向导；CLI 恢复入口菜单 |

「可用 LLM」= `config.llmBackends` 里至少有一行，且 `resolveSecret()` 能拿到非空 Key。  
只写了 backend、没写 Key，仍算首次。

## 3. 跳过

向导上的「跳过，稍后配置」会 `POST /api/onboarding/skip`，把 `setupSkipped: true` 写入 `~/.agim/config.json`。

在 CLI 向导过程中按 Ctrl-C 也会写入 `setupSkipped`，避免下次还被拦住。

跳过之后：

- `/` 不再重定向到 `/setup`
- `/setup` 仍然可以打开（reason 不是 `ready` 时仍显示向导）
- 想重新当首次：删掉 `config.json` 里的 `setupSkipped`，或清掉 `~/.agim` 后重来

## 4. CLI 与启动

| 命令 | 首次（无 Agent / 无 Key） | 已就绪 |
|------|--------------------------|--------|
| `agim` | 不弹菜单，启动服务并打开 `/setup` | 入口菜单 |
| `agim go` | 同上 | 启动服务并打开聊天 |
| `agim start` | **允许启动**（没有 coding agent 也不会退出），横幅提示打开 `/setup` | 正常启动 |
| `agim config` / `agim setup-llm` | 高级 / 无头配置 | 同上 |

Web-console-only（`messengers: []`）是支持的。不必先配微信 / 飞书 / 钉钉。

窄屏下 `/` 会进 `/m/chat`，但首次仍会先被送到 `/setup`（`FirstRunRedirect` 包住两条聊天路由）。

## 5. API（需 admin）

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/onboarding/status` | 返回 `firstRun` / `reason` / `hasLlmSecret` / `availableCliAgents` / `skipped` |
| `POST` | `/api/onboarding/skip` | 写入 `setupSkipped`，返回更新后的状态 |

`role=user` 会 403。本机 loopback 或 `AGIM_WEB_AUTH=off` 时按 admin 处理。

## 6. 鉴权与 token

默认 Web 鉴权开启。首次启动会把一次性 raw token 写到 `~/.agim/web-bootstrap-token`（`chmod 600`）。

- 取回：`agim token bootstrap` 或 `cat ~/.agim/web-bootstrap-token`
- **不要**用 `agim token list`（只显示哈希）
- 本机 `127.0.0.1` 通常可免登（loopback trust）
- 本地调试可设 `AGIM_WEB_AUTH=off`

详见 [`runbook.md`](./runbook.md) §1b。

## 7. 相关文档

- 快速开始：[`../README.zh-CN.md`](../README.zh-CN.md) / [`../README.md`](../README.md)
- Agim Agent 模型与 Key：[`llm-backends.md`](./llm-backends.md)
- Agent 清单：[`agents.md`](./agents.md)
- 部署：[`deployment.md`](./deployment.md)
