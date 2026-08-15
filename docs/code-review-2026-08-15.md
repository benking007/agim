# 代码审查报告（2026-08-15）· agim v1.5.98

> **入口：** `docs/README.md` · 基线：`docs/code-review-2026-07-23.md`（v1.5.76 安全审查；本轮不重复其已列项，仅复核可用性相关遗留）
> **版本区间：** v1.5.76 → v1.5.98（含 07-23 报告后的 ~22 个 release）
> **Reviewer：** 主 agent 精读核心链路 + 3 个并行 subagent 分维度深读（可用性：投递/恢复/适配器 ~30 文件 1.2 万行；易用性：CLI 引导/Web SPA/契约/文档；稳定性：agent-loop/并发/调度/存储/Web 服务）。**所有 headline finding 均回源验证**（主 agent 复核 dingtalk 无超时、reapStaleRunning 语义、i18n en 词典中文、WS 无 ping、sqlite broken 粘滞、heartbeat 无守卫、reminders 无清理、active-runs 无上限等关键证据）。
> **方法：** `npx tsc --noEmit` ✅ · `npm run lint:backend` ✅（50 warning / 17 info，全为 style，0 error）· `npm test`：2968 pass / 140 skip / **4 fail**（2 个为 macOS `/tmp`→`/private/tmp` 符号链接平台差异，2 个为并行负载下 5s 超时、单独重跑全部通过）· `npm audit --omit=dev`：**10 vulnerabilities（4 high）** · `check-i18n` ✅ · `check:contracts` ✅（125 REST 路由 ↔ 86 SPA wrapper 全部匹配）

---

## 0. 结论摘要

整体质量延续高位：出站 at-least-once（outbox claim/requeue/dedup）、调度层原子认领（schedule CAS、reminders `firing`）、优雅关闭 25s 硬截止 + WAL 收尾、agent-loop 错误面收敛（abort/清理/流式边界）、定时器纪律（全部 unref + stop 路径），都是值得保持的工程实践。07-23 的两个高危（媒体存储型 XSS、CLI 选项注入）**均已修复**并在 Unreleased CHANGELOG 有记录。

本轮按**可用性 / 易用性 / 稳定性**三个维度审查，发现：

- **2 个 High（可用性）**：
  1. **DingTalk 出站 `fetch` 无超时 + outbox worker 单线程无看门狗** → 一次卡死的发送可阻塞**所有通道**投递，且 `/restart` 同步 ack 路径一起挂死。
  2. **heartbeat 调度 tick 无在飞互斥（07-23 M1 确认仍未修复）** → 同一 binding 被并发重复执行，双倍扣费 + 重复通知。
- **8 个 Medium**：非优雅退出时在途 job 被置 `failed` 而非 `interrupted`（崩溃可续承诺落空）、WS 无服务端心跳（审批卡发往死 socket）、WeChat long-poll 游标先于本地处理推进（入站丢失窗口）、SQLite broken 状态进程内永久粘滞、`messenger.start()` 串行无超时、Loop 热路径同步文件 I/O、REST 层无顶层 try/catch、callHelperAgent 超时竞态（定时器不清/下层未中止）。
- **易用性 13 项**：核心问题是 **i18n 中英混杂**（en 词典里是中文文案、启动横幅硬编码中文、CLI 首跑默认中文、IM/SPA 侧硬编码中文），对英文用户（含 GLOBAL_IM 的 Telegram/Discord 受众）是实打实的体验缺陷；另有向导细节（Agents 列表坏 key、钉钉 Back 语义）与错误码契约只落地一半。
- **其余 Low**：reminders 表无清理、WeChat 去重窗口 60s 过短、restart-completion 失败仍删状态文件、active-runs 内存无界、thread-queue 无上限、退役 agent-loop 无输入压缩、媒体清理仍只挂 Telegram（07-23 M3 未修复）。
- **依赖面**：`npm audit` 4 个 high（`ip-address` SSRF/信任边界绕过、`fast-uri` host confusion、`sharp` libvips CVE 无修复、`undici` 经 discord.js 传递）——其中 `ip-address` 与项目的 SSRF 防护（`assertSafeUrl`）直接相关，建议优先升级。

**建议修复顺序：** P0：heartbeat 互斥 + DingTalk 超时 + 崩溃恢复语义；P1：WS 心跳、i18n en 词典、错误码契约、SQLite 重试、REST try/catch；P2：Loop 热路径、start 超时、依赖升级、内存限额。详见 §4。

---

## 1. 项目定位理解

在审查前先确认项目自我定位（README.zh-CN.md / docs/README.md / AGENTS.md）：

**Agim（阿吉姆）是一个 IM 到 AI Agent 的桥接系统**，强调"可用性与可运维性"：投递尽量不丢（at-least-once）、会话可续、审批可控、链路可观测。关键技术决策：

| 维度 | 定位要点 |
|---|---|
| 架构 | 单进程 Node.js ≥ 22.19 / TypeScript，无 Docker、无 Redis；Web UI :3000；`~/.agim/` 状态目录 |
| 桥接优先 | 微信 / 飞书 / 钉钉 / 邮件接入多类 Agent（Claude Code、Codex、Copilot、Cursor、Kimi Code、Qoder、PI、MiMo、Antigravity、Agim Agent）；Telegram/Discord 默认隐藏（`AGIM_ENABLE_GLOBAL_IM=1`） |
| 投递可靠 | SQLite outbox（at-least-once）+ 指数退避 + 崩溃重投 + dedup；生产硬依赖 better-sqlite3，无 SQLite 时降级直发 |
| 会话/任务 | 会话可续（agent-session-bindings）、重启恢复（job-recovery）、任务看板（/jobs、/tasks）、审计日志 |
| AI 能力成套 | 长期记忆、Skills、Focus、Loop 工程、子代理/A2A、心跳、提醒、备忘、结构化提问（ask_user） |
| 安全默认开启 | token 鉴权、敏感路径拦截、工具自动审批默认关闭（`AGIM_AUTO_APPROVE=0`）、URL/SSRF 守卫、self-protect |

**本轮审查结论与该定位的契合度：** 正常路径下"投递不丢"基本成立（outbox 设计扎实）；但**异常路径存在结构性缺口**——非优雅退出的崩溃恢复（F3）、单点卡死（F1）、调度重叠（F2）都直接动摇"可用性与可运维性"的承诺。易用性方面，README 承诺的"先跑通 Web 再连 IM"体验兑现度高（`agim go`/`web`/`doctor`/Dashboard 引导/FirstRunPanel 均与文档一致），但**国际化承诺（中英双语言）未兑现**——这是定位上"国际用户可用"（Telegram/Discord 目标人群）与实现的落差。

---

## 2. 可用性（Availability / Reliability）发现

### 🔴 High

#### F1 · DingTalk 出站发送无超时 + outbox worker 单线程无看门狗 → 全部通道投递可被单个卡死的发送永久阻塞

- **位置：** `src/plugins/messengers/dingtalk/dingtalk-client.ts:258-265`（`sendTemplated` 的 `fetch` 无 `signal`/超时；`downloadMessageFile` 内两处 fetch 同样无超时）；`src/core/message-sink.ts:456-518`（全局单线程 worker：`workerBusy` 标志 + 串行 `await doSend`，无 per-row 超时）；`src/core/restart-flow.ts:257-294`（`/restart` 的同步 ack 走 `sink.deliver({priority:'high'})` → 同步 `doSend`）。
- **对照：** wechat `ilink-client.ts:60` 所有请求均 `AbortSignal.timeout(30000)`；dingtalk 是全仓唯一无超时的出站 HTTP 适配器。
- **影响：** DingTalk OpenAPI 网络黑洞时：① 微信/飞书/Telegram **所有通道**出站消息无限期延迟（新消息只入队不投递）；② IM 端 `/restart` 永不返回，服务无法重启（systemd 路径同样卡在 `deliverRestartAck`）。这是"可用性"维度的最严重缺陷。
- **修复建议：** ① `sendTemplated`/`downloadMessageFile` 的 fetch 统一加 `AbortSignal.timeout`（对齐 wechat 30s）；② worker 对 `doSend` 包整体超时（如 60s，超时按失败走 `markFailed` backoff），单行拖死整队时至少能继续投递其他通道；③ restart ack 推送加超时，失败也继续执行重启（ack 改入 outbox 队列）。

#### F2 · heartbeat 调度 tick 无在飞互斥（07-23 M1 确认仍未修复）→ 同一 binding 并发重复执行

- **位置：** `src/core/heartbeat.ts:338-355`（`setInterval(() => { void tickOnce() }, period)` 无 busy 守卫）、`:311-330`（`tickOnce` 串行 await 最多 50 个 binding）；`src/core/heartbeat-store.ts:343-362`（due 判定仅 `last_tick_at <= now`，无 claim/占用态）、`:272-306`（`recordTick` 在 binding **跑完**后才写 `last_tick_at`）。
- **对照：** 同项目其他调度器均有防重：outbox `claimForSend` 租约、schedule `next_run` CAS（schedule.ts:297-308）、reminders 原子 `status='firing'` 认领（reminders.ts:976-980）——唯独 heartbeat 没跟上。
- **影响：** 单个 binding 最坏 ≈70s（decide 10s + execute 60s）> 60s tick 周期 → tick N+1 再次选中同一 binding → **并发 spawn 两个 agent**（双倍 LLM 花费 + 用户重复通知）；且 `callHelperAgent` 不经 `runOnThread` 串行化（agent-helper.ts:137），同线程并发违反 thread-queue.ts:18-19 明确要保护的"同线程 agent 调用必须串行"不变式（claude-code 同 session-id 并发 spawn 会失败）。
- **修复建议：** ① `tickOnce` 加模块级 `ticking` 标志，在飞时跳过本轮（或等上轮结束再排下一轮）；② 更稳：仿照 reminders 给 heartbeats 表加 in-flight 租约并在 `listDueBindings` 排除，崩溃后启动时释放；③ 至少给 `recordTick` 加 CAS（`WHERE last_tick_at = <读取时的值>`）。

### 🟠 Medium

#### F3 · 非优雅退出（kill -9 / OOM / 断电）时"中断恢复"机制整体失效

- **位置：** `src/cli/graceful-shutdown.ts:73-76`（`markRunningInlineJobsInterrupted` 只在优雅关闭路径调用）；`src/core/job-board.ts:84-97`（`reapStaleRunning` 把 `status='running'` **无 kind 过滤**直接置 `failed`）；`src/core/job-board.ts:359-380`（恢复扫描只认 `interrupted` 状态）。
- **影响：** 进程被强杀后，在途 inline job 被标记 `failed`，用户收不到"回复 1 重发 / 2 取消"的恢复提示（job-recovery.ts:123-129 整体跳过），在途请求静默消失——与"消息不丢、会话可续"的自我定位相悖。
- **修复建议：** `reapStaleRunning` 对 `kind='inline'` 行改为置 `interrupted`（与优雅关闭语义一致），仅 `kind='job'` 置 failed。

#### F4 · WebSocket 服务端无心跳/ping → 半开连接僵尸化，审批卡发往死 socket

- **位置：** `src/web/server.ts:850-872`（仅 `close`/`error` 事件清理，无 ping/pong、无 isAlive——全仓 grep 无 `ws.ping(`）、`:926-933`（`sendApprovalCard` 仅检查 `readyState === OPEN`，半开连接仍视为在线）、`:616-622/:649-658`（per-IP 计数与 `maxWsClients` 只随 close/error 释放）。
- **影响：** ① 断网/合盖用户的审批请求丢失，agent 停在"等待审批"直到 bus 超时自动拒绝（审批可控性受损）；② 长期运行后 `maxWsClients` 被僵尸连接耗尽，新连接被拒。
- **修复建议：** 服务端加 `setInterval` ping + `isAlive` 标记 + pong 超时 `terminate()`（ws 官方推荐心跳模式）。

#### F5 · WeChat long-poll 游标先于本地处理推进 → 崩溃/恢复窗口内入站消息丢失

- **位置：** `src/plugins/messengers/wechat/ilink-adapter.ts:344-354`（`get_updates_buf` 先推进、`handleIncomingMessage` 后 fire-and-forget）、`:407-446`（`tryRefreshSession` 用 `getUpdates('')` 显式消费服务端游标，注释自认"consumed the server-side cursor … lost forever"）。
- **影响：** 崩溃/断线瞬间用户消息可能被静默丢弃（at-least-once 只覆盖出站方向，入站存在真实丢失窗口）。
- **修复建议：** 入站消息先持久化（本地队列/DB）再推进游标，重启后重放；受 iLink API 语义限制时至少缩小窗口并记录丢失日志便于运维感知。

#### F6 · SQLite 初始化失败进程内永久粘滞（dbBroken 不可逆）+ 降级后消息不可恢复

- **位置：** `src/core/sqlite-helper.ts:46-72`（init 抛错后 `dbBroken = true`，**进程生命周期内永不重试**；outbox/jobs/schedule/reminders/heartbeat 共用此 helper）；`src/core/message-sink.ts:334-356`（outbox 降级时 last-ditch direct send，失败即 `'message is lost'`）。
- **影响：** 启动期一次瞬态故障（磁盘满、WAL 锁、双实例争锁）即可让**整个进程生命周期内** outbox/jobs/schedule 失去持久化：此后消息直接丢失、无 backoff、无 giving_up 保留；`/jobs`、定时任务静默降级为空数据。
- **修复建议：** broken 状态增加周期重试 init（如每 5 分钟 `get()` 重开一次）；降级时通过 `/api/service/status` 或日志告警暴露"持久化不可用"。

#### F7 · `messenger.start()` 串行 await 且无超时 → 单个适配器启动卡死即阻塞整个启动链

- **位置：** `src/cli/start-runtime.ts:588-613`（`await messenger.start()` 在循环内）、`:631`（`sink.startWorker()` 与恢复扫描、web server 全在该循环**之后**）；`src/plugins/messengers/email/email-adapter.ts:84-98`（`await this.transporter.verify()`，nodemailer 默认连接超时最长 2 分钟）。
- **影响：** 某通道网络黑洞时服务起不来（日志停在 "Starting messenger…"），outbox 中积压的历史消息在启动完成前零投递。
- **修复建议：** 对每个 `messenger.start()` 包 `Promise.race` 超时（如 30s），超时按该适配器启动失败处理；保证 `sink.startWorker()` 与恢复扫描不依赖所有适配器启动成功。

### 🟡 Low

#### F8 · reminders 表无保留策略（07-23 M8 残余）

- **位置：** `src/core/reminders.ts` 全文件无 `DELETE FROM reminders` / prune（`MAX_PENDING_PER_USER=50` 只限 pending；一次性提醒触发后永久保留 `fired` 行）；对照 job-board `pruneOldJobs`（job-board.ts:1020-1093）、outbox `pruneOldOutbox`（outbox.ts:517-542）。
- **影响：** 长期运行 reminders.db 单调增长（每次一次性提醒一行）。
- **修复建议：** 仿照 outbox/job-board 增加 `pruneOldReminders`（fired/cancelled 保留 N 天后删除）+ 周期 sweep（unref'd）。

#### F9 · WeChat 去重窗口 60s < 慢处理时长 → 会话恢复重投递时同一消息被二次处理（07-23 已列）

- **位置：** `src/plugins/messengers/wechat/ilink-adapter.ts:37`（`PROCESSED_MESSAGES_TTL = 60_000`）、`:476-484`、`:428-430`（`tryRefreshSession` 重投递路径无 TTL 延长）。
- **影响：** 慢处理场景（长语音转写等）下用户收到重复回复、重复扣费。
- **修复建议：** 去重 TTL 提高到与恢复窗口一致，或消息处理完成前不清除去重记录。

#### F10 · restart-completion 推送失败后 pending 文件仍被删除 → 用户永远不知道重启结果

- **位置：** `src/core/restart-completion.ts:79-81`（`await pushToInitiator(...)` 后无条件 `safeUnlink`）、`:173-179`（push 异常仅 log "dropping"）。
- **影响：** 完成消息推送失败（messenger 预热中/token 失效）时，发起人收不到"✅ 已重启完成"，且状态文件已删、下次启动不再补推。
- **修复建议：** 推送失败时保留 pending 文件（或写失败标记）供下次启动补推；完成消息走 outbox 队列（priority normal）。

#### F11 · active-runs 内存快照无界（与稳定性 L2 同源）

- **位置：** `src/web/active-runs.ts:50`（`FINISHED_RETENTION_MS = 1h`）、`:113-117`（`appendActiveRunChunk` 的 `snap.partialText += chunk` 无上限；对照 inline-delivery.ts:23 有 `INLINE_DELIVERY_MAX_CHARS = 400_000` 上限）、`:179-188`（runs Map 按线程数无界增长）。
- **影响：** 多线程高频使用下内存随 线程数 × 单次输出量 线性增长，长跑进程可积累数百 MB。
- **修复建议：** `partialText` 设上限（对齐 400K），完成态快照按总量限额（如 500 个）LRU 驱逐。

#### F12 · 媒体清理仍只挂 Telegram 适配器（07-23 M3 未修复）

- **位置：** `src/plugins/messengers/telegram/telegram-adapter.ts:369/373` 是 `cleanupOldMedia` 唯一调用点；`src/plugins/messengers/dingtalk/media-store.ts:5` 与 `wechat/media-download.ts:7-8` 注释声称"共享清理"但从未被调用。
- **影响：** 未启用 Telegram 时 `~/.agim/media/wechat|dingtalk|web/**` 无限增长。
- **修复建议：** 把清理挂到 `cli.ts` 启动路径（中央定时器），而不是 Telegram 适配器内部。

---

## 3. 易用性（Usability / UX）发现

### 3.1 i18n 中英混杂（最高优先级，英文用户核心体验缺陷）

#### U1 · 【阻塞上手】en 词典里塞了大量中文文案

- **位置：** `src/cli-ui/i18n.ts:364-377`（`start.mcp_connected`~`start.admin_bootstrap_failed`）、`:378`（`agents.label.native`）、`:380-397`（`token.cli.*`、`token.bootstrap.*`）——这些 key 在 **en 词典**里就是中文字符串；zh 词典在 `:747-784` 重复定义。
- **影响：** 英文用户保存 `en` 后，`agim start` 的 MCP 连接行、`agim token bootstrap` 的"请立即保存 — 执行本命令后 bootstrap 文件将被删除"、`agim token create` 的提示全部是中文。
- **修复建议：** 把这批 key 拆成真正的 en/zh 两套文案（en 侧照抄 setup-llm 的英文措辞），并加一条测试断言 en 词典不含 CJK 字符。

#### U2 · 【阻塞上手】`agim start` 收尾横幅硬编码中文

- **位置：** `src/cli/start-runtime.ts:748-752`（`console.log('\n✅ 服务已启动！')` / `Web 控制台：…` / `按 Ctrl+C 停止`）——同函数 40 行之前（`:326-343`）刚用 `cliT()` 做过本地化，收尾却写死中文。
- **修复建议：** 沿用 `bootLang` 走 i18n dict，或至少用 `text(lang, zh, en)` 内联双语。

#### U3 · 【明显困惑】首次运行 `agim go` / `agim doctor` / `agim status` 直接默认中文，且无语言选择器

- **位置：** `src/cli.ts:140-143`、`:158-162`；`src/cli-ui/quickstart.ts:36`（默认 `resolveCliLang()`）；`src/cli-ui/i18n.ts:849-851`（`resolveCliLang() ?? 'zh'`）；`src/cli-ui/cmd-handlers.ts:230-232`。语言选择器只挂在裸 `agim` 入口菜单和 `agim config`。对照：Web 端做对了（`src/web-app/src/i18n/index.ts:117-126` 用 `navigator.language` 探测）。
- **影响：** 英文 README 快速开始第一条命令就是 `agim go`（README.md:25），英文读者按文档执行会直接收获中文界面。
- **修复建议：** `resolveCliLang()` 无保存值时按 `LANG`/`LC_ALL` 回退（或默认 en），并给 `agim go` 首次运行补一次 `pickLang()`。

#### U4 · 【明显困惑】`agim config` Agents 列表显示原始 key 字符串，且原生 agent 出现两行

- **位置：** `src/cli-ui/config-wizard.ts:634-636`（`AGENT_SPECS` 同时含 `{id:'agim'}` 与 `{id:'native'}`）、`:707-717`（渲染 `t('agents.label.'+spec.id)`）、`:848`；`src/cli-ui/i18n.ts:378`（只有 `agents.label.native`，没有 `agents.label.agim`）、`:793`（`t()` 缺 key 回退为 key 本身）。
- **影响：** 配置屏第一行原样打印 "agents.label.agim — not enabled"，且 `agim` 与 `native` 两个 spec 渲染两行同一含义的原生 agent。
- **修复建议：** 删除 `{id:'agim'}` 重复 spec（保留 `native`），或补 `agents.label.agim` / `agents.install_hint.agim` key。

#### U5 · 【明显困惑】IM 命令错误回复全中文硬编码，英文 Telegram/Discord 用户看不懂

- **位置：** `src/core/commands/agent.ts:23,50`（"❌ 任务 #… 已不存在"）、`src/core/onboarding.ts:474-488`（`formatAgentNotAvailableError` 中文）、`src/core/commands/job.ts:58-63`、`cron.ts:52` 等；唯一双语的是 `/help`、`/start`（`builtin.ts:18-29` 的 `detectLang`）。
- **影响：** GLOBAL_IM 目标人群（Telegram/Discord 天然英文用户）的报错不可读，且无 per-user 语言偏好。
- **修复建议：** 至少给高频错误（agent 不可用、任务不存在、用法提示）做 en/zh 双语模板，支持按用户记忆语言。

#### U6 · 【明显困惑】SPA 代码块复制按钮硬编码中文

- **位置：** `src/web-app/src/components/chat/code-fence.tsx:155`（`toast.error('复制失败')`）、`:172`（`{copied ? '已复制' : '复制'}`）；同按钮 aria-label 却是英文 "Copy code"（`:169`）——同一按钮内中英混杂，i18n 体系对该组件无效。
- **修复建议：** 改用 `t('chat.copy')` / `t('chat.copied')` / `t('chat.copyFailed')`，纳入 common.json 双语。

#### U7 · 【细节打磨】CLI 其他中英混杂点

- `src/cli-ui/token-menu.ts:32`：token 子菜单提示行是裸 `"?"`（全项目唯一无语义 prompt 的菜单）。
- `src/cli-ui/cmd-handlers.ts:565`：入口菜单选"卸载"会**再次询问语言**，违背"已选过语言不再问"的既定规则（`cli.ts:492-497` 注释明确此为 v0.5.1 regression 教训）。
- `src/cli-ui/config-wizard.ts:876-925`：中文向导内部跳入纯英文子向导（setup-llm / setup-mcp / diag 无 i18n）；`prompts.ts:123,142` 表单校验失败仅回英文 "Required"。
- `src/cli-ui/config-wizard.ts:260-263`：Telegram/Discord 被 `AGIM_ENABLE_GLOBAL_IM` **静默隐藏**，无任何提示（默认关闭时用户无从得知这是开关控制而非产品不支持）。
- `src/web-app/src/routes/chat.tsx:311-314` vs `:383`：断线空态文案说"可以继续输入"，但输入框实际 `disabled`（`state.status !== 'open'`）——"keep typing"是假承诺；断线时既无重连倒计时也无"输入将被排队"说明。

### 3.2 交互逻辑与契约

#### U8 · 【明显困惑】Web 错误码契约只落地一半：多数接口仍只回 `{error}`，前端把可操作细节吞成 "Server error."

- **位置：** `src/web-app/src/lib/api/client.ts:113-137`（无 `code` 时按状态码映射 `HTTP_xxx`）、`src/web-app/src/lib/api/errors.ts:33-37`、`i18n/locales/en/errors.json:21-30`；服务端已有规范入口 `src/web/http-utils.ts:106-117`（`sendError` 带 code+detail），但大量处理器仍用 `sendJson(res, 500, { error: err.message })`，如 `src/web/jobs-api.ts:268,281`、`src/web/config-api.ts:199`、`src/web/memory-api.ts:124`（同一文件 `config-api.ts:385` 已用 `sendError`——两种风格并存）。
- **影响：** 设置保存失败、任务创建失败时只看到泛化 "Server error."，无法判断该改什么。
- **修复建议：** 高频路径（设置保存、job create、messenger 操作）统一改 `sendError` + 语义 code + detail，errors.json 补对应 key。

#### U9 · 【明显困惑】钉钉配置流程里"← Back"不取消，会继续走完剩余提问并把渠道"已配置"

- **位置：** `src/cli-ui/config-wizard.ts:522-571`（`dmPolicy`/`groupPolicy`/`ackReaction` 菜单带 `back` 选项，但 `BACK` 只表示"保留默认值"，函数末尾无条件 `messengers.add('dingtalk')`）；`:385-388`（Ctrl-C 被外层菜单吞掉弹回子菜单，用户无法中途退出）。
- **影响：** 按"← Back"的用户会惊讶地发现配置被保存了；"Back"语义与向导其他所有菜单（回到父级）不一致。
- **修复建议：** BACK 时直接 return 不保存（或先弹确认），并把"← Back"改名为"保留默认"。

---

## 4. 稳定性（Stability / Robustness）发现

> H1（heartbeat 重叠）已在 §2 F2 列出（可用性/稳定性双维度同源，不重复）。以下为稳定性独有发现。

### 🟠 Medium

#### S1 · Loop 状态快照同步文件 I/O 落在父 agent 每次工具调用的热路径上

- **位置：** `src/core/loop-run.ts:644-655`（`readRun` 每次 `readFileSync` + `JSON.parse` 整个快照）、`686-706`（`writeRun` 同步写**两份**完整 JSON：线程快照 + history，`writeFileSync` + `renameSync`）、`1044-1081`（`notifyLoopJobTerminal`）；调用方 `src/plugins/agents/agim-agent/index.ts:1346-1371`（**每次工具调用 preflight** 都执行 `evaluateLoopDispatchGate` + `evaluateLoopParentWaitGate`）。
- **影响：** Loop 派工密集期（父工具调用 + 子代理批量完成）出现周期性事件循环停顿（UI/agent 响应卡顿）；快照随 timeline（上限 200 条 × 500 字符）增大后单次读写可达数百 KB。
- **修复建议：** 活跃 run 维护内存态 + 写穿缓存（按状态迁移 debounce 落盘）；或把 `getActiveLoop` 热路径改为内存 Map 查询，仅跨进程读才走文件。

#### S2 · Web REST 处理器链没有顶层 try/catch，处理器意外抛错会让 HTTP 请求悬挂无响应

- **位置：** `src/web/server.ts:202-494`（`createServer(async (req, res) => { ... })` 全链无 try/catch；各 `await handleXxxApi` 依赖各自内部兜底）。配套缺口：无显式 `requestTimeout`/`headersTimeout`，无 `res.on('close')` 悬挂清理。
- **影响：** 任何处理器路径漏抛 → async handler reject → 响应永远不写，客户端请求挂起直到 Node 默认 `requestTimeout`（300s）；唯一痕迹是进程级 `unhandledRejection` 被吞成一行 warn（start-runtime.ts:78-84）。
- **修复建议：** handler 体包一层 try/catch → `sendJson(res, 500)`（响应未发送时），并注册 `res.on('close')` 兜底；server 上设显式 `requestTimeout`/`headersTimeout`。

#### S3 · callHelperAgent 超时竞态：定时器不清、底层 agent 未真正中止、迟到 rejection 无人处理

- **位置：** `src/core/agent-helper.ts:137-146`（`collect` 与 `new Promise((_, reject) => setTimeout(...))` 竞速；超时赢时：① collect 继续在后台消费 generator（无 abort 下层 agent）；② generator 之后 reject 无人 await → 走全局 unhandledRejection 吞日志；③ `setTimeout` 从不 `clearTimeout`，每次调用留一个最长 timeoutMs 的悬挂定时器且未 unref）。
- **影响：** 超时后的"超时"只是表象——CLI agent 子进程仍在跑（心跳 execute 场景下持续消耗 token）；高频触发（提醒润色 20s、心跳 60s）时悬挂定时器堆积。
- **修复建议：** 用 `AbortController` + `clearTimeout(finally)`，signal 透传给 `adapter.sendPrompt`；collect 侧 `finally` 中止。

### 🟡 Low

#### S4 · thread-queue 无队列长度上限、无排队等待超时

- **位置：** `src/core/thread-queue.ts:44-71`（`queues` Map 对同一 key 无限 promise 链，`depths` 无上限）。
- **影响：** 用户连发消息时队列无限积压（每条 agent 调用最长 30min 量级），后发消息体验为"排队中"数小时；`onQueued` 每进队一条就通知一次（通知风暴）。
- **修复建议：** 每 key 队列深度上限（超出即拒绝/提示稍后再试）；对排队中条目支持取消；对 `fn` 加等待超时。

#### S5 · 退役 runAgentLoop 无输入上下文压缩，且每迭代多次整段 history.slice() 拷贝

- **位置：** `src/core/llm/agent-loop-run.ts:83`、`:123-130`、`:225-233`、`:446-452`；`src/core/llm/agent-loop-config.ts:55`（history 随迭代无限增长，无输入侧压缩/截断；length-recovery 只处理输出截断）。
- **影响：** 超长回合最终以 provider 400（context 超限）收场 + GC 压力。该 loop 已退役（agent-loop.ts:3-9 声明生产走 AgentHarness），风险面有限。
- **修复建议：** 迭代内加输入窗口压缩（按 token 预算截断中间轮次）。

---

## 5. 验证与质量门（本轮实测）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 error |
| `npm run lint:backend` | ✅ 0 error（50 warning + 17 info，全为 style/complexity 类） |
| `npm test`（bun, 全量） | ⚠️ 2968 pass / 140 skip / **4 fail** |
| 失败 1-2：web-media-upload / workspace-path | macOS `/tmp`→`/private/tmp` 符号链接差异（realpath 前缀不同），**平台测试问题非产品缺陷**（Linux CI 应通过） |
| 失败 3-4：agim-dispatcher 2 个 5s 超时 | 并行负载下 flaky；单独重跑 `26 pass / 0 fail` |
| `npm audit --omit=dev` | ⚠️ **10 vulnerabilities（4 high / 6 moderate）** |
| `check-i18n` | ✅ 11 ns × 2 langs parity |
| `check:contracts` | ✅ 125 REST ↔ 86 SPA wrapper 全匹配 |
| 07-23 F1（媒体存储型 XSS） | ✅ 已修复：html/svg/xml 一律 attachment + `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`（web-media-upload.ts:205-212） |
| 07-23 F2（CLI 选项注入） | ✅ 已修复：所有 CLI 适配器 prompt 前插 `--`（cli-prompt-arg.ts `pushPromptArg`） |
| 07-23 M1（heartbeat 重叠） | ❌ **未修复**（本轮 F2） |
| 07-23 M3（媒体清理只挂 Telegram） | ❌ **未修复**（本轮 F12） |

**依赖审计明细（4 high）：**

| 包 | 严重度 | 说明 | 建议 |
|---|---|---|---|
| `ip-address` ≤10.3.0 | high | Address4 前导零八进制解码 / CIDR 抑制 special-use 分类 / IPv4-mapped 误判 → **SSRF 与信任边界绕过**（与项目 `assertSafeUrl` SSRF 防护直接相关） | 升级（npm audit fix 可修） |
| `fast-uri` 3.0.0-3.1.4 | high | 反斜杠 authority 分隔符 host confusion | 升级（可修） |
| `sharp` <0.35.0（经 @huggingface/transformers） | high | libvips CVE-2026-33327/33328/35590/35591 | **无修复版**；评估 `--omit=optional` 或固定镜像 |
| `undici` ≤6.27.0（经 discord.js/@discordjs/rest） | moderate | retry 响应失步 / CRLF / cookie 注入 | 升级（可修） |
| `hono` / `@hono/node-server` / `tar` | moderate | CORS ReDoS、memo 跨请求数据披露等 | 升级（可修） |

---

## 6. 完善方案（分优先级行动项）

### P0 · 建议本周内（动摇核心承诺，均有明确最小修法）

| # | 行动项 | 对应发现 | 修法要点 | 预估改动 |
|---|---|---|---|---|
| P0-1 | heartbeat tick 互斥 | F2 / H1（07-23 M1 遗留） | `tickOnce` 加 `ticking` 标志跳过重入；或仿 reminders 加 in-flight 租约；至少 `recordTick` CAS | 1 文件 ~15 行 + 测试 |
| P0-2 | DingTalk 出站超时 | F1 | `sendTemplated`/`downloadMessageFile` fetch 加 `AbortSignal.timeout(30s)`；worker `doSend` 包 60s 整体超时 | 2 文件 ~20 行 + 测试 |
| P0-3 | 崩溃恢复语义对齐 | F3 | `reapStaleRunning` 对 `kind='inline'` 置 `interrupted` 而非 `failed` | 1 文件 ~5 行 + 测试 |
| P0-4 | en 词典去中文 | U1/U2/U3 | i18n.ts en 词典改英文、start 横幅走 i18n、`resolveCliLang()` 按 LANG 回退；加"en 词典无 CJK"断言测试 | 2 文件 + 1 测试 |

### P1 · 建议本月内（体验与韧性提升）

| # | 行动项 | 对应发现 | 修法要点 |
|---|---|---|---|
| P1-1 | WS 服务端心跳 | F4 | `setInterval` ping + isAlive + pong 超时 terminate；释放僵尸连接 |
| P1-2 | REST 顶层 try/catch | S2 | server.ts handler 包 try/catch → `sendError(res, 500, 'INTERNAL')`；设 `requestTimeout`/`headersTimeout` |
| P1-3 | callHelperAgent 超时纪律 | S3 | AbortController + clearTimeout + signal 透传 |
| P1-4 | SQLite broken 可恢复 | F6 | 周期重试 init（5min）+ 状态暴露到 `/api/service/status` |
| P1-5 | 错误码契约统一 | U8 | 高频 API 改 `sendError` + 语义 code；errors.json 补 key |
| P1-6 | 配置向导细节 | U4/U9/U7 | 删 `{id:'agim'}` 重复 spec；钉钉 Back 语义修正；token 菜单文案 |
| P1-7 | IM 双语错误模板 | U5 | `formatAgentNotAvailableError` 等高频错误 en/zh 双语 + per-user 语言记忆 |
| P1-8 | 依赖升级 | §5 audit | `npm audit fix`（ip-address/fast-uri/undici/hono/tar）；sharp 单独评估 |

### P2 · 建议排期（长期韧性）

| # | 行动项 | 对应发现 | 修法要点 |
|---|---|---|---|
| P2-1 | Loop 热路径内存化 | S1 | 活跃 run 内存态 + debounce 落盘；`getActiveLoop` 热路径查 Map |
| P2-2 | messenger.start 超时 | F7 | 每适配器 `Promise.race` 30s；worker/恢复不依赖全启动成功 |
| P2-3 | 入站 at-least-once | F5/F9 | wechat 入站先持久化再推进游标；去重 TTL 对齐恢复窗口 |
| P2-4 | 内存限额 | F11/S4 | active-runs partialText 400K 上限 + 快照 LRU；thread-queue 深度上限 |
| P2-5 | 数据保留策略 | F8/F12 | reminders prune；媒体清理中央化（不挂 Telegram） |
| P2-6 | restart 结果可感知 | F10 | 推送失败保留 pending 文件，启动补推 |
| P2-7 | 退役 loop 输入压缩 | S5 | 迭代内 token 预算截断（低优先，已退役路径） |

---

## 7. 亮点（值得保持）

1. **outbox at-least-once 设计扎实**：`claimForSend` 原子租约（outbox.ts:310-328）+ 崩溃后 `requeueStuckSending`（:340-364）保证"发送中未确认"的行重启后恰好重投一次；`dedup_key` 部分唯一索引 + giving_up 复活（:249-265）让 reminders 崩溃重发成为幂等 no-op；6 级 backoff + giving_up 保留 + 人工 retry（:81、:498-514）。07-23 指出的"旧库迁移破坏 outbox"与"giving_up 去重误判"已在 Unreleased 修复。
2. **调度层原子认领正确**：schedule CAS（schedule.ts:296-308）、reminders `pending→firing` 原子切换（:976-980）+ `dedupKey` + 崩溃恢复（:95-97）——与 heartbeat（F2）形成对照，说明团队具备该意识，只是 heartbeat 遗漏。
3. **优雅关闭与重启编排纪律好**：25s 硬截止（graceful-shutdown.ts:13-35）避免 systemd 30s 超时升级 SIGKILL；WAL checkpoint + 按序停 worker → 标记 interrupted → 关各 DB；restart preflight、stray pid 回收、pending 文件 stale GC。
4. **agent-loop 错误面收得干净**：`runAgentLoop` 所有返回路径调 `signal.cleanup()`；工具调度异常就地转 tool 错误而非上抛；流式解析按 index 累积 delta、半包安全丢弃；first-token 重试只针对明确瞬时错误；`dispatchToolWithTimeout` finally 清 timer。
5. **定时器纪律统一**：所有周期定时器 `unref()` + stop/close 路径；事件总线 recent 环形缓冲有上限；SSE 订阅 close 时正确清理。
6. **质量门工程化**：typecheck/lint/test/i18n parity/endpoint contract 全套在 `verify:release` 串联；SPA bundle 预算 + `check:file-budget` 约束；契约漂移有自动检测。

---

## 8. 审查方法与范围

- **维度分工**：可用性（投递/恢复/适配器/降级）、易用性（CLI 引导/Web/契约/文档一致性）、稳定性（循环/并发/调度/存储/资源）三个并行深读 + 主 agent 精读（outbox、message-sink、router、heartbeat、start-runtime、graceful-shutdown、sqlite-helper、wechat 适配器、server.ts、config-schema）+ 全量验证门。
- **回源纪律**：所有 finding 均以 `文件:行号` + 关键代码行为证；未验证疑点一律未收录；关键证据由主 agent 二次复核。
- **范围边界**：安全面（XSS/注入/权限）沿用 07-23 基线结论 + 本轮复核其修复状态，不重复展开；未做动态运行/压测（无真实 IM 凭证），测试结论基于 `npm test` 实测。
- **测试环境说明**：macOS 本机；2 个失败为 `/tmp`→`/private/tmp` 平台差异，2 个超时为并行负载 flaky（单独重跑通过），均非产品缺陷。
