# Reminders 子系统设计

> 状态：**已实施（2026-05-09）**
> 范围：`/remind` slash + LLM 意图识别 + LLM 投递润色 + agent MCP 工具 + Web 管理页 + 邮件通道
> 关联：`docs/architecture/agent-cwd-and-memory.md`

---

## 一句话

im-hub 的 reminders 是一个轻量"一次性 / 定期"提醒子系统，提供 4 种创建路径，2 种投递增强，3 种 agent 集成，覆盖 IM、Web、邮件三种出口。

```
                ┌──────────────── 创建路径 ────────────────┐
                │                                          │
   /remind ─────┤  F1 LLM 意图识别 (confirmation card)     │
                │                                          │
   F1 confirm ──┤  agent MCP 工具 (claude / opencode)      │
                │                                          │
   Web /api ────┘                                          │
                                                           ▼
                                                   reminders.db
                                                   (SQLite, fail-soft)
                                                           │
                                          5s tick scheduler│
                                                           ▼
                ┌──────────────── 投递增强 ────────────────┐
                │  LLM 润色 (default-on, opt-out via       │
                │  literal subcommand or high-freq guard)  │
                └──────────────────────────────────────────┘
                                                           │
                ┌──────────────── 投递通道 ────────────────┐
                │  IM messengers (wechat/telegram/...)     │
                │  Email (Gmail SMTP via env)              │
                └──────────────────────────────────────────┘
```

---

## 数据模型

`~/.im-hub/reminders.db` (SQLite, WAL, fail-soft via `core/sqlite-helper.ts`)

```sql
CREATE TABLE reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fire_at       TEXT    NOT NULL,                        -- ISO8601
  text          TEXT    NOT NULL,
  platform      TEXT    NOT NULL,                        -- 'wechat'/'email'/...
  channel_id    TEXT    NOT NULL,
  thread_id     TEXT    NOT NULL,                        -- email 时即收件人地址
  user_id       TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'pending',      -- pending|firing|fired|cancelled|failed
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  fired_at      TEXT,
  error         TEXT,
  source        TEXT    NOT NULL DEFAULT 'slash',        -- slash|mcp|api
  parent_id     INTEGER,                                 -- snooze 链
  recurrence    TEXT,                                    -- every:5m / daily:HH:MM / weekly:1,3,5:HH:MM
  last_fired_at TEXT,                                    -- 循环触发时间戳
  prompt_mode   TEXT    NOT NULL DEFAULT 'llm'           -- llm|literal
);

-- 与 reminder 同生命周期的两张辅助表
CREATE TABLE user_email_bindings (
  platform TEXT, user_id TEXT, email TEXT, bound_at TEXT,
  PRIMARY KEY (platform, user_id)
);

CREATE TABLE user_aiwatch_settings (
  platform TEXT, user_id TEXT, enabled INTEGER, set_at TEXT,
  PRIMARY KEY (platform, user_id)
);
```

迁移：`init` 钩子里用 `PRAGMA table_info` 探测列、按需 ALTER ADD COLUMN。
状态机：`pending → firing → (fired | failed) | cancelled`。崩溃恢复：启动时 `firing → pending` 重试。

---

## 创建路径

### 1. `/remind` slash command

`src/core/commands/remind.ts`

支持的子命令组合（前缀可叠加）：

| 子命令 / 前缀 | 例 | 说明 |
|--------------|----|----|
| `<time> <text>` | `/remind 2m 喝水` | 一次性 |
| `每<...> <text>` | `/remind 每天8点 喝水` | 循环 |
| `email [<addr>] <time> <text>` | `/remind email me@x.com 8:00 早安` | 投递到邮箱 |
| `literal <time> <text>` | `/remind literal 每5分钟 喝水` | 关闭 LLM 润色 |
| `list / cancel <id> / clear / snooze <id> <dur>` | | 管理 |
| `bindemail <addr>` / `unbindemail` | | 默认邮箱绑定 |
| `aiwatch on/off` | | 切换 F1 意图识别 |

时间解析：
- 中文时长：`40秒` `2分钟` `半小时` `1小时20分` `1小时半` `0.5天`
- 中文时点：`下午6点` `晚上8点45` `中午12点` `8点起床` (今天/明天最近)
- 中文循环：`每5分钟` `每天早上8点` `每周一三五9点` `每个工作日18点` `每周末10点`
- 英文：`2m` `1h` `1d`、`every 5m`、`HH:MM`、`2026-05-09T20:00`

### 2. F1 LLM 意图识别（`src/core/remind-intent.ts`）

非 slash 消息流入 `cli.ts:handleMessage` 时：

```
  ├─ 1. aiwatch off？跳过
  ├─ 2. 时间词正则预过滤 (省 ~95% 的 LLM 调用)
  ├─ 3. agent-helper 调当前 thread 的 active agent 抽 JSON
  ├─ 4. 置信度 ≥ 0.85 → setPending + 发"要不要为这件事设个提醒？"卡片
  ├─ 5. 用户回 y/yes/是/确认/... → cli.ts pending-reminder handler 创建
  └─ 6. 5 分钟无回复 → TTL 自动失效
```

阈值 0.85（之前 0.7）：B-tier 隐式备忘多数交给 agent MCP 工具兜底。

### 3. Agent MCP 工具（`src/plugins/agents/claude-code/mcp-approval-server.ts`）

4 个工具暴露给 agent：

| Tool | 功能 |
|------|------|
| `mcp__imhub__create_reminder` | 创建一次性 / 循环提醒 |
| `mcp__imhub__list_reminders` | 列出 pending |
| `mcp__imhub__cancel_reminder` | 取消 |
| `mcp__imhub__snooze_reminder` | 延后 |

工具描述里写明"CALL THIS PROACTIVELY whenever the user mentions a future commitment"，让 agent 主动调用。

调用链：
```
  agent calls tool
    → MCP sidecar (mcp-approval-server.js)
    → unix socket → approval-bus
    → reminder-rpc.ts handleReminderOp
    → reminders.ts createReminder/...
    → result back to sidecar → agent
```

### 4. Web `/api/reminders`

简单 REST，Web `/reminders` 页面消费。`web/server.ts` 加了 3 个路由 + 1 个 HTML 页面（`web/public/reminders.html`）。无 per-user 过滤，**单运营者部署专用**。

---

## Agent 集成矩阵

| Agent | Driver | MCP Reminder Tools | Context 路由方式 | 说明 |
|-------|--------|--------------------|----------------|------|
| **claude-code** | subprocess | ✅ | per-spawn `--mcp-config` + IMHUB_RUN_ID env | 标准路径 |
| **opencode (stdio)** | subprocess | ✅ | 全局 `mcp.imhub` config + per-spawn `extraEnv` (IMHUB_RUN_ID) | 同 claude 模式，env 通过 SpawnPlan 注入 |
| **opencode (http)** | shared daemon | ✅ (with caveat) | 全局 `mcp.imhub` config + 共享 `IMHUB_APPROVAL_SOCK` env + **agent-asserted `_im_context`** | 单用户专用；多用户场景 agent 可伪造身份 |
| **codex** | subprocess (`exec --json`) | ❌ | — | `codex exec` 不支持外部 MCP；要支持需切到 `codex mcp-server` 模式（重写 adapter） |

### opencode http 的 single-user 限制

`opencode serve` 是常驻进程，所有 IM session 共享同一 MCP server 实例。MCP server 启动时 env 已固定，没有 per-IM-thread 的 runId。变通：

1. `opencode-http-adapter.ts: buildImContextInstruction` 在每条 prompt 前注入：
   ```
   [im-hub MCP routing — important]
   When you call any imhub tool, you MUST include this exact `_im_context`:
     "_im_context": {"platform":"wechat","threadId":"...","channelId":"...","userId":"..."}
   Pass these values verbatim — do not invent or modify them.
   ```
2. `mcp-approval-server.ts` 工具 schema 接受可选 `_im_context` 字段。
3. `approval-bus.ts:handleReminder` 先尝试 `runId → RunContext`，未命中再用 `_im_context` 兜底（落 `reminder.bus.inline_ctx` info-level 日志做审计）。

**威胁模型：** 恶意/混乱的 agent 可以填别人的 `_im_context` 给别人发提醒。在多用户部署中显著风险，单用户部署可接受。

### context-token 持久化（wechat 专属）

`src/plugins/messengers/wechat/context-store.ts`：iLink Bot API 的 30-min context_token TTL，原本只存内存，重启即丢，导致循环提醒在 wechat 端高概率失败。落 SQLite 后：
- 收消息时写穿（UPSERT）
- 启动时 warm Map
- 内存 miss 时降级查 DB
- 周期性 cleanup 同步清 DB

---

## 投递增强

### F2 LLM 润色（`prompt_mode='llm'`，default）

`src/core/reminders.ts: polishReminderText`

```
  fire 时机到 → fireOne()
    → if prompt_mode='llm':
         agent-helper.callHelperAgent(systemPrompt, userPrompt) [20s timeout]
         成功 → 用润色文本 deliver
         失败/超时/无 agent → fallback 字面文本
    → if prompt_mode='literal': 直接字面 deliver
    → 投递 + reschedule（循环时）
```

System prompt 强约束："**不献媚、不过度幽默、不夸大**"，长度 ≤80 字。

**高频 guard：** `every:Nu` 间隔 < 1h 且 `prompt_mode='llm'` 时，`createReminder` 抛 `ReminderError('high_freq_llm')` 拒绝创建。Agent 调 `create_reminder` 触发同样的高频时，bus 把 reminder 暂存进 `pending-reminder.ts` + 通过 `setReminderConfirmNotifier` 发卡片，返回 `pending_confirmation` 给 agent 让它别多嘴。

### Context snippet 注入（`router.ts: callAgentWithHistory`）

每次进 agent 前，`buildContextSnippet(platform, userId)` 生成 ≤5 条 pending 提醒摘要，前缀拼到 prompt（不污染 history 存储）。让 agent 不用主动 `list_reminders` 就能看到现状。

---

## 投递通道

### IM messengers
通过 `registry.getMessenger(platform)` + `messenger.sendMessage(threadId, text)` 路由。`fireOne` 用 `resolveMessenger()` 做 vendor-agnostic 名称匹配（`wechat` → `wechat-ilink` 等）。

### 邮件（`src/plugins/messengers/email/email-adapter.ts`）

注册为 `email` messenger，`threadId` 即收件人地址。SMTP 配置走 env：

```
IMHUB_SMTP_HOST=smtp.gmail.com
IMHUB_SMTP_PORT=465
IMHUB_SMTP_USER=...
IMHUB_SMTP_PASS=...        # Gmail 用 app-specific password
IMHUB_SMTP_FROM=...        # 缺省 = USER
IMHUB_SMTP_SECURE=auto     # 465 自动 secure，587 用 STARTTLS
```

环境变量缺失时 adapter 仍注册成功（fail-soft），`sendMessage` 抛 "not configured"，提醒投递记 `failed` 而不是 crash。

主题：取首行去 emoji 前缀截 100 字；正文：原文。

---

## 文件清单

### 新增
```
src/core/
  agent-helper.ts          通过 AgentAdapter 调任意已注册 agent 当 LLM helper
  pending-reminder.ts      F1 / 高频确认的内存 5min TTL pending state
  remind-intent.ts         F1 LLM 意图识别 detector
  reminders.ts             核心数据模型 + CRUD + 时间解析 + engine + 邮箱绑定 + aiwatch + context snippet
  reminder-rpc.ts          MCP 工具的 RPC 处理器
  commands/remind.ts       slash command 处理器

src/plugins/messengers/
  email/email-adapter.ts                     邮件 messenger
  wechat/context-store.ts                    wechat context_token 持久化

src/plugins/agents/opencode/
  ensure-mcp-config.ts     启动时把 imhub MCP 写入 opencode 全局配置（idempotent）

src/web/public/reminders.html                Web 管理页

test/unit/                                    7 个单测文件
```

### 修改（关键改动）
```
src/cli.ts                                   消息流水线（approval-reply → pending-reminder reply → F1 detector → agent dispatch）；
                                             启动钩子（reminder engine、ensure opencode mcp）；
                                             notifier wiring；env exposure
src/core/approval-bus.ts                     reminder.* RPC 类型 + _im_context fallback
src/core/router.ts                           context snippet 注入 augmentedPrompt
src/core/types.ts                            ParsedMessage union 加 'remind'
src/core/registry.ts                         注册 email adapter
src/plugins/agents/claude-code/mcp-approval-server.ts   4 reminder tools + _im_context schema
src/plugins/agents/opencode/opencode-stdio-adapter.ts   per-spawn extraEnv (IMHUB_RUN_ID)
src/plugins/agents/opencode/opencode-http-adapter.ts    buildImContextInstruction prompt prefix
src/plugins/messengers/wechat/ilink-adapter.ts          context-store 写穿/warm/cleanup
src/web/server.ts                            /reminders 页面路由 + 3 个 /api/reminders endpoint
package.json                                 nodemailer 依赖
```

---

## 测试覆盖

bun test 通过：1033 pass / 34 skip / 0 new fail（DB 测试在 bun 下跳过，需 node 验证）。

主要新增测试：
- `agent-helper.test.ts` 11 case
- `pending-reminder.test.ts` 6 case
- `remind-intent.test.ts` 8 case（mock agent JSON）
- `reminder-rpc.test.ts` 7+5 case（payload validation + DB-backed）
- `email-adapter.test.ts` 6 case（mock transporter）
- `wechat-context-store.test.ts` 6 case
- `reminders.test.ts` 已扩展测 recurring + LLM polish + 高频 guard + 邮箱绑定 + aiwatch

---

## 已知限制 / 后续

| 项 | 状态 | 备注 |
|----|------|------|
| codex MCP reminder 工具 | 未实施 | `codex exec --json` 不支持外部 MCP；需重写 adapter 走 `codex mcp-server` 模式（~5h） |
| copilot MCP | 未调研 | upstream MCP 支持情况不明 |
| opencode http 多用户安全 | 设计限制 | agent-asserted context 可伪造；多用户部署应用 stdio 或 claude-code |
| `/api/reminders` 多用户 owner-scoping | 设计限制 | 同上，单运营者部署 |
| F1 detector 时区 | 简单方案 | LLM 用 server `toLocaleString()` 做 prompt 时间。多时区部署需扩展 |
| 高频循环 + LLM polish 走卡片但确认机制依赖 IM 文本 reply | 已有 | y/n 文本匹配，没接 native button |
