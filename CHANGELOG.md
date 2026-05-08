# Changelog

All notable changes to this project will be documented in this file.

## [0.2.26] - 2026-05-08

### Changed — Rebrand to `im-hub-pro`

- **npm 包名**：`im-hub` → `im-hub-pro`（产品化分支）。
- **CLI 命令**：`im-hub` → `im-hub-pro`（`bin` 字段同步更新）。
- **仓库 URL**：`package.json.repository.url` 从原作者 `ceociocto/im-hub` 切到当前仓库 `benking007/imhub`，新增 `homepage` / `bugs` / `publishConfig{access:public,provenance:true}` 字段。
- **Web 控制台品牌**：`/`、`/tasks`、`/settings` 三个静态页的浏览器标题、欢迎语、左上角 logo、Settings 卡里的 `im-hub config wechat` 提示文案，全部改为 `im-hub-pro`。
- **README + README.zh-CN**：`What's new` / 安装命令 / Quick Start / CLI 命令表 / Project Structure ASCII 树标签，全部改为新品牌；新增「Migrating from `im-hub`」回退指引。
- **LICENSE 文件**：补齐 MIT 全文（之前 `package.json` 声明 MIT 但根目录无 LICENSE 文件），版权归属保持 `Jerry`。
- **`THEME_KEY`**：localStorage 主题 key 从 `im-hub-theme` → `im-hub-pro-theme`（用户在升级后第一次访问会丢失主题偏好；其他 localStorage key `im-hub-lang` / `im-hub-history` 保留以保住语言与对话历史）。

### Unchanged — drop-in compat

为了让老用户 `npm uninstall -g im-hub && npm install -g im-hub-pro` 后零迁移成本运行：
- **配置目录**：`~/.im-hub/`、`~/.im-hub-workspaces/<agent>/` 路径不变
- **环境变量**：60+ 处 `IMHUB_*` 前缀不变
- **HTTP 头**：`X-IM-Hub-Token` / `x-im-hub-token` 不变
- **Window 全局**：`window.IMHUB_TOKEN` 不变
- **ACP 服务名**：`im-hub-gateway` 不变（线上 ACP 客户端通过这个名字 discover）
- **MCP 测试 fixture**：`mcpServers.imhub` 不变
- **内部 client ID**：`im-hub:${ts}` 格式不变

### Notes

- 发布走 npm OIDC trusted publishing（`release.yml` 不需要改），首次发布前需在 npmjs.com 上为 `im-hub-pro` 配置 trusted publisher 指向 `benking007/imhub` 仓库 + `release.yml` workflow。
- 老 `im-hub@0.2.25` 包在 npmjs.com 上保持不动，可继续安装。

---

## [0.2.23] - 2026-05-07

### Added — Web console PR-D
- **Agent workspace 文件浏览器**：`/tasks` 新增 **Files** tab，只读浏览 `~/.im-hub-workspaces/<agent>/`（CLAUDE.md / AGENTS.md / 临时笔记等）。左侧目录树 + 右侧文件预览，点目录进入、点文件预览，文件 1 MiB 上限 + 二进制（首 8 KB NUL 探测）走 base64。后端 `GET /api/workspace-files?agent=&path=` 双重防 traversal：agent 必须在 `registry.listAgents()` 白名单，路径必须等于或位于 `defaultAgentCwd(agent)` base 之下，否则 400。
- **Job 批量操作**：Jobs tab 加多选 checkbox + 全选表头 + 隐藏式批量工具栏（Run selected / Cancel selected）；选中态跨刷新保留——按可见行 reconcile，不会被 list mutation 抹掉。后端新 `POST /api/jobs/batch-cancel` / `batch-run` 接受 `{ ids: number[] }`（最多 100），per-id 结果不互相阻断。

### Changed
- **Settings 页布局**：header 用 `justify-content: space-between` + 4 个独立 flex 子项导致语言 `<select>` 被拉伸成满屏宽，标题/链接全部换行。重写为 `.brand`（左侧链接 + 标题）+ `.controls`（右侧 lang/theme，`margin-left: auto`）双分组，控件 `width: auto` + `white-space: nowrap`。容器 max-width 720→880，标题字号字距微调，卡片圆角 8→12 + 浅色态加 1px 阴影，header sticky。
- **修复主题污染**：toast `.success` / `.error` 和 `.btn-danger:hover` 之前用了硬编码深色背景（`#0a2a0a` / `#2a2a0a` / `#1a0a0a`），浅色主题下渲染成近黑色，已改为主题变量。

## [0.2.22] - 2026-05-07

### Added — Web console PR-C
- **SSE 实时事件流**：新建 `src/core/event-bus.ts`——进程内 publish/subscribe，4 类事件（`audit` / `approval` / `job` / `metrics`），200 条 ring buffer。新连接 replay 一次避免空白等待。
- **`GET /events` 端点**：token 走 `?token=...`（EventSource 不支持自定义 header），25s 心跳防 nginx idle close，listener 错误在 `publish()` 内吞掉避免拖坏起源动作。
- **Dashboard 实时刷新**：`tasks.html` 用 `EventSource('/events?token=...')`，事件触发 `refreshIfVisible(paneId, loader)` 只刷可见 tab；轮询保留作为 fallback。`approval requested` 事件让 Approvals tab 标签闪一下高亮（动态注入的 CSS keyframe）。
- **Workspace 完整 CRUD UI**：`settings.html` 新增 Workspaces 卡片，列表 + 新增 / 编辑 / 删除表单（id 锁定防误改、default 行不可删）。后端 `GET /api/workspaces?full=1` / `POST` upsert / `PATCH /:id` / `DELETE /:id`，每次 mutation persist 回 `~/.im-hub/config.json`。
- `WorkspaceRegistry.remove(id)` 拒绝 `'default'`，`listFull()` 返回完整 `WorkspaceConfig[]`（含 member ids）。

## [0.2.21] - 2026-05-07

### Added — Web console PR-B
- **Health tab**：`/tasks` 新增 Agent 健康面板，每个 agent 一行展示熔断器状态（closed / open / half-open）、限流余量、p50/p95/p99 延迟、调用次数 / 成功率 / 累计成本、半开冷却。最近 60 次轮询的 p95 延迟用内联 SVG sparkline 画出。
- **Approvals tab**：列出所有 pending HITL 审批（reqId / threadId / toolName / 等待时长 / 注册时间），支持网页端直接 Allow / Deny / Allow + Auto。后端新 3 路由：`GET /api/agent-health` / `GET /api/approvals` / `POST /api/approvals/:reqId/resolve`。
- `approval-bus.PendingApproval` 增 `input`（原始入参）+ `registeredAt`，`listPending()` 返回脱敏快照；register / cancel 时 emit `'approval'` 事件，给 SSE 用。

## [0.2.20] - 2026-05-07

### Added — Web console PR-A
- **三态主题**：light / dark / system 三档循环切换，按钮在 head 加载完前同步应用 `:root[data-theme]`，避免主题闪烁。`prefers-color-scheme: dark` 仅在 `data-theme` 缺失（system 模式）时生效。语言 + 主题偏好都落在 localStorage。
- **错误边界**：新建 `src/web/public/_app.js`——`window.imhub` 命名空间提供 `theme` / `i18n` / `api` / `showError`，自动安装 `window.onerror` + `unhandledrejection` 监听，让脚本错误以浮层形式可见，不再静默死掉。
- **In-chat 审批卡**：`/` 聊天界面收到工具审批请求时弹出 inline 卡片（Allow / Deny / Allow + Auto），点击通过 WS `approval-action` 走回 `approvalBus.resolvePending()`，跟 Telegram inline-button 同一条路径。
- `approval-router` 默认 `buttonCallbackPlatforms` 加 `'discord'` / `'web'`；新导出 `bindButtonHandlerForPlatform(platform)` 给延迟注册的 messenger（web 是其中之一）调用，避免 install-before-register 时序问题。

### Fixed
- `tasks.html` 第二段 `<script>` 顶层 `const T` 与第一段 IIFE 外的 `const T` 冲突（"Identifier 'T' has already been declared"）。把首段包进 IIFE 隔离作用域。
- WS `approval-action` 处理路径增日志（每次点击的 receipt + handler-bound 状态），handler 未绑定 / 处理失败时把"approval handler not bound" / "click failed"以聊天错误提示给用户；客户端用 soft-disable，避免服务端报错时按钮卡死。

## [0.2.19] - 2026-05-07

### Added
- **Codex sandbox-mode plan 支持**：codex 接入 `session.planMode`，默认 sandbox 从 `--full-auto` 改为显式的 `-s workspace-write`，关闭 auto-approval。
- **Dashboard agent 过滤 + Audit tab**：Jobs / Subtasks / Schedules 三个 tab 加 agent 下拉过滤（之前看得到但分不清归属），新增 Audit tab 把 SQLite 审计日志拉到 UI（之前只有 IM `/audit` 命令）。后端配套 `OwnerOpts.agent?` 字段下沉到 `listJobs` / `listSchedules` / `listAllSubtasks`，新 `GET /api/audit?agent=&days=&user=&intent=`。

### Docs
- README "What's new" + Roadmap 补到 v0.2.18。

---

## [0.2.18] - 2026-05-07

### Fixed
- **M9 — IM 重连退避**：`src/utils/backoff.ts` 新增 `Backoff` 助手（指数 + ±jitter，参数自钳位，RNG 可注入做确定性测试）。
  - **Telegram** `runPollingLoop`：两个 fixed `setTimeout(2000)` / `setTimeout(5000)` → `Backoff(2_000, 60_000, 0.5)`；新增 `HEALTHY_RUN_THRESHOLD_MS=30_000`，`bot.start()` 跑健康 ≥ 30s 后再失败会重置 backoff，避免长会话第一次错被推到累计尾端。日志带 `attempt` + `delayMs`。
  - **WeChat ilink** `pollLoop`：inline `1000 * Math.pow(2, n-1)` → `Backoff(2_000, 30_000, 0.5)`；保留首次失败"零等待"（`consecutiveFailures > 1` 才生效）；`getUpdates` 成功路径加 `backoff.reset()`。

### Notes
- Feishu (Lark SDK) / Discord (discord.js) 的 WebSocket 重连在 SDK 内部，没有 app 层注入点，本次未改。
- WeChat `tryRefreshSession` 的两次线性 `attempt*5000` 保留原状（套 Backoff 反而扭曲）。

### Tests
- `test/unit/backoff.test.ts` 新建 10 用例：指数调度 / cap / reset / pinned RNG 下 jitter 边界 / 200 随机样本落 `[exp*0.5, exp*1.5]` / 默认值 / `baseMs=0` 边界 / `capMs<baseMs` 自纠正。

---

## [0.2.17] - 2026-05-07

收尾 P2 + P3，配 `docs/code-review-2026-05-06-main.md` 的 punch list。

### Fixed — P2 web/HTTP hardening
- **M1** 静态页响应头：`X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` / Content-Type 加 `charset=utf-8` / CSP 锁第三方资源（`script-src` / `style-src` 暂留 `'unsafe-inline'`，nonce 化留 P3）。
- **M2** Prometheus 标签基数白名单：`KNOWN_INTENTS = {default,explicit,fallback,llm,topic,keyword,sticky}`、`KNOWN_PLATFORMS = {telegram,feishu,wechat,discord,web,acp,acp-server,rest,rest-msg}`，命中外的桶到 `'other'`。
- **M3** WS 连接上限：默认 100，env `IMHUB_MAX_WS_CLIENTS` 覆盖；超限时 `1013 Try Again Later`。
- **M4** `/api/health` 改为 token gate 之前公开（k8s liveness 友好）。
- **M11** ACP 测试入口的 `JSON.parse` 包 `try/catch` + endpoint 类型校验，错误 body 落 400 而非 500。

### Fixed — P2 observability
- **M7** audit 30 天修剪失败暴露 `im_hub_audit_prune_failed_total` counter。
- **M14** approval-bus 五个生命周期 counter（`pending` / `requests_total` / `resolved_total{result=allow|deny|timeout}`），lazy provider 注入避免循环依赖。
- **M15** intent-llm cache key：候选列表用 sha256 16-hex，prompt 截断到 256 字符，防 100KB prompt × 多 ACP 候选爆 LRU。
- **bug-fix**：approval result 三类桶做成互斥（timeout / deny / allow），原本 timeout-deny 双计可能让 Prom counter 倒退。

### Fixed — P2 IM 文本边界
- **M10** `splitMessage` 强制 `maxLength` 切分加 `safeSplitPoint`，避免切到 UTF-16 surrogate pair（emoji 半切渲染成 `□`，或破坏 Telegram HTML 解析）。
- **M12** Telegram `escapeHtml` 补 `'` / `"` —— approval card 模板里的 `<a href="...">` 属性场景必要。
- **M13** approval auto-allow 前缀指纹 5 → 10：原来 `git s` 同时匹配 `git status`/`git stash`/`git submodule`，太宽。

### Fixed — P3 low-priority (10 L items)
- **L1** WS chunk 循环检查 `bufferedAmount`（4 MiB highwater，50 ms poll，5 s 预算）。
- **L2** SIGINT 关停链接通 `helper.close()` / `closeAuditDb` / `closeJobBoardDb` / `closeScheduleDb`，WAL 清洁 checkpoint。
- **L5** `traceId` 12 hex (~2^48) → 16 hex (~2^64)。
- **L6** WeChat ilink-client 4 处遗漏的 `fetch` 加 `AbortSignal.timeout()`。
- **L7** Discord adapter `typingIntervals` 配 `AbortController`，`stop()` 先 abort 再 `clearInterval`，避免与 `client.destroy()` 竞速。
- **L10** approval-bus buffer 溢出改为写 `{v:1,type:"fatal"}` + `socket.end()`，不再静默 destroy。
- **L12** `classifyIntent` 失败日志带 `err.message` + stack。
- **L13** 新增 `im_hub_agent_cleanup_failed_total` counter，`plan.cleanup()` catch 计数。
- **L14** WeChat ilink `cleanupExpiredContextTokens` 搭 1/min 心跳 tick —— 静默用户不再留 30 min 残余。
- **L15** onboarding `perAgentCache` 注释对齐实际查询顺序。

### Build / infra
- `dist/cli.js` 编译后 `chmod +x`（534fb55）。
- `package-lock.json` 94 处 `resolved` URL 由 Tencent 内网镜像改回 `https://registry.npmjs.org/`（content-addressed integrity 一致），CI 解锁。
- `session.ts atomicWrite` 加 ENOENT defense（`mkdir` + 重试一次）；同步修了 `session-subtasks.test.ts` 在 fresh runner 上的 0 vs 2 翻车。

### Skipped from CR (理由记 PR body)
- L3 / L4 / L8 / L9 / L11：false positive 或纯 cosmetic 或过度侵入。

---

## [0.2.16] - 2026-05-06

P0 + P1 安全收口，配 `docs/code-review-2026-05-06-main.md`。

### Fixed — P0 hotfix
- **H1** Web REST/WS token 比较切到 `crypto.timingSafeEqual`，抽 `src/utils/safe-equal.ts` 与 `acp-server.ts` 共用。
- **H2** `serveIndexHtml` 用 `JSON.stringify(token)` 注入 `window.IMHUB_TOKEN`，防 token 含 `'` / `</script>` 破坏 JS 字面量。
- **H3** Schedule `notify_url` SSRF 防护：`validateWebhookUrl` 白名单 `http(s)`、黑名单 RFC1918 / loopback / link-local / CGNAT / IPv6 ULA / fe80::；`IMHUB_ALLOW_PRIVATE_WEBHOOKS=1` 显式 opt-in；fetch 加 10s `AbortSignal` + `redirect: 'manual'` + 64 KiB 响应上限；`createSchedule` 与 `fireSchedule` 双层校验。
- **H8** `settings.html` ACP 测试按钮：原代码 `const res` 重复声明 + 引用未定义 `endpoint`/`auth`，整页脚本 SyntaxError，功能必坏。改读 `agent.endpoint` / `agent.auth`。
- **H10** Telegram bot token 不再随错误日志泄露：`logger.ts` 加 `redact.paths`（`*.token` / `*.botToken` / `*.apiKey` / `headers.authorization` / `x-im-hub-token` 等）；图片 / 语音下载 catch 路径用本地 `scrub()` 把 token 字面量替换 `[REDACTED]`，覆盖 curl stderr 带回 URL 的场景。

### Fixed — P1 runtime hardening
- **H4** `RateLimiter` bucket 无界：`allow()` 内置 `maybeSweep`，每 30 min 机会式触发 cleanup（不引入 `setInterval` timer）；新增 `size()` 诊断访问器。
- **H6** Job result 大小：`resolveMaxResultBytes()` 默认 1 MiB，env `IMHUB_JOB_RESULT_MAX_BYTES` 覆盖；超过 cap 整 chunk 丢弃（边界落在 UTF-8/JSON 事件分隔上），尾部拼 truncation footer，落 warn `event: 'job.result.truncated'`。
- **H9** WeChat 凭证文件权限：`saveCredentials` 用 `mkdir(.., {mode:0o700})` + `writeFile(.., {mode:0o600})`；`loadCredentials` 读时 `stat`，松权落 warn 提示用户 `chmod 600`（不主动改老文件）。
- **H11** Approval socket 路径熵 + 权限：`defaultSocketPath` 改用 `randomBytes(16).toString('hex')`（128 位熵），listen 后 `chmod 0o600` + `stat` 验证；防同主机非特权用户预占 socket 的 TOCTOU。
- **H12** `Session.addMessage` 并发：`SessionManager` 加 `writeQueues<key, Promise>` + `withLock<T>(key, fn)`，per-key 串行化 RMW，跨 thread 仍并行。

### Fixed — P1 multi-tenant ACL
- **H5** `/job` `/schedule` `/audit` 命令补 owner 隔离：`jobs` / `schedules` 表加 `creator_id` / `workspace_id`（幂等 `ALTER TABLE`，老库无痛升级）；`createJob` / `createSchedule` 接 `{ creatorId, workspaceId }` 由 handler 注入；查询/取消/删/启停加 `OwnerOpts`，`creator_id = ? OR creator_id = ''`（老库 `''` 对所有 owner 可见，避免升级当天列表看似消失）；`/audit user=<other>` 强制 overwrite 到 `ctx.userId`，结果末尾追加忽略提示。
- **H7** Job 表 retention：`resolveRetentionDays()` 默认 30 天，env `IM_HUB_JOB_RETENTION_DAYS` 覆盖；`pruneOldJobs()` 删 `completed`/`failed`/`cancelled` 超期行，`pending`/`running` 永不修剪；启动跑一次 + 每 6h `setInterval(..unref())`；新增 `idx_jobs_created` / `idx_jobs_creator` / `idx_jobs_status_created` 索引。
- **M6** Workspace 白名单从路由层下沉到命令层：`/job create <agent>` 与 `/schedule create <agent>` 在 `createJob` / `createSchedule` 之前调 `workspaceRegistry.resolve(ctx.userId).hasAgent(agent.name)`。

### Tests
- `test/unit/schedule-webhook.test.ts` 新增 22 用例锁定 SSRF 防护行为。
- `test/unit/rate-limiter.test.ts` +4 用例：size 计数、强制清空、刚活跃 bucket spare、连续 allow 不误触发 sweep。
- `test/unit/session-real.test.ts` +1 用例：50 个并发 `addMessage` 同 key，JSONL 行数与 in-memory messages 严格 = N，content 集合无丢失。

### Notes
- 历史 `/job list`（无 `ctx.userId` 注入）仍能看全部，REST `/api/jobs` 同。
- 历史调用方（无 `OwnerOpts`）TS 仍可编译通过。
- M5（cron 时钟跳变）经复核当前 `dueSchedules → fireSchedule` 路径不会双触发，留到后续 UTC 重构一并处理。

---

## [0.2.15] - 2026-05-01

### Added
- **Discord messenger adapter** — full IM bridge for Discord (Gateway WebSocket via `discord.js`)
  - `im-hub config discord` interactive setup wizard
  - Typing indicator (10s TTL, 8s refresh)
  - Markdown → Discord-flavored format conversion
  - Guild / Channel whitelist filtering
  - Setup guide: [`docs/discord-setup.md`](docs/discord-setup.md)
- **Tasks dashboard upgrades** — `/tasks` page now surfaces background work
  - **Background tab**: lists `~/.claude/bgjobs` + `~/.config/opencode/bgjobs` jobs (override via `IMHUB_BGJOB_ROOTS`); per-root selector, 5s auto-refresh, detail modal with `cmd` / `workdir` / `log_tail`
  - **Subtasks tab**: flattens every subtask in every session file, with parent platform / threadId / agent attached
  - Bilingual labels (EN + ZH)
- **REST endpoints (read-only)**:
  - `GET /api/bgjobs[?root=ID]` / `GET /api/bgjobs/:id[?root=ID&tail=N]`
  - `GET /api/subtasks`

### Changed
- Web Chat / Tasks `index.html` served with `Cache-Control: no-cache, must-revalidate` so dashboard updates land without a hard refresh.
- **Feishu adapter** dedupes `message_id` in a 10-min TTL set — WebSocket long-poll was replaying the same event on reconnect and double-firing Claude runs.

### Tests
- 26 new tests: bgjob-reader (15), session subtasks (2), web server integration (9)
- Discord adapter: mock-client driven offline e2e (sendMessage, messageCreate, whitelist / bot filtering, message splitting)
- IM approval ↔ Discord end-to-end loop (sidecar → ApprovalBus → approval-router → Discord channel → reply → decision back)

---

## [0.2.14] - 2026-05-01

### Added
- **Human-in-the-loop tool approval** for IM-launched Claude runs.
  - Replaces the legacy `--permission-mode dontAsk + blanket-allow PreToolUse hook` shortcut with a real approval flow over IM.
  - Architecture:
    ```
    claude --permission-prompt-tool mcp__imhub__request --mcp-config <tmp>
       └─> MCP sidecar (mcp-approval-server.ts)  ── unix socket ──>  im-hub
                                                                       └─> approval-bus
                                                                             └─> approval-router → messenger.sendMessage
                                                                                   ↑
                                       user replies y / n / 批准 / 拒绝 in the same IM thread
    ```
  - cli intercepts approval replies *before* the agent router; unrecognized replies during a pending request auto-deny so the sidecar (and Claude) don't hang.
  - Per-spawn state lives in the `SpawnPlan` returned by `AgentBase.prepareCommand` (closure-local, not `this.*`) — fixes a singleton race where parallel IM threads running claude clobbered each other's `mcp-config` and the second run died with *MCP config file not found*.
  - Graceful fallbacks: `IMHUB_APPROVAL_DISABLED=1`, missing IM context, approval-bus not started, or `mkdtemp/writeFile` failure all degrade to the legacy `--permission-mode dontAsk` path.

### Notes
- Approvals are platform-agnostic — the same chain works for WeChat / Telegram / Feishu / Discord with no per-platform changes.

---

## [0.2.13] - 2026-04-30

A large multi-phase release: structured logging, observability, multi-tenant routing, persistent jobs, ACP server-mode, and a Web tasks panel. Versioned together because the wiring is interdependent.

### Phase 1 — Foundations (security, logging, schema, agent base)

#### Added
- **Structured logging** with `pino` and request-scoped `traceId` propagated through every layer (router → agent → audit). Pretty in TTY, JSON in production. ADR: [`docs/adr/0002-structured-logging-trace-id.md`](docs/adr/0002-structured-logging-trace-id.md).
- **Zod config schema validation** at startup and PUT `/api/config` — invalid configs reject with a useful error instead of crashing the bridge mid-run.
- **`AgentBase` abstraction** for CLI-based adapters (claude-code / codex / copilot / opencode) — shared spawn-stream, abort/timeout, line buffer, error formatting, healthCheck. ADR: [`docs/adr/0001-agent-base-abstraction.md`](docs/adr/0001-agent-base-abstraction.md).
- **Agent availability TTL cache** on top of `healthCheck` — avoids spawning a probe process on every `/<agent>` switch.
- **Audit log** with SQLite (`~/.im-hub/audit.db`, 30-day retention) + `/audit [n]` chat command.

#### Fixed
- P0 batch: WebSocket auth, nested config-mask leaks, timeout coercion, `/api/notify` token validation, agent-name prefix collisions, session path traversal (ADR [`0003`](docs/adr/0003-session-path-safety.md)).

### Phase 2 — Routing & resilience

#### Added
- **Intent classifier** (`src/core/intent.ts`) — topic regex (CJK + ASCII), per-agent keyword profile, sticky-session bias, optional LLM judge fallback with LRU cache. `/router status|policy|explain|reset` for inspection.
- **Circuit breaker** for agent invocations (3 failures → 5-minute cool-down).
- **Per-user token-bucket rate limiter**, applied before every agent dispatch.

#### Fixed
- Workspace whitelist now applies to both `/<agent>` *and* default routing.
- `workspace.rateLimit` actually enforced (was inert before).
- Intent classifier matches CJK keywords (was `\b` regex, all dead).
- Profile-less ACP custom agents participate via a `DEFAULT_WEIGHT` floor.

### Phase 3 — ACP server, workspaces, persistent jobs

#### Added
- **ACP server mode** — im-hub itself is now an ACP-compatible agent at `POST /tasks` (sync + SSE) with timing-safe auth and a 1 MiB body cap.
- **`/.well-known/acp` discovery** for ACP custom agents (A-1).
- **Multi-tenant workspace registry** (`src/core/workspace.ts`) with per-workspace agent whitelist + rate limits + member lists.
- **Persistent Job Board** with SQLite (`~/.im-hub/jobs.db`) and `/job` chat commands — survives restarts; ACP-server tasks become durable jobs.
- **Subtask sessions** + `/task` aliases for backward compatibility.
- **`AbortController` signal** plumbed through job board for real cancellation (Phase 3.5).
- **Cron scheduler** (`src/core/schedule.ts`) — 30-second tick, fires registered job specs.

### Phase 4 — Observability & Web (W-1)

#### Added
- **Web `/tasks` panel** for jobs, schedules, workspaces.
- **REST jobs API** (`/api/jobs`, `/api/schedules`, `/api/workspaces`).
- **Prometheus metrics** at `/api/metrics` (pure quickselect quantiles, no extra dep).
- Deployment guide: [`docs/deployment.md`](docs/deployment.md).

### Restored / overhauled commands
- `/model`, `/models`, `/think`, `/stats`, `/sessions` — all returned and overhauled. Session model selection now persists across restarts.

### Performance
- LRU cache for LLM intent judge.
- Shared SQLite helper (single `prepare`-cache, single PRAGMA bootstrap).
- LineBuffer indexOf walk (avoids quadratic scans on long stdout chunks).
- Metrics quickselect quantiles (no `.sort()` per scrape).
- Cron `nextOccurrence` field-level fast-forward (skip-ahead instead of minute-loop).

### Stability fixes (CR round)
- 11 follow-up findings from the code-review pass (see [`docs/code-review-2026-04-30-main.md`](docs/code-review-2026-04-30-main.md)).
- WeChat `getUpdates` now has a `FETCH_TIMEOUT` to prevent event-loop blocking.
- `AgentBase.sendPrompt` is true streaming with multi-byte UTF-8 safety.
- `session.addMessage` is append-only JSONL (was full rewrite per turn).

### Architecture docs
- [`docs/architecture/current.md`](docs/architecture/current.md) — system overview at v0.2.13.
- [`docs/architecture/target.md`](docs/architecture/target.md) — multi-tenant target.
- ADRs 0001 / 0002 / 0003.

---

## [0.2.7] - 2026-03-27

### Added
- **Conversation history support** — agents now remember context across messages
  - Session stores message history (`ChatMessage[]`)
  - History is passed to agents with each prompt for context awareness
  - `/new` command to start a fresh conversation (clears history)
- **ChatMessage type** — `{ role: 'user' | 'assistant', content: string, timestamp: Date }`
- **Session history management** in SessionManager:
  - `addMessage()` — add message to conversation history
  - `resetConversation()` — clear history, start new session
  - `getSessionWithHistory()` — retrieve session with messages

### Changed
- **AgentAdapter interface** — `sendPrompt()` now accepts optional `history?: ChatMessage[]`
- **All agent adapters** (claude-code, codex, copilot, opencode) now:
  - Accept conversation history
  - Build contextual prompts with previous messages
- **Router** — automatically saves user messages and agent responses to history
- **Help text** — updated to include `/new` command

### Fixed
- Context loss issue in channel-based conversations — agents now maintain conversation memory

## [0.2.2.0] - 2026-03-27

### Added
- **Onboarding module** (`src/core/onboarding.ts`) with friendly first-run experience
  - `checkMessengerConfig()` — detect if messengers are configured
  - `checkAgentAvailability()` — async check with session-level caching
  - `runMessengerOnboarding()` — interactive messenger setup wizard
  - `formatAgentInstallHint()` — friendly install messages for missing agents
  - `formatAgentNotAvailableError()` — chat-friendly runtime error messages
  - `formatMessengerStartError()` — actionable hints for startup failures

### Changed
- **CLI start command** now runs onboarding checks before starting messengers
  - Detects unconfigured messengers and launches interactive setup
  - Warns about missing agents with install instructions
  - Shows friendly error messages instead of stack traces
- **Router** now checks agent availability at runtime
  - Returns helpful chat message if requested agent isn't installed
  - Uses cached availability check to avoid repeated process spawns

### Fixed
- Critical bug where onboarding never triggered because `config.messengers` was auto-filled with default
- Ugly stack traces shown to users when messenger fails to start

## [0.0.1.0] - 2026-03-25

### Added
- Initial project scaffold with TypeScript + Bun
- Core types: `Message`, `ParsedMessage`, `Session`, `MessengerAdapter`, `AgentAdapter`
- Plugin registry for static imports
- Message router with command parsing (`/status`, `/help`, `/agents`, `/<agent>`)
- Session manager with file-based persistence
- WeChat adapter stub (wechaty-puppet-wechat)
- Claude Code adapter stub (stream-json mode)
- CLI commands: `start`, `config`, `agents`, `messengers`
