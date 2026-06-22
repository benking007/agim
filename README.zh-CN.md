# Agim · 阿吉姆

[English](README.md)

Agim 是一个 **IM 到 AI Agent 的桥接系统**。
它强调“可用性与可运维性”：消息不丢、会话可续、审批可控、链路可观测。

## 项目重点

- **桥接优先**：微信 / 飞书 / 钉钉 / 邮件接入多类 Agent。
- **后端灵活**：Claude Code、Codex、OpenCode、Cursor、Antigravity、native LLM、ACP 远端 Agent。
- **AI 能力成套**：记忆、技能、长目标、心跳、提醒、备忘、结构化提问。
- **运行可靠**：SQLite outbox、重启恢复、任务看板、审计日志。
- **安全默认开启**：token 鉴权、工具审批、敏感路径拦截。

## 快速开始

```bash
npm install -g agim-cli
agim                        # 交互式向导
agim start
```

Web 控制台：`http://localhost:3000`

- 对话：`/`
- 任务：`/tasks`
- 设置：`/settings`

## 如何选择 Agent 后端

| 场景 | 推荐路径 |
|---|---|
| 编码与复杂任务 | `claude-code` / `codex` / `opencode` / `cursor` |
| 低成本 API 直连 | `native` + `llmBackends` |
| 自定义远端执行器 | ACP (`acpAgents`) |

native 配置详见：`docs/llm-backends.md`

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
| `/cc ...` `/oc ...` `/cx ...` `/cs ...` `/na ...` | 切换/指定 agent |
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

历史安装保持兼容：

- 旧命令别名可继续使用
- 旧环境变量命名继续兼容
- 旧数据目录会自动识别

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

## 社区

<p align="center">
  <a href="https://deepseek.club/community/imhub">
    <img src="https://deepseek.club/assets/logo-DH6LfKkF.png" style="width: 150px; height: auto;" alt="DeepSeek">
  </a>
</p>

## 许可证

MIT
