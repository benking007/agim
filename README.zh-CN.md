# im-hub-pro

[English](README.md)

**IM 到 AI Agent 的万能桥梁** — 将微信 / 飞书 / Telegram / Discord 接入 Claude Code / Codex / Copilot / OpenCode，或通过 ACP 接入任意自定义 Agent。单 Node.js 进程，无需 Docker / Redis。

> 原 [`im-hub`](https://www.npmjs.com/package/im-hub) 的产品化分支。配置目录（`~/.im-hub/`）、环境变量（`IMHUB_*`）、HTTP 头（`X-IM-Hub-Token`）保持不变——无缝升级。详见[从 im-hub 迁移](#从-im-hub-迁移)。

## 亮点

- **4 种 IM + 邮件，4+ 种 Agent** — 微信（图片 / 文件 / 语音）、飞书、Telegram、Discord、Email（SMTP）；Claude Code、Codex、Copilot、OpenCode，以及任意 ACP 端点
- **`/remind` 提醒子系统** — 一次性 + 定期（`每天8点喝水`）；非 slash 消息 LLM 自动识别意图；LLM 润色投递文本；Agent MCP 工具直接创建；Web `/reminders` 管理页；邮件 + IM 双通道投递
- **`/memo` 5W1H 持久记忆库** — 通用「what / who / when / where / how / why」记事本，可选 GPS（浏览器地理定位 H5 + 百度地理编码）；默认永久保存，临时类（停车、当天会议）单独走 24h 桶；Agent 通过 MCP 工具自动落库 + 检索，闲聊里提到的地点 / 生日 / 待办都能记下
- **浏览器控制台** — 对话界面、任务面板（Jobs / 调度 / 审批 / 健康 / 文件 / 审计）、提醒面板、设置页含工作区 CRUD
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
| **IM 通道** | 微信（iLink — 图片 / 文件 / 语音 / 视频）、飞书（WebSocket）、Telegram（grammy — 图片 / 语音 / 音频）、Discord（discord.js）、Email（SMTP，仅推送） |
| **Agent** | Claude Code、Codex、Copilot、OpenCode（统一 `AgentBase`）；任何 HTTP Agent 通过 ACP 接入 |
| **提醒** | `/remind` slash、LLM 意图识别、LLM 润色投递、Agent MCP 工具（claude-code + opencode）、Web `/reminders` 页面 |
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
| `/remind …` | 提醒子系统 — 详见 [提醒](#提醒) |
| `/memo …` | 5W1H 持久记忆库 — 详见 [备忘](#备忘)（别名 `/记`、`/note`）|
| `/job`、`/cron`、`/audit`、`/stats` | 管理任务、定时、审计、统计（`/schedule` 仍是 `/cron` 别名，v0.4.0 移除） |
| `/router status\|explain` | 查看路由策略 |
| `y` / `n` / `批准` / `拒绝` | 同意 / 拒绝（工具调用 或 提醒确认卡片） |

## 工具调用人审

当 Claude 尝试调用工具时，im-hub-pro 会暂停并发送审批卡：

```
🔐 工具调用审批请求
工具：Bash
入参：{"command":"rm -rf node_modules"}
回复 y 批准 / n 拒绝（5 分钟内未操作将自动拒绝）
```

在 IM 回复 `y` / `n`，或在 Web 界面点 Allow / Deny。微信、Telegram、飞书、Discord 行为一致。`IMHUB_APPROVAL_DISABLED=1` 可关闭。

## 提醒

内置 `/remind` 子系统——一次性 / 定期，三种创建路径，三种投递增强。

```bash
# 一次性
/remind 2m 喝水
/remind 40秒喝水
/remind 下午6点下班
/remind 18:30 出门

# 定期 🔁
/remind 每5分钟看屏幕外
/remind 每天早上8点喝水
/remind 每周一三五9点站会
/remind 每个工作日18:00下班

# 邮件 ✉️ （需要 SMTP 配置——见 [配置](#配置)）
/remind email me@x.com 8:00 早安
/remind bindemail me@x.com   # 绑定默认邮箱 → /remind email 每天8点 早安
/remind unbindemail

# 管理
/remind list
/remind cancel <id>
/remind clear
/remind snooze <id> 5m
/remind aiwatch on|off       # 切换 LLM 意图识别

# 关掉某条提醒的 LLM 润色
/remind literal 每5分钟 喝水
```

**三种创建路径**（最终都落到同一个 `~/.im-hub/reminders.db`）：

1. **`/remind` slash** — 显式、结构化输入
2. **LLM 意图识别**（默认开启）— 直接说"明天早上8点提醒我开会"，机器人弹"要不要为这件事设个提醒？"卡片，回复 `y` 创建
3. **Agent MCP 工具** — 在 claude-code / opencode (stdio) 会话里聊到未来事件时，agent 自动调 `create_reminder`。opencode (http) 走单用户 agent-asserted context 路径

**两种投递增强**：

- **LLM 润色**（默认开启）：触发时由当前 agent 把字面文本重写成自然提醒（"早上好，记得喝杯水"）。系统约束：**不献媚、不过度幽默、不夸大**。Agent 失败 / 超时时回退字面文本
- **延迟投递标记**：超过 1 小时未投递的提醒前缀加 `⏰ 延迟投递`，让用户知道 bot 离线过

Web 界面 `/reminders` 可视化管理（状态筛选、延后、取消）。

完整设计：[`docs/architecture/reminders.md`](docs/architecture/reminders.md)。

## 备忘

`/memo` 是一个 5W1H 持久记忆库。每条 memo 都可以挂上 `what` / `who` / `when_at` / `where (lat/lng/label)` / `how` / `why` 任意子集，外加可选的 `expires_at` 生命周期。位置只是其中一个轴 —— 同一个工具也能记「我爸生日 5月8日」「苹果发了 AVP2」。

```bash
# Slash
/memo                          # 搜索提示 + 最近的 memo
/memo list                     # 最近 10 条
/memo show <id>
/memo delete <id>
/memo search 茶馆
/memo here [备注]              # 一次性 HTTPS 链接 → 浏览器抓 GPS
/memo 39.9,116.4 家            # 直接给坐标 + label

# 别名：/记、/note
```

Agent（claude-code / opencode）能看到 5 个 MCP 工具，遇到值得记的内容**自动调用**——不用打 slash：

- `save_memo` —— 从自然语言里抽 5W1H 落库；`address` 参数走百度地理编码补全坐标
- `request_location_capture` —— 返回一次性 H5 链接让用户在 IM 内置浏览器授权 GPS
- `search_memos` —— 多字段 AND-combined 检索（"我的车在哪"）
- `update_memo` —— patch 已有 memo（比如后补 `where_*`，或传 `address` 让后端 geocode）
- `delete_memo`

**生命周期分层**：默认所有 memo 永久；agent 判定为临时性内容（"我把车停这了" / "今天下午3点开会"）才 set `expires_in_hours`，后台每 5 分钟跑一次 sweep 删掉到期行。

**时区**：所有时间按 Asia/Shanghai (UTC+8) 解读，存为不带 `Z` / 偏移的 `YYYY-MM-DD HH:MM:SS`。其他时区部署设 `IMHUB_TZ_OFFSET_HOURS` 即可。

**浏览器 GPS 抓取**：`/memo here` 和 `request_location_capture` 都会发一个 10 分钟有效的一次性 HTTPS 链接，默认 base 是 `https://agent.iclaw.host`（公共托管入口）。自己有 HTTPS 域名的用户设 `IMHUB_LOC_BASE_URL=https://your-host` 让链接走自己的域。

**地址转坐标（可选）**：设 `IMHUB_BAIDU_MAP_AK` 一个百度地图 AK 之后，agent 在 `save_memo` / `update_memo` 里就能直接传 `address: "中关村大街27号"` 让后端 geocode 出坐标。不设的话该路径返回「geocoding not configured」，但**直接传坐标 + 浏览器抓 GPS 这两条路径都不受影响**。免费申请：[lbsyun.baidu.com](https://lbsyun.baidu.com/) → 控制台 → 应用管理 → 创建应用 → 服务端 API。默认无需 SN 签名；如启用 SN校验，详见 `src/core/locations.ts` 头注释。

## 配置

### 配置文件
`~/.im-hub/config.json`（启动时 zod 校验）：

```json
{
  "messengers": ["wechat-ilink", "telegram"],
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

### 邮件提醒（SMTP）

要启用 `/remind email …`，启动前设置以下环境变量：

```bash
# 必填
export IMHUB_SMTP_HOST=smtp.gmail.com
export IMHUB_SMTP_USER=you@gmail.com
export IMHUB_SMTP_PASS=<16位应用专用密码>      # 不是登录密码

# 可选
export IMHUB_SMTP_PORT=465                    # 默认 465
export IMHUB_SMTP_FROM=you@gmail.com          # 默认 = USER
export IMHUB_SMTP_SECURE=auto                 # auto | true | false
```

**常见邮箱配置参考**：

| 服务商 | HOST | PORT | 备注 |
|-------|------|------|------|
| Gmail | `smtp.gmail.com` | 465 | 用 [应用专用密码](https://myaccount.google.com/apppasswords)，需先开两步验证 |
| QQ 邮箱 | `smtp.qq.com` | 465 | 设置 → 账号 → POP3/SMTP 服务 → 授权码 |
| 163 邮箱 | `smtp.163.com` | 465 | 设置 → POP3/SMTP/IMAP → 授权码 |
| Outlook | `smtp-mail.outlook.com` | 587 | 设 `IMHUB_SMTP_SECURE=false`（STARTTLS） |
| 企业邮箱 | 厂商提供 | 任意 | `SECURE` 按厂商文档设 |

不设这些环境变量也不会启动失败——邮件 adapter 仍会注册，但 `/remind email …` 会返回"Email adapter not configured"，IM 提醒不受影响。

systemd 部署示例：
```ini
[Service]
Environment="IMHUB_SMTP_HOST=smtp.gmail.com"
Environment="IMHUB_SMTP_USER=you@gmail.com"
Environment="IMHUB_SMTP_PASS=xxxxxxxxxxxxxxxx"
```

### 其他环境变量

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `IMHUB_WEB_BIND` | `127.0.0.1` | Web UI 监听地址（设 `0.0.0.0` 对外暴露，建议前面挂 HTTPS 反代） |
| `IMHUB_APPROVAL_DISABLED` | 未设 | 设 `=1` 跳过工具调用人审 |
| `IMHUB_OPENCODE_DRIVER` | `stdio` | 设 `http` 启用 HTTP driver（更快，但 reminder MCP 路径会走单用户 agent-asserted context） |
| `IMHUB_OPENCODE_GATE` | `medium` | `strict` / `loose` / `none` — opencode 权限闸 |
| `IM_HUB_LLM_JUDGE_AGENT` | 未设 | 路由分类失败时用作兜底的 LLM judge agent 名 |
| `OPENAI_API_KEY` | 未设 | 启用 OpenAI Whisper 做语音转写 |
| `IMHUB_WHISPERCPP_BIN` + `IMHUB_WHISPERCPP_MODEL` | 未设 | 本地 Whisper.cpp 转写（不走云） |
| `IMHUB_BAIDU_MAP_AK` | 未设 | 百度地图 AK；启用 `/memo` 地址→坐标 geocoding 路径。不设置时直接给坐标和浏览器抓 GPS 不受影响。 |
| `IMHUB_LOC_BASE_URL` | `https://agent.iclaw.host` | `/memo here` H5 抓 GPS 链接的公开 HTTPS 域名。自托管时改成自己的域。 |
| `IMHUB_TZ_OFFSET_HOURS` | `8` | memo 时间戳的 UTC 偏移（默认 Asia/Shanghai）。仅当部署在其他时区时调整。 |

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
| v0.2.37 | 提醒子系统 — `/remind`、LLM 意图识别 + 润色、Agent MCP 工具、邮件通道、Web `/reminders`、微信 context_token 持久化 |
| v0.3.0 | `/memo` 5W1H 持久记忆库 — `/location` → `/memo` 改名、地址 geocoding 接百度地图、opencode HTTP driver SSE 修复 |
| v0.3.1 | Telegram + 飞书原生位置消息接入、所有渠道 GCJ-02 → WGS-84 修正、`memo` 列保存原话 + LLM/启发式 `what` 提取 |

### v0.4.0（下一版）

- [ ] codex MCP-server 模式（让 codex 也能用提醒工具）
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
