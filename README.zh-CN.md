# Agim · 阿吉姆

[English](README.md)

**IM 到 AI Agent 的万能桥梁** — 将微信 / 飞书 / 钉钉 / 邮件 接入 Claude Code / Codex / OpenCode，或通过 ACP 接入任意自定义 Agent。单 Node.js 进程，无需 Docker / Redis。

> **品牌**：英文名 **Agim**（取自 Agent + IM，也有 agile 敏捷的感觉），中文名 **阿吉姆**。
> npm 包名 **`agim-cli`**（短名 `agim` 被 npm 反 typo-squat 保留），装完后**命令**还是 **`agim`**，
> 日常打的就是这个。老命令 `agim` 也保留为别名，老的 systemd 单元和 shell 别名不会断。
> 配置目录新装默认 **`~/.agim/`**，已有 **`~/.agim/`** 的老用户会被自动识别继续沿用。
> 环境变量（`IMHUB_*`）、HTTP 头（`X-IM-Hub-Token`）、systemd 单元 `im-hub.service` 都保留
> 原名以兼容 0.x 部署——详见 [迁移](#迁移)。

## 亮点

- **3 种 IM + 邮件，3+ 种 Agent** — 微信（图片 / 文件 / 语音）、飞书、钉钉（图片 / 语音，自带服务端 ASR）、Email（SMTP）；Claude Code、Codex、OpenCode、Antigravity，以及任意 ACP 端点
- **原生 LLM 栈（v1.3.0+）** — 内置 in-process agent loop（`native` adapter），直连任何 OpenAI / Anthropic 兼容 API（DeepSeek / Kimi / GLM / Qwen / Ollama / vLLM / OpenAI / Anthropic）。配置面有 LLM Backends + Roles + Secrets 三段，支持外挂 MCP 服务器、多轮 agent loop、策略式审批门（allow-list / deny-list）。可用作 `memory-distill` / `memory-consolidate` / `intent-llm` 的便宜路由，可作为本地优先的聊天 agent（`/na`），也可作 A2A 的 peer。详见 [`docs/llm-backends.md`](docs/llm-backends.md) 与 [`docs/architecture-bridge-and-native.md`](docs/architecture-bridge-and-native.md)
- **会话级长目标（v1.3.0+ · `/goal`）** — 每个 IM 会话最多一个 active 目标，自动注入每条 prompt，确保 Agent 跨多轮不偏题。生命周期：`set / body / progress / pause / resume / complete / cancel / list`。跨会话管理在 `/tasks/goals`。详见 [`docs/goals.md`](docs/goals.md)
- **Heartbeat 主动节拍（v1.3.0+ · `/heartbeat`）** — 把一个会话绑到周期性「现在有事要做吗？」节拍。每次 tick 走 DECIDE（便宜 LLM）→ EXECUTE（Agent 实际办）→ EVALUATE（通知门评估是否打扰用户）。跨会话管理在 `/tasks/heartbeat`
- **结构化 Agent→User 选择题（v1.3.0+ · `mcp__imhub__ask_user`）** — Agent 给用户出 N 选 1 选择题，用户按键或文字回复都能可靠回到 Agent，避免「自由聊天里 yes/no 二义性」。等待队列在 `/tasks/asks`。详见 [`docs/ask-user.md`](docs/ask-user.md)
- **agim Skills 技能引擎（v1.3.0+ · `/skill`）** — 放一个 `SKILL.md` 到 `~/.agim/skills/<name>/`，所有 CLI agent + native 都看得到。3 层渐进披露（name+desc 每轮自动注入；body 按需 `mcp__imhub__read_skill`；scripts/refs 走普通 file-read）。Web 编辑器在 `/settings/agim-skills`。详见 [`docs/skills.md`](docs/skills.md)
- **`/router compare` A/B 评测（v1.3.0+）** — 同一条 prompt 同时打两个后端（CLI 与 native 可任意组合），一个卡片返回延迟 / token / 输出，方便在改 `defaultAgent` 之前先选个赢家
- **合规友好默认（v1.2.23+）** — 海外 IM 适配器（Discord、Telegram）以及远程 ACP Agent 入口默认**全部隐藏**（CLI 向导 / Web 后台 / 运行时加载三层都 gate 住），主页面、安装向导、Web 后台都不会暴露。国内部署保持关闭即可。需要跨境通道时再通过 `IMHUB_ENABLE_GLOBAL_IM=1` / `IMHUB_ENABLE_REMOTE_AGENT=1` 显式启用。完整安全控制清单见 [`docs/security-hardening.md`](docs/security-hardening.md)（~30 个 env、敏感路径黑名单、出站脱敏、审计事件表、token 角色、R14 systemctl-aware 生命周期）
- **Agent 之间互调（A2A）** — Agent 可以在自己的工具循环里直接调另一个 Agent，比如直接说「用 codex 帮我跑 git status」/「让 opencode 跑一下测试」。护栏在 agim 里强制：递归深度限制（默认 3）、禁止自调、工作区白名单、按人预算共享；可观测：`/a2a stats | recent | tree <id>`；`IMHUB_A2A_ENABLED=0` 关闭
- **A2A 共享文件传递（v1.1.3+）** — caller 可通过 `inputs[]`（`fromAbsolutePath` / `fromCallerOutput` / 内联 `content`）把文件放进 callee 工作区；callee 把产物写到 `~/.agim/artifacts/<jobId>/_agim-output/`，返回的 `outputs[]` 让 caller 按需读。同文件系统优先 hard-link，否则复制。大小上限 env 可调
- **IM 长内容 viewer（v1.1.6+）** — 微信 / 飞书等对富 markdown 渲染差。Agent 回复超过阈值（行数 / 字符数 / 含表格 / 大段代码）时，agim 把完整 markdown 永久存进本机 `~/.agim/viewer.db`（**永远不离开你的机器**），IM 里只发短摘要 + 链接 `https://<你的域名>/v/<uuid>`。链接背后是 agim 自己的 web console，由你自己反代（cloudflared / caddy / tailscale 任选）。Agent 可显式用 `<im-summary>…</im-summary><full-md>…</full-md>` 包装长回答获得最干净体验。开启：`IMHUB_VIEWER_ENABLED=1` + `IMHUB_VIEWER_PUBLIC_BASE_URL=https://你的域名`
- **投递不丢消息** — Agent 回复 / 提醒 / 审批卡片 / 重启通知 全部走 SQLite outbox + 指数退避 worker，IM 平台抖动或断连不再丢回复；`/outbox status | list | failed | retry <id>`
- **崩溃中断可恢复** — 每条入站消息建 inline job；agim 重启时正在跑的会标 `interrupted`，下次启动 10 分钟窗口内通知对应会话。**v1.2.0+** 在飞书等支持的渠道走原生 `🔁 重发 / ✖ 取消` 内联按钮卡片，其余渠道兜底为文字提示。群聊内只有原发起者可点按钮
- **长期记忆（v1.2.0+）** — 按用户的事实库 + 自动蒸馏的 persona 摘要，每次对话自动注入 prompt。默认 SQLite + FTS5；可选向量召回（本地 BGE via `@xenova/transformers` ONNX，或任意 OpenAI 兼容 `/v1/embeddings` 端点），RRF 融合双路。默认关闭，Settings → 自动化记忆 开启。Web 管理 Tab `/tasks#memory` 可看 / 改 / 导出。**全量数据留本机** `~/.agim/memory.db`
- **成本与健康仪表盘（v1.2.0+）** — `/tasks#cost` 基于 audit log 聚合每日成本 / 调用数 / 错误数 / p95 延迟。1/7/30/90 天过滤，按用户 / agent / 平台 top-N，日趋势图带指标切换。Claude 每次调用费用自动从 `--output-format json` 提取
- **Agent 主动推送（v1.2.0+）** — 新的 `mcp__imhub__push_message` MCP 工具让运行中的 agent 不需要外部触发就把后续消息推回原 IM 会话（长任务通知、定时类提醒）。`POST /api/notify` 同一能力也暴露给 webhook / 外部脚本。每用户限流 + 跨会话开关防刷屏
- **管理员邀请（v1.2.2+）** — `agim admin invite`（或 `agim` 交互菜单「邀请新管理员」）生成一次性 IM token，受邀者在 IM 发 `/setup admin <token>` 即升级，不用动 `~/.agim/env`。`agim admin list` 查当前白名单
- **`/remind` 提醒子系统** — 一次性 + 定期（`每天8点喝水`）；非 slash 消息 LLM 自动识别意图；LLM 润色投递文本；Agent MCP 工具直接创建；Web `/reminders` 管理页；邮件 + IM 双通道投递
- **`/memo` 5W1H 持久记忆库** — 通用「what / who / when / where / how / why」记事本，可选 GPS（浏览器地理定位 H5 + 百度地理编码）；默认永久保存，临时类（停车、当天会议）单独走 24h 桶；Agent 通过 MCP 工具自动落库 + 检索，闲聊里提到的地点 / 生日 / 待办都能记下
- **浏览器控制台** — 对话界面；任务面板含 12 个 Tab（Jobs / 后台脚本 / 子任务 / 定时 / 审批 / 健康 / 工作区 / 审计 / 投递队列 / A2A 调用 / **成本与健康 / 记忆**）；提醒、备忘、设置页含工作区 CRUD + 管理员白名单 + Safety 卡片（重启 / 停止）。完整中英双语 + 每页语言切换 + 专业名词 `(?)` 帮助弹窗（v1.1.4+）
- **工具调用人审（HITL）** — Claude 调用工具时暂停，IM 回复 `y`/`n` 或在页面点卡片审批；全平台一致
- **微信 / 钉钉 富媒体** — 接收图片、文件、视频；语音消息按平台走最佳转写链路：微信 STT、钉钉服务端 ASR、OpenAI Whisper、whisper.cpp
- **智能路由** — 意图分类（中英文）、Sticky 会话、断路器、限流器
- **多租户工作区** — 按工作区隔离 Agent 白名单、限流、命令级 ACL
- **持久化任务与定时** — SQLite 落地，重启不丢，显式 `/job` 30 天 / 自动跟踪的 inline job 24 小时
- **可观测** — 结构化日志（pino + traceId）、Prometheus 指标、审计日志
- **安全** — Web 令牌 admin/user 双角色（R13）、敏感路径硬拒（AGENTS.md / `~/.agim/env` / `.env` 等）+ 出站 token 自动脱敏（R13）、记忆 / AGENTS.md prompt-injection 防护（R13）、按 IP WS 限流、常量时鉴权、SSRF 防护、凭证文件 0o600、审批 socket 熵值、持久 `audit_events` 表保留 180 天（R12 ⑤）、25s 优雅退出 + reap 兜底（R14）、启动期 PID 自检（R14）。详见 [`docs/security-hardening.md`](docs/security-hardening.md)

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 快速开始

```bash
npm install -g agim-cli      # 需要 Node.js ≥ 18（推荐 ≥ 22 LTS）

# 配置至少一个 IM
agim                            # 交互式向导（推荐）—— 双语，方向键选语言后逐项配置
                                # 也可以走老的子命令：
agim config wechat              # 扫码登录
agim config feishu              # 飞书 App ID + Secret，无需 webhook
agim config dingtalk            # 钉钉 ClientID + ClientSecret（Stream 模式机器人）

# （可选）通过 ACP 接入远端自定义 Agent
agim config agent

# 启动
agim start
```

浏览器访问 `http://localhost:3000` — 对话 `/`、任务 `/tasks`、设置 `/settings`。

### 迁移

#### 从原 `agim` 迁移
```bash
npm uninstall -g im-hub
npm install -g agim-cli
agim start            # 配置、环境变量、Header 全部不变
```

#### 从 `agim`（0.x → 1.0）迁移
```bash
npm uninstall -g im-hub-pro
npm install -g agim-cli
agim start            # 配置目录、环境变量、Header 全部不变
```

npm 包名是 `agim-cli`（短名 `agim` 被 npm 反 typo-squat 保留了）；安装后**命令**还是 `agim`，
日常打命令就是 `agim …`。`agim` 命令也保留为别名，原有的 systemd 单元和别名脚本不用动。

## 功能一览

| 分类 | 内容 |
|------|------|
| **IM 通道** | 微信（iLink — 图片 / 文件 / 语音 / 视频）、飞书（WebSocket）、钉钉（Stream 模式 — 图片 / 语音，自带服务端 ASR）、Email（SMTP，仅推送） |
| **Agent** | Claude Code、Codex、OpenCode、Antigravity（统一 `AgentBase`）；**`native`** in-process LLM loop；任何 HTTP Agent 通过 ACP 接入——所有后端走同一份 `AgentAdapter` 接口 |
| **原生 LLM** | OpenAI / Anthropic 兼容 provider，外挂 MCP 服务器，多轮 agent loop + 策略式审批门，角色绑定（`cheap` / `evaluator` / `native-chat`） |
| **提醒** | `/remind` slash、LLM 意图识别、LLM 润色投递、Agent MCP 工具（claude-code + opencode）、Web `/reminders` 页面 |
| **长目标 + 心跳 + 提问** | `/goal` 会话级目标、`/heartbeat` 周期 DECIDE/EXECUTE/EVALUATE 节拍、`mcp__imhub__ask_user` 结构化选择题，跨会话视图在 `/tasks/{goals,heartbeat,asks}` |
| **技能（Skills）** | `~/.agim/skills/<name>/SKILL.md` 被所有 agent（CLI + native）发现；3 层渐进披露；Web 编辑器在 `/settings/agim-skills` |
| **Web 控制台** | 流式对话、三态主题（浅 / 深 / 跟随系统）、中英双语（v1.3.0 每个新页面都跟齐）、SSE 实时仪表盘、Settings 子页 LLM / MCP / Native Agent / Skills |
| **工具人审** | IM 端 + 页面内审批卡；Claude MCP sidecar；native 走 allow-list 策略门 |
| **任务** | SQLite 持久化 Job Board + cron 调度；批量操作；后台任务读取 |
| **路由** | 意图分类、断路器、限流、Sticky 会话、LLM 兜底；`/router compare` A/B 评测 |
| **工作区** | 多租户；Agent 白名单 + 限流；命令级 ACL |
| **可观测** | pino 结构化日志、traceId、Prometheus `/api/metrics`、SQLite 审计 |
| **ACP** | 客户端（连接远端 Agent）+ 服务端（阿吉姆自身作为 ACP Agent），bearer 走 `~/.agim/acp-token`（兼容回退 `~/.agim/web-token`） |

## CLI 命令

```
agim                       # 交互式向导（双语，推荐入口）
agim start                 # 启动桥接 + Web 界面（前台）
agim start --bg            # 后台守护进程模式
agim status                # 查看服务状态（systemd / bg / fg）
agim restart               # 重启正在运行的服务
agim stop                  # 停止服务
agim uninstall             # 卸载（保留 ~/.agim-workspaces/）
agim config wechat         # 配置微信
agim config feishu         # 配置飞书
agim config dingtalk       # 配置钉钉（Stream 模式企业内部应用）
agim config claude         # 配置 Claude Code
agim config agent          # 接入自定义 ACP Agent
agim agents                # 列出可用 Agent
agim messengers            # 列出可用 IM

# v1.3.0+ — 原生 LLM 栈 + 诊断
agim setup llm             # 向导：增/查/删 LLM backend，绑定角色，写 secret
agim setup llm native-enable  # 一键启用 `native` agent（前提是已配置 backend）
agim setup mcp             # 向导：增/查/删 外挂 MCP 服务器（stdio / HTTP / SSE）
agim setup mcp health      # 探活全部 MCP 服务器
agim diag llm              # 各 backend ping + 角色绑定表
agim diag mcp              # 连接并列工具

# v1.1.10+ — Web/ACP 令牌
agim token create [name]   # 新发 user/admin token（接 /api/*、/acp/*）
agim token list            # 列出 token（只回显末 4 位）
agim token revoke <id>     # 按 id 撤销
agim token bootstrap       # 输出一次性 web-bootstrap token（`~/.agim/admin-bootstrap-token`）

# （`agim …` 作为别名继续可用）
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
| `/outbox status\|list\|failed\|retry <id>` | 查看与重发 IM 投递队列（v1.1.2+） |
| `/a2a stats\|recent\|tree <id>` | 查看 Agent 之间互调的统计 / 最近 N 次 / 调用链树（v1.1.2+） |
| `/router status\|explain` | 查看路由策略 |
| `/router compare agent:<a> agent:<b> "<内容>"` | A/B 评测——同一 prompt 同时打两个后端，并排展示延迟 / token / 输出（v1.3.0+） |
| `/goal …` | 会话级长目标——`set / body / progress / pause / resume / complete / cancel / list / show`（v1.3.0+） |
| `/heartbeat …` | 周期 DECIDE→EXECUTE→EVALUATE 节拍——`bind / unbind / show / pause / resume / status`（v1.3.0+） |
| `/skill list\|show <name>\|refresh` | 查看从 `~/.agim/skills/` 加载的 agim Skills（v1.3.0+） |
| `/cc native …` / `/na …` / `/llm …` | 切换到 in-process 原生 LLM agent（v1.3.0+） |
| `y` / `n` / `批准` / `拒绝` | 同意 / 拒绝（工具调用 或 提醒确认卡片） |
| `1` / `2` | 服务重启后看到「上次消息中断」提示时，回 `1` 重发 / `2` 取消（10 分钟内有效） |

## 工具调用人审

当 Claude 尝试调用工具时，阿吉姆会暂停并发送审批卡：

```
🔐 工具调用审批请求
工具：Bash
入参：{"command":"rm -rf node_modules"}
回复 y 批准 / n 拒绝（5 分钟内未操作将自动拒绝）
```

在 IM 回复 `y` / `n`，或在 Web 界面点 Allow / Deny。微信、飞书、钉钉 行为一致。`IMHUB_APPROVAL_DISABLED=1` 可关闭。

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

**三种创建路径**（最终都落到同一个 `~/.agim/reminders.db`）：

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
`~/.agim/config.json`（启动时 zod 校验）：

```json
{
  "messengers": ["wechat-ilink", "feishu"],
  "agents": ["claude-code", "opencode"],
  "defaultAgent": "claude-code",
  "feishu": { "appId": "cli_***", "appSecret": "***" },
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
| `IMHUB_TELEGRAM_COORDS_GCJ02` | 未设 | 设 `1` 对 Telegram 原生位置/venue 消息做 GCJ-02 → WGS-84 转换。默认关（直通），适合 Telegram Desktop / Android-without-China-GMS / 海外用户。如果你的 Telegram 客户端是国内 iOS 设备（Core Location 会加 GCJ 偏移），打开它。 |
| `IMHUB_H5_COORDS_GCJ02` | 未设 | 设 `1` 对 `/memo here` H5 抓 GPS 的坐标做 GCJ-02 → WGS-84 转换。默认关（直通），匹配微信 X5 / Android Chrome 直给 WGS-84 的常见情况。如果你的用户主要在 iOS Safari / iOS WebKit 国内打开 H5 链接（Apple 会加 GCJ 偏移），打开它。完整每平台策略见 [`src/core/coord-systems.ts`](src/core/coord-systems.ts)。 |
| `AGIM_HOME` | 自动 | 用户级配置/数据目录。全新安装默认 `~/.agim/`；从 0.x 升级则自动用现有的 `~/.agim/`。如果想固定到具体位置（多机共享、测试场景），显式设置即可。也认旧的 `IMHUB_HOME`。 |
| `AGIM_WORKSPACES` | 自动 | per-agent 工作区目录。与 `AGIM_HOME` 一样的双探测（优先 `~/.agim-workspaces/`，存在 `~/.agim-workspaces/` 时用它）。也认 `IMHUB_WORKSPACES`。 |

## 架构

```
┌─ IM 入口 ────────────────────────────────────────┐
│ 微信 iLink     （长轮询 + 图片/语音/文件）        │
│ Telegram       （grammy + 图片/语音/音频）        │
│ 飞书           （Lark SDK WebSocket）             │
│ 钉钉           （Stream WebSocket + 服务端 ASR）  │
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
          claude  opencode codex  ACP
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
原生 LLM 栈与「CLI agent / in-process loop 都是 `AgentAdapter` 的 peer」的设计立场，详见 [`docs/architecture-bridge-and-native.md`](docs/architecture-bridge-and-native.md)；nanobot vs agim 比较计划的 PR 落地顺序见 [`docs/nanobot-comparison-rollout.md`](docs/nanobot-comparison-rollout.md)。

## 环境要求

- **Node.js ≥ 18**（推荐 ≥ 22 LTS）
- 至少一个 Agent CLI 或 ACP 端点：
  - `npm i -g @anthropic-ai/claude-code`
  - `npm i -g @openai/codex`
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

systemd、Docker、nginx、监控、管理员管理、备份、升级详见 [`docs/deployment.md`](docs/deployment.md)。长期记忆 + 向量召回的启用 / 调优 / 隐私见 [`docs/memory-and-vector.md`](docs/memory-and-vector.md)。

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
| v0.4.0 | codex 接入完整 imhub MCP 工具表（reminder + memo）；Telegram + 飞书位置消息改走 agent-driven 决策（对齐微信 H5 架构） |
| v0.5.0–0.5.2 | `agim` 双语方向键向导（当时叫 `im-hub-pro`）；按渠道独立配置（微信扫码、飞书 / Telegram / Discord 凭据输入；agent CLI 安装态实时探测）；systemd unit env fallback；完整服务生命周期命令（`status / start --bg / restart / stop / uninstall`） |
| v0.6.0 | 钉钉 Stream 模式适配器——WebSocket 双向桥、图片消息（`messageFiles/download` → claude-code 多模态 Read）、语音消息（钉钉服务端 ASR `recognition`，whisper.cpp 兜底） |
| v0.6.3 | 各平台原生位置消息的坐标系按来源处理（Telegram 改为 WGS 直通；H5 改为 WGS 直通解决微信 X5 的偏移；钉钉 link 中的百度地图 URL 走 BD-09→WGS） |
| **v1.0.0** | 品牌升级为 **Agim · 阿吉姆**。新主命令 `agim`，老命令 `im-hub-pro` 保留为废弃别名。配置目录 / 环境变量 / HTTP 头 / systemd 单元名都保留以兼容 0.x 部署。 |
| v1.1.2–1.1.3 | A2A L1（调用链可视化）+ L2（Agent 之间共享 artifact 池） |
| v1.1.4 | Web 仪表盘双语 + 专业名词 (?) 帮助弹窗 |
| v1.1.6–1.1.8 | IM 长消息 viewer + cloudflared 自动开隧道 |
| v1.1.10 | Web 控制台 token 鉴权（cookie + Bearer + loopback 旁路）；重启消息顺序修复 |
| v1.1.11 | Viewer 暗黑模式可读性修复 |
| **v1.2.0** | **长期记忆**（SQLite + FTS5 + 记忆画像 + 4 个 MCP 工具 + 自动蒸馏 + Web 管理 Tab）；**向量召回**（本地 BGE / OpenAI 兼容、RRF 融合）；**成本与健康仪表盘**；**Agent 主动推送**（`mcp__imhub__push_message`）；带原生内联按钮的崩溃恢复卡片 |
| v1.2.1 | 向量后端重启后自动加载；Memory + Cost tab 中文 i18n |
| v1.2.2 | `agim admin invite` 通过 IM 邀请新管理员；向量后端 boot 时主动 warm；consolidate 改异步（jobId + 轮询） |
| v1.2.27–v1.2.32 | R14/R15 生命周期加固——25s 优雅退出硬截止、端口先释放、reap stray agim 进程、`findAgimProcesses` argv-strict /proc 扫描、每次成功 start 都写 PID 文件、CLI 向导新增 "Web bind+port" 段、ACP 端口 gate（`IMHUB_ENABLE_REMOTE_AGENT`） |
| **v1.3.0** | **nanobot vs agim 比较计划全量落地** —— `native` in-process AgentAdapter（LLM client + agent loop + 外挂 MCP + 策略式审批门，OpenAI/Anthropic 兼容）；`llmBackends` + `llmRoles` + `~/.agim/llm-secrets.json` 配置；`/goal` 会话级长目标（P0 #2）；`/heartbeat` 3 阶段调度（P0 #1）；`mcp__imhub__ask_user` 结构化选择题（P0 #5）；agim Skills 3 层引擎（Stage 3 + P0 #3）；记忆事实行内年龄注释（P0 #4）；`mcp__imhub__push_message` 的通知评估门（P0 #9）；`/router compare` A/B 评测（Stage 5）；`tryIntrospectChain` fallback 助手；Web 后台 `/settings/{llm,mcp,native-agent,agim-skills}` + `/tasks/{heartbeat,goals,asks}` 全新页面；CLI 向导 `agim setup {llm,mcp}` + 诊断 `agim diag {llm,mcp}` + `agim setup llm native-enable` 快捷通道；CLI + Web 所有新增面板的中英 i18n；`acp-token` 与 `web-token` 分离；`agim token bootstrap` 输出器；`gen-endpoints --check` drift guard。详见 [`docs/nanobot-comparison-rollout.md`](docs/nanobot-comparison-rollout.md) |

### 接下来

- [ ] Slack 适配器
- [ ] 钉钉卡片按钮版审批（飞书已完成）
- [ ] 多实例事件总线（Redis Streams / NATS）
- [ ] 工作区成员选择 UI
- [ ] 记忆 consolidation：boot 后 5 分钟先跑一次（当前要等满 24h）

## 社区

<p align="center">
  <a href="https://deepseek.club/community/imhub">
    <img src="https://deepseek.club/assets/logo-DH6LfKkF.png" style="width: 150px; height: auto;" alt="DeepSeek">
  </a>
</p>

## 许可证

MIT
