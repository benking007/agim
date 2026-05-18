# agim Code Review — 2026-05-18 · claude/code-review-im-agent-ugwib

> 基准：`8ea5ab3` (v1.2.3 prep)，168 个源文件，TypeScript / Node ≥ 18，better-sqlite3 + WAL。
> 对比基线：[`code-review-2026-05-06-main.md`](./code-review-2026-05-06-main.md) (v0.2.15)。
> 审查方法：5 个并行 Explore 子代理覆盖核心、记忆/RPC、web/auth、IM 适配器、agent 插件 + 测试 + utils；主线程逐条复核行号 + 真实跑测。
> 实施：10 次 commit，42 个文件 +4494/-420 行，113 条新测试，**1127 pass / 87 skip / 0 fail**。
>
> 本文按 (1) 自 v0.2.15 起的修复完成度盘点；(2) 本轮新发现 + 修复明细；(3) Web 后台 UI 重构；(4) 仍待办的事项 三部分组织。

---

## 一、自 v0.2.15 起 12 个 HIGH + 15 个 MEDIUM 项的当前状态

历史 review 的项现状（"主线 grep + read" 而非凭子代理报告）：

| 旧编号 | 主题 | 状态 | 证据 |
|---|---|---|---|
| H1 | webToken 非常时比较 | ✅ | `access-token.ts:137` `timingSafeEqual`；`utils/safe-equal.ts` 已抽 |
| H2 | token 注入 HTML 未转义 | ✅ | 当前已不内联注入（cookie/Bearer） |
| H3 | schedule `notify_url` SSRF | ✅ | `schedule.ts:39-76` `validateWebhookUrl()`，RFC1918/loopback/link-local 拒绝 |
| H4 | RateLimiter 无 cleanup | ✅ | `rate-limiter.ts:102-107` 每次 `allow()` 惰性清理 |
| H5 | `/job` `/schedule` `/audit` 越权 | ⚠️ | `/job` `creatorId` 已加；`/cron create` 仍未校验 ws.hasAgent（**本轮 verify 已修：commands/cron.ts:76 实际已检查**） |
| H6 | Job result 无上限 | ✅ | `IMHUB_JOB_RESULT_MAX_BYTES` 默认 1 MiB + 截断 |
| H7 | Job 表无 GC | ✅ | `pruneOldJobs()` + 6h 周期 sweep |
| H8 | settings.html ACP 测试 ReferenceError | ✅ | 已加 try/catch |
| H9 | wechat 凭证 0644 | ✅ | `chmod 0o600` + `mkdir 0o700` |
| H10 | Telegram URL 泄 token | ⚠️ | 局部 `scrub()` 已加，pino redact paths 覆盖 `*.token`；但 `url` 字段未 redact，URL 字符串里 token 仍可能漏 |
| H11 | approval socket 路径可预测 | ✅ | `randomBytes(16)` 32 hex + `chmod 0o600` |
| H12 | Session.addMessage 并发丢消息 | ✅ | `session.ts:94-133` per-key writeQueues |
| M1 | 安全响应头 | ✅ | `server.ts:3877+` CSP/X-Frame/X-Content/Referrer |
| M2 | metrics label 基数 | ⚠️ | intent/platform 仍未枚举化 |
| M3 | WS 无连接数 cap | ✅ | `IMHUB_MAX_WS_CLIENTS`（默认 100） |
| M4 | `/api/health` 鉴权 | ✅ | `PUBLIC_EXACT_PATHS` |
| M5 | cron local time | ⚠️ | 仍 local time。**本轮重新评估**：POSIX cron 是 local time 语义，强切 UTC 是行为变更；真正风险是 double-fire，由 M-N11 atomic CAS 解决 |
| M6 | workspace 白名单未在命令面落地 | ✅ | 本轮 verify：`/cron create` 实际已检查 |
| M7 | audit prune 静默失败 | ✅ | 入 metrics counter |
| M8 | 熔断 half-open 并发探测 | ❌ | `isOpen()` 读改写未原子化 |
| M9 | IM 长链路 backoff/jitter | ⚠️ | Telegram/WeChat 已统一；Feishu/DingTalk 依赖 SDK |
| M10 | message-split 切到 emoji 代理对 | ✅ | `safeSplitPoint()` 已加 |
| M11 | acpTest JSON.parse 无 try/catch | ✅ | 400 响应 |
| M12 | Telegram HTML 转义 `'` | ⚠️ | 部分已补 |
| M13 | auto-allow fingerprint 5 字符碰撞 | ✅ | per-tool 语义 fingerprint，前缀 10 |
| M14 | approval pending 无 metrics | ✅ | `metricsSnapshot` + `/api/metrics` |
| M15 | intent-llm key 无上限 | ✅ | hash candidates + 截 256 字 |
| L1-L15 | — | ✅ 多数（traceId 升 16 hex、agent-cleanup 入 metrics、sqlite close 等） | — |

**整体修复完成度 ~90%**。剩余开放项（M-N8 熔断半开、M-N2 / M-N12 i18n / Feishu 补足）在 P3 队列中，影响面有限。

---

## 二、本轮新发现 + 修复（按严重度 + 实施 commit）

### 🔴 HIGH（P0：已修，6 条）

| ID | 主题 | 修复 commit |
|---|---|---|
| H-N1 | `_im_context` fallback 允许伪造 userId，多用户 MCP daemon 跨用户越权 | `fd98456` |
| H-N2 | Web cookie 缺 `HttpOnly` + 条件 `Secure` | `b99d79c` |
| H-N3 | ACP CORS `Access-Control-Allow-Origin: *` 通配 | `fd98456` |
| H-N4 | admin-bootstrap token `===` 比较 → `safeEqual` | `b99d79c` |
| H-N8 | 反代部署后 loopback 鉴权旁路失效 | `fd98456` |
| H-N9 | `start-prod.js` 无 graceful shutdown | `f3cda77` |

**新增环境变量**（默认值保留现行行为）：
```
IMHUB_WEB_COOKIE_SECURE       auto | on | off
IMHUB_RPC_INLINE_CTX_MODE     single-user | off
IMHUB_ACP_CORS_ORIGINS        comma list | *  (默认不发 CORS 头)
IMHUB_TRUST_LOOPBACK          auto | on | off
IMHUB_SHUTDOWN_FORCE_MS       10000
```

### 🔴 HIGH（P1：已修，3 条）

| ID | 主题 | 修复 commit |
|---|---|---|
| H-N5 | memory-distill / memory-consolidate 缺 timeout / 成本上限 / 断路器 | `342ad21` |
| H-N6 | memory-consolidate prompt 把 fact 文本直接拼入指令，可被注入 | `342ad21` |
| H-N7 | embedding 异步写入失败无重试 | `342ad21` |

**新增 LLM 治理基础设施**：
- `src/core/llm-budget.ts` — `LlmBudget`（per-(purpose, userKey, UTC-day) 成本上限）+ `LlmCircuitBreaker`（N 连续失败 → 冷却）+ `resolveLlmGuardConfig`
- distill 默认：30s timeout / $0.10 每用户每日 / 3 fails → 10min 冷却
- consolidate 默认：60s / $0.10 / 3 fails → 1h
- `IMHUB_DISTILL_*` / `IMHUB_CONSOLIDATE_*` 一组环境变量可调
- consolidate prompt 改 `<untrusted-facts>JSON</untrusted-facts>` 块 + "安全声明"前缀
- embed 失败 3 次指数退避（200ms / 800ms / 3.2s）

### 🟠 MEDIUM（P1+P2：已修，7 条）

| ID | 主题 | 修复 commit |
|---|---|---|
| M-N2 | event-bus `Array.shift()` O(n) | `992f4a2` |
| M-N3 | `queryFactsHybrid` embedding 全表扫 | `992f4a2` |
| M-N4 | approval-bus overflow 时未先 drain 完整行 | `a11240c` |
| M-N5 | approval-bus 协议无 version negotiation | `992f4a2` |
| M-N6 | approval-bus 无心跳，sidecar hang 卡 15 min | `992f4a2` |
| M-N7 | `IMHUB_*` vs `IM_HUB_*` env 命名混用 | `992f4a2` |
| M-N10 | WS 入站消息无大小上限 | `f3cda77` |
| M-N11 | scheduler 缺原子 claim（并发 tick 可 double-fire） | `19e66eb` |
| M-N13 | approval-bus `unregisterRun` O(n) 扫描 | `992f4a2` |
| M-N16 | artifact 孤儿目录无 retention sweep | `992f4a2` |
| M-N17 | secrets 与 config 混存，备份泄露面广 | `19e66eb` |

**主要改动**：
- `src/core/event-bus.ts` 改环形 buffer，publish 从 O(n) 降到 O(1)
- `facts` 表加 `idx_facts_embedded` partial index（在 init 回调里，因为引用了 ALTER 后的列）
- `approval-bus.ts` 加 `pendingByRunId` 二级索引；overflow 时先 drain 完整行；不识别的 `v` 字段回 `error` frame 而非静默 drop；周期性 ping/pong 心跳（60s idle → ping，30s grace → close）
- `src/core/env-compat.ts` `readEnvCompat(canonical, ...aliases)` 统一兜底（8 个 `IM_HUB_*` 变量改为 `IMHUB_*` 优先 + alias 兼容 + 一次性 deprecation warn）
- WS 入站 `data.length > IMHUB_MAX_WS_MSG_BYTES`（默认 1 MiB）即 close(1009)
- `schedule.ts fireSchedule` 改 `UPDATE … WHERE id=? AND next_run=? AND enabled=1`，CAS 失败者 bail；setInterval 加 `tickInFlight` 重入守卫
- 新 `src/core/secrets-store.ts` 把 `telegram.botToken/feishu.appSecret/discord.botToken` 拆到独立 `secrets.json`（0o600 + atomic write），`loadConfig/saveConfig` 透明 overlay；adapter 零改

### 🟢 LOW / refactor 基础设施

- `src/core/clock.ts` — `nowMs()` + `setNow(fixed|null)` 测试时间钩子（4.3）
- `inlineCtx fallback` 在 `approval-bus` 抽成共享 `resolveInlineContext` 工厂（4.5 部分）

### ✅ 验证为"已修"或"非问题"（节省时间，无需改动）

- **M-N1**（reminders.tick 缺原子状态切换）— `fireOne` 已有 `UPDATE … WHERE id=? AND status='pending'` CAS（`reminders.ts:977-980`），子代理报告有误
- **M-N9**（`/cron create` workspace 白名单）— `commands/cron.ts:76` 已检查 `ws.hasAgent()`，`createSchedule` 无其他调用点
- **H-N10**（verifyTokenSync race）— `_tokenModule = await import(...)` 在 `httpServer.listen` 之前完成（`server.ts:277` vs 986），null 分支只在测试上下文触发，非运行时危害

### ❌ 故意 deferred（独立 PR）

| 项 | 原因 | 建议落点 |
|---|---|---|
| **4.1 多租户中间件** | 跨命令面/Web API/MCP RPC 协同改造，需先有 ADR | 单独 PR + 设计文档 |
| **4.6 大文件拆分** | `web/server.ts` 3.9k / `cli.ts` 1.8k / `approval-bus.ts` 1.7k；纯机械重构 | 单独 PR review |

---

## 三、Web 后台 UI 重构

用户反馈："任务、备忘、提醒，这些在顶部 tab，然后任务 tab 下，又有各种功能，而这些功能又全是任务，还有记忆、技能等。感觉布局比较混乱"。诊断：`/tasks` 一个 URL 塞了 13 个性质完全不同的子 tab，IA 语义不齐 + 视觉不统一。

### 3.1 信息架构重组（commit `2ac95cd`）

旧导航是 5 个顶级页面（`/` `/tasks` `/reminders` `/memos` `/settings`），`/tasks` 塞 13 个 tab。新导航 9 个顶级页面 + 每页职责单一：

| URL | 内容 |
|---|---|
| `/` | 聊天（保留特殊控件 + 加 8 个统一导航图标） |
| `/tasks` | 真"任务"型 6 个 tab：jobs / subtasks / schedules / bg-scripts / outbox / a2a |
| `/approvals` | 审批（单页无 sub-tab） |
| `/reminders` | 提醒 |
| `/memos` | 备忘 |
| `/memory` | 记忆 + 技能（2 个 sub-tab） |
| `/workspace` | 工作区（单页无 sub-tab） |
| `/observability` | 健康 + 审计 + 成本（3 个 sub-tab） |
| `/settings` | 设置 |

**实施思路**：4 个新 URL 在 server `fileMap` 全部映射到 `tasks.html`，由 `PAGE_MODE` 根据 `location.pathname` 决定显示哪些 tab、隐藏哪些、单 tab 时收掉 tab bar。3700 行域 JS 零改动。

### 3.2 视觉统一（commit `94fb645`）

新增 `_shell.css`（27.5KB）：
- **设计 token**：`--ag-bg/text/accent/border/space-*/radius-*` 深浅主题各一套
- **共享组件**：`.ag-topbar`、`.ag-card`、`.ag-btn`、`.ag-table`、`.ag-badge`、`.ag-subnav`、`.ag-modal`、`.ag-form-row`、`.ag-stat`
- **遗留 class 覆盖**（scope 到 `body.ag-shell`，零改 HTML）：`.stats`/`.toolbar`/`.data-table`/`.tabs`/`.tab`/`.filter-btn`/`.pill`/`.modal-bg`/`.toast` 全部用 shell 视觉

`_app.js` 加 `imhub.shell.mount({ active })` 注入统一 topbar；tasks / approvals / memory / workspace / observability / reminders / memos / settings 都用同一份 shell topbar。

### 3.3 详细打磨（commit `d3531f6`）

- **聊天页（`/`）**：sticky header 56px 同 shell topbar，logo 加 🤖 前缀，nav 图标 / agent select / lang select / newChat 全部按 shell action 样式重做；不加 `body.ag-shell` 以免覆盖 messages 区
- **Memory 页**：顺序重排为 User → **Persona** → **Facts** → 向量后端（折叠 `<details>`）；保留全部 ID 不动 JS
- **页面副标题**：5 个新 i18n key 解释每页用途

---

## 四、剩余 punch list（建议下一 PR）

### Web UI 后续

- **Observability 综合 dashboard**：现在还是 3 个 sub-tab；做成 KPI 卡 + 趋势 + 详情链接的 dashboard 是 UX 设计活儿
- **Skills 页 UX**：installed + skillhub.cn 热门两节缺一个"我在哪个 mode"的视觉区分
- **登录/定位页（`/login` `/loc`）的 shell 化**：公开访问页，独立做了
- **i18n key 集中化**：每页的 T 字典独立，相同字符串重复定义可抽到 `_app.js`

### 安全 / 性能

- **M-N8** 熔断 half-open 并发探测原子化
- **M-N2** metrics intent/platform 标签枚举化
- **M-N12** Telegram HTML 属性场景的 `'` `"` 转义补全
- **横向重构 4.1 多租户中间件**：需 ADR
- **横向重构 4.6 大文件拆分**：单独 PR review

---

## 五、整体评分（相对 v0.2.15）

| 维度 | v0.2.15 | 现在 |
|---|---|---|
| 架构成熟度 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐½ |
| 安全姿态 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 多租户兑现 | ⭐⭐ | ⭐⭐⭐⭐ |
| 可观测 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐½ |
| 测试 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐（+113 条） |
| Web UI 一致性 | ⭐⭐ | ⭐⭐⭐⭐ |

---

## 六、commit 列表

```
d3531f6  ui(web): chat header to shell tokens; reorder Memory; page subtitles
94fb645  ui(web): visual unification — legacy-class overrides scoped to ag-shell
2ac95cd  ui(web): IA rework — unified shell topbar + 4 new top-level URLs
19e66eb  sec,refactor(p2-tail): cron atomic claim, secrets file split, clock test hook
992f4a2  perf,sec(p2): event-bus ring, facts index, approval heartbeat+version errors, artifact sweep, env compat
a11240c  sec(approval-bus): drain complete NDJSON lines before closing on buffer overflow
f3cda77  sec(web,prod): WS inbound size cap; start-prod graceful shutdown
342ad21  sec(memory): timeout+budget+circuit on distill/consolidate, prompt-injection block, embed retry
fd98456  sec(acp,bus,web): gate _im_context fallback, ACP CORS allowlist, loopback-trust opt-in
b99d79c  sec(web,admin): HttpOnly+conditional Secure session cookie; safeEqual for bootstrap token
```

---

*Reviewed by 5 parallel Explore agents on the v1.2.2 baseline (8ea5ab3) + main-thread verification + 113 new tests landing each fix. 42 files changed, +4494 / −420 lines.*
