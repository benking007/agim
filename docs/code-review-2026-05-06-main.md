# im-hub Code Review — main 分支 (v0.2.15)

> 基准：`c571ce4` (v0.2.15)，91 个源文件，TypeScript / Node ≥ 18，better-sqlite3 + WAL。
> 对比基线：`docs/code-review-2026-04-30-main.md`（v0.2.13）。
> 审查维度：架构 / 安全 / 并发 / 可观测 / 维护性 / 多租户对齐。
> 审查方法：5 个并行 Explore 子代理覆盖核心、Web/ACP、HITL approval、IM adapters、持久化层；主线程逐条复核行号与上下文。
> 验证缺口：本次未在本地跑 `tsc`/`bun test`（环境无依赖），故仅做静态审查。CI 已在 GitHub Actions 跑 typecheck+build+test。

---

## 一、相对 v0.2.13 的主要增量

| 领域 | v0.2.13 | v0.2.15 | 评价 |
|------|---------|---------|------|
| **IM 增量** | WeChat / Telegram / Feishu | + Discord (discord.js Gateway) | ⭐ 补齐主流 |
| **HITL approval** | 无 | MCP sidecar + approval-bus + approval-router (跨 IM 平台一致) | ⭐⭐ 重大新能力 |
| **Tasks Dashboard** | jobs / schedules | + bgjobs (`~/.claude` + `~/.config/opencode`) + 扁平 subtasks | ⭐ 运维友好 |
| **Telegram** | 文本 | + 图片 / 语音附件，`/plan on\|off` 模式，会话 sticky | ⭐ |
| **Codex / OpenCode** | stub | codex cwd/session resume；opencode HTTP driver + 跨切换会话保留 | ⭐ |
| **Feishu** | 偶发双触发 | message_id 10-min TTL 去重 | ✅ 已修 |
| **Approval auto-allow** | — | `'all'` 选项 + 前缀 fingerprint，receipt + revoke + `/approval status` | ⭐ |

整体：**架构连续演进，工程质量延续 v0.2.13 的标准；新增的 HITL approval 是亮点，但同时引入了一批 socket / 并发 / 鉴权层面的边角问题需要收口。**

---

## 二、Punch List（按严重度分组）

> 命名空间：`H` HIGH（建议立即修） · `M` MEDIUM（下个迭代） · `L` LOW/NIT（看心情）。
> 每条均给出 `file:line` 与最小重现片段。

### HIGH

#### H1 — Web REST `/api/*` token 比较非常时安全
- `src/web/server.ts:84-89`
  ```ts
  const token = req.headers['x-im-hub-token'] as string || ''
  if (token !== webToken) { res.writeHead(401); res.end(...); return }
  ```
- 同仓的 `src/core/acp-server.ts` 已正确使用 `crypto.timingSafeEqual` 做常量时比较，但 main web server 没有。受网络延迟噪声所限，HTTP timing attack 在公网未必稳，但 LAN/同机情况下可逐字节探测。
- **修法**：抽 `safeEqual(a,b)` 工具函数（acp-server 已有），两处共用。

#### H2 — `webToken` 注入 HTML 时未做 JS 转义
- `src/web/server.ts:894`
  ```ts
  html = html.replace('</head>', `<script>window.IMHUB_TOKEN='${token}';</script></head>`)
  ```
- 当前 token 是服务端生成的随机串，攻击窗口窄；但若未来 token 来源扩展（环境变量 / 用户输入），含 `'`、`\`、`</script>` 都会破出字符串字面量。
- **修法**：`window.IMHUB_TOKEN=${JSON.stringify(token)}`，零成本。

#### H3 — Schedule webhook `notify_url` 无校验，存在 SSRF
- `src/core/schedule.ts:164-184`
  ```ts
  if (s.notify_url) {
    await fetch(s.notify_url, { method: 'POST', ... })
  }
  ```
- `notify_url` 来自 `/schedule add` 命令或 REST 创建。即使创建路径是 token 鉴权的，此处仍会向任意 URL 发 POST：
  - 内网探测：`http://127.0.0.1:6379/`、metadata 服务（`169.254.169.254`）
  - 协议穿越：`file://`（fetch 会拒，但行为未来可能放宽）、`gopher://`
- **修法**：(1) 仅允许 `http(s):`；(2) 拒绝 RFC1918 / link-local / loopback（除非显式 opt-in）；(3) 加超时 + size cap。

#### H4 — `RateLimiter.cleanup()` 永不被调用，bucket Map 无界增长
- `src/core/rate-limiter.ts:73-83`（定义）；全仓 `grep userLimiter\|agentLimiter\|\.cleanup(` 仅有定义、`session.cleanup` 与 approval 测试，**没有任何代码调用 `userLimiter.cleanup()` / `agentLimiter.cleanup()`**。
- 单进程长时间运行 + IM 千级唯一 userId（尤其大群）下，Map 无清理 → 内存线性增长。
- **修法**：在 `cli.ts` 的启动流程里 `setInterval(() => userLimiter.cleanup(), 30 * 60_000).unref()`；`Workspace` 实例的 limiter 同样需要。

#### H5 — `/job` `/schedule` `/audit` 命令缺鉴权 / 跨用户可见
- `src/core/commands/job.ts`、`src/core/commands/schedule.ts`、`src/core/commands/audit.ts` 不读 `ctx.userId` 也不接 workspace 边界：
  - `/job list` 列出全实例所有用户的 job
  - `/job cancel <id>` 可取消他人作业
  - `/audit user=<id>` 可查任意用户
  - `/schedule rm <id>` 可删全局任意调度
- 与 README 强调的 "multi-tenant workspaces" 直接矛盾。
- **修法**：每条命令在执行前调用 `workspace.resolve(userId)`，`/job` 类查询附加 `WHERE workspace_id = ? OR creator_id = ?`，`/audit` 默认只许查自己；并把 mutate 类命令加进 audit 流。

#### H6 — Job result 大小无上限
- `src/core/job-board.ts:173-181`
  ```ts
  let fullText = ''
  for await (const chunk of runner(...)) { fullText += chunk }
  updateJob(id, { status: 'completed', result: fullText, ... })
  ```
- agent 一次输出几百 MB（误产 / 失控循环 / 大文件 dump）会直接吃满堆；写入 SQLite 的 TEXT 列也无 trigger 拒绝。
- **修法**：`MAX_JOB_RESULT_BYTES`（默认 1 MiB），超出截断 + 标注 `truncated`，并把超额 dump 写到 `~/.im-hub/jobs/<id>.log`。

#### H7 — Job 表无 retention / GC，长期无界增长
- `src/core/job-board.ts` 全文无 DELETE / prune；`audit-log.ts` 已实现 30 天扫除，job-board 没跟上。
- 1 TPS 持续运行 ≈ 86,400 行/天，半年百万级；`listJobs` 走全表扫 + ORDER BY，长期会慢。
- **修法**：每 6 小时 `DELETE FROM jobs WHERE completed_at < ?`（默认 30 天），并在 `created_at` 加索引。

#### H8 — `settings.html` ACP 测试按钮引用未定义变量（功能必坏）
- `src/web/public/settings.html:718-729`（子代理读到的位置）
  ```js
  body: JSON.stringify({ endpoint, auth }),  // 未定义
  ```
- 点击「测试连接」会抛 `ReferenceError`，整功能不可用。这条不是安全问题，是**回归**。
- **修法**：从表单读 `document.getElementById('acpEndpoint').value` 并构造 `auth` 对象；同步删掉重复的第二份调用。

#### H9 — WeChat 凭证落盘未限权限，token 明文
- `src/plugins/messengers/wechat/ilink-adapter.ts:15`
  ```ts
  const CREDENTIALS_FILE = join(homedir(), '.im-hub', 'wechat-credentials.json')
  await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2))
  ```
- 默认 umask 下文件 mode = `0644`；多用户主机上同机用户可读取。
- **修法**：`mkdir(..., { mode: 0o700 })`，`writeFile(..., { mode: 0o600 })`；启动时 `fs.stat` 检查并 warn 修复。同样的处理建议下沉到所有 secrets 落盘点（telegram、feishu、discord、acp auth）。

#### H10 — Telegram 文件下载 URL 直接拼接 botToken
- `src/plugins/messengers/telegram/telegram-adapter.ts:358`
  ```ts
  const url = `https://api.telegram.org/file/bot${this.config!.botToken}/${file.file_path}`
  ```
- 任何 fetch 错误 / 超时栈、抓包、HTTP 客户端日志都会带出 token。pino 默认不 redact 该字段。
- **修法**：(1) logger 配置 `redact: ['url', 'config.botToken']`；(2) 错误日志只记 `file.file_path`，不记完整 URL；(3) 也可以 wrap 一层 `getFileUrl(): URL`，强制只 toString 给 fetch 内部用。

#### H11 — Approval bus 的 unix-socket 路径可预测
- `src/core/approval-bus.ts:199-216`（创建 socket）
  socket 路径包含 `process.pid` 与 `Date.now().toString(36)`。容器中常见 PID = 1，时间戳熵约 6 字符 ≈ 1M/分钟可枚举；Node `unlink + listen` 间存在 TOCTOU。
- 攻击场景：同主机非特权用户预占该路径并打开监听，im-hub 启动时 `unlink` 失败回退或被绑到攻击者控制的 socket → 任意工具调用可被替身代为批准。
- **修法**：(1) 路径用 `randomBytes(16).toString('hex')`；(2) `mkdtemp(0o700)` + 在该 dir 内创建 socket；(3) 落地后 `fs.fstat` 校验 mode == `0600` 与 owner 是 `process.geteuid()`。

#### H12 — `Session.addMessage` 并发交错可能丢消息
- `src/core/session.ts:266` 附近：
  ```ts
  const session = this.cache.get(key) ?? await load(...)
  session.messages.push(msg)
  await Promise.all([appendLog(...), writeMeta(...)])
  ```
- 同一 thread 并发 `addMessage`（IM 平台事件 + tool-result 事件 + 用户回复几乎同时到达）：A 读 → push → B 读旧拷贝 → push → A 写 → B 写覆盖 → 丢失 A 的消息。
- 当前虽然 IM 单 thread 并发概率不高，但 sticky session + bgjob 完成回写会触发。
- **修法**：每个 sessionKey 一个 promise-chain（`pLimit(1)`/per-key mutex），所有 `addMessage` `setMeta` 串行化；或改 SQLite 单事务 INSERT。

---

### MEDIUM

#### M1 — 静态页缺基础安全响应头
- `src/web/server.ts:887-901`：仅设了 `Content-Type` + `Cache-Control`。
- 缺：`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'self'`（脚本可保留 `unsafe-inline` 直到把内联 token 拆出去）。
- 该 server 默认 `0.0.0.0` listen，公网暴露场景不少，加一波几乎零成本。

#### M2 — Prometheus 标签基数无上限
- `src/core/metrics.ts:195-234`：`im_hub_intent_total{intent="..."}`、`im_hub_platform_total{platform="..."}` 标签来自路由分类结果。LLM 兜底分类时 intent 可能出现自定义字符串；platform 来自 IM ID（如 telegram chat id）。
- **修法**：给 intent 限定枚举白名单，未识别归 `unknown`；platform 取 adapter.name 而非 chat-level id。

#### M3 — WS 无连接数 / 速率上限
- `src/web/server.ts:170-215`：`wss.on('connection', ...)` 仅校验 token，没有 per-IP 计数与全局 cap。token 泄露后或反向代理失误下，可被打满。
- **修法**：连接表里限 `MAX_WS_CLIENTS`（默认 100），按 IP 桶限速。

#### M4 — `/api/health` 无鉴权
- `src/web/server.ts:153-154`：路由匹配在 `/api/*` 鉴权块**之前**？看代码位置在 `if (url.pathname.startsWith('/api/'))` **之后**仍然鉴权。但查阅逻辑发现命中 `/api/health` 时已经过 `token !== webToken` 检查（line 85），返回 200 表明鉴权确实生效。
- 但 `handleHealth` 的语义本身适合无鉴权（k8s 探针），目前的副作用是 k8s liveness 必须配 token。**建议**：把 `/api/health` 显式提到鉴权块之前，作为公开端点；只暴露 status，不返回内部结构。

#### M5 — Cron `nextOccurrence` 用 local time，时钟跳变易漏 / 重触发
- `src/core/cron.ts:145-204` + `src/core/schedule.ts:113-150`：基于 `Date` 的 local 字段。DST、NTP 校正、容器时钟同步都可让 30s tick 算出错乱的下一次时间。
- **修法**：内部统一 UTC（`Date.UTC`/`getUTCHours`），cron 表达式仍按 local 解释；启动时落盘 `last_fired_at`，启动后只对超过 `last_fired_at` 的 due 触发。

#### M6 — Workspace 白名单仅在路由层；命令直通
- 路由 `src/core/router.ts:204-206` 检查 `workspace.hasAgent(agent)`，但 `/job create <agent>` (`commands/job.ts:50-93`) 与 `/schedule create <agent>` (`commands/schedule.ts:64`) 不查白名单。
- **修法**：把白名单检查抽到 `dispatchAgent(ctx, agentName)` 公共入口，路由 + 命令统一过。

#### M7 — Audit 30 天修剪静默失败
- `src/core/audit-log.ts:174-189`：`pruneExpired` 失败仅 `log.warn`。磁盘只读 / I/O 错误时审计会无声膨胀。
- **修法**：连续 N 次失败 → 上抛到 metrics counter `im_hub_audit_prune_failed_total`，面板可告警。

#### M8 — Circuit breaker half-open 并发探测放行多于一个
- `src/core/circuit-breaker.ts:69-86`：`isOpen()` 在 cooldown 到期后切 half-open 并返回 false，但读改写不是原子的。两个并发请求可能都被放行成探测请求。
- **修法**：用一个 `halfOpenInFlight` 标志位（`compareAndSet`-语义），只许一个；其它请求直接 deny。

#### M9 — IM 长链路缺显式 backoff/jitter
- Feishu / Discord / Telegram 重连依赖各自 SDK 默认；wechat ilink 自实现 long-poll 但 backoff 不够明显。
- 三类风险：(1) 鉴权挂时无限快重连打 IM 平台；(2) 多实例同时挂同时重连产生 thundering herd；(3) 网络抖动下没指数退避会烧 CPU。
- **修法**：抽公共 `withBackoff(fn, { base: 1s, cap: 60s, jitter: 0.5 })`。

#### M10 — `message-split` 按 UTF-16 code unit 切，可能切到 emoji 代理对中间
- `src/utils/message-split.ts:17-66`：`remaining.slice(0, splitPoint)` 按 `.length` 截。
- 风险：emoji（U+1F600 这类高位字符）2 个 code unit；切边界落在中间会出现孤代理。Telegram/Discord 客户端通常显示 □；安卓 grammy 会抛错。
- **修法**：用 `Intl.Segmenter('grapheme')` 或至少 `for of` + `Array.from(s)` 按字符切；同时保护 markdown ``` 围栏不被切断。

#### M11 — `handleAcpTest` 内 `JSON.parse` 无 try/catch
- `src/web/server.ts:667`：恶意客户端发非 JSON body 会冒出 SyntaxError，看 stack 可能露内部细节。
- **修法**：parse 包 try/catch，返 400。

#### M12 — Telegram HTML 转义未覆盖 `'`
- `src/plugins/messengers/telegram/telegram-adapter.ts:582-584`：仅 `& < >`。
- 当前用法主要 text node，问题不大，但 approval card 里有 `<a href="...">` 之类属性场景，单引号未转可能闭合。
- **修法**：补 `' → &#39;`；如果有属性场景，连双引号也补。

#### M13 — Approval auto-allow fingerprint 取前 5 字符 → 大量碰撞
- `src/core/approval-bus.ts:646-648`：rule key = `${toolName}::${fingerprint}`，fingerprint 是 input 字段前 5 字符。
- `bash::git s` 同时命中 `git status` / `git stash` / `git submodule update --init --recursive`，用户预期中的"批准 git status"会被误用为"批准任意 git 子命令"。
- **修法**：(1) UI 侧明示「auto-allow 覆盖前缀变体」；或 (2) 提升前缀长度到 12+；或 (3) 改用 SHA-256(canonical input) 的前 16 位。

#### M14 — Approval bus pending Map 无运行时观测
- `src/core/approval-bus.ts:169` (`pendingById`) 仅在 resolution / timeout 时清。若有 corner case 漏清（bug 或 sidecar 异常退出），无法从外面看出来。
- **修法**：导出 `getMetrics()` → `{ pending, resolved, timedOut, denied }`，挂到 `/api/metrics`。

#### M15 — `intent-llm.makeKey` 拼接 candidates 无长度上限
- `src/core/intent-llm.ts:101-103`：cache key 以分隔符 join，长 candidates 列表 + 长 text 会撑大 LRU 内存。当前不算 ReDoS 但属内存放大。
- **修法**：candidates 取 hash + text 截 256 字。

---

### LOW / NIT

| # | 文件:行 | 现象 | 备注 |
|---|--------|------|------|
| L1 | `src/web/server.ts:803-806` | WS 流式发送未检 `bufferedAmount` 背压 | 慢客户端会让队列长 |
| L2 | `src/core/sqlite-helper.ts` | 进程退出前未 `db.close()` | WAL 落盘交给 GC，重启可能要做 recovery |
| L3 | `src/core/transcribe.ts:105-188` | OpenAI / whisper.cpp 各自 120s，总壁钟可达 240s | provider 串联应用累计预算 |
| L4 | `src/core/types.ts:331` | `Config: { [key:string]: unknown }` 失去拼写检查 | 历史包袱 |
| L5 | `src/core/logger.ts:34` | traceId 12 hex (≈ 2^48) 高负载下碰撞概率非零 | 升 16 hex |
| L6 | `src/plugins/messengers/wechat/ilink-client.ts` | 7 个 fetch 中 5 个无 `AbortSignal.timeout` | 偶发挂起拖死 long-poll |
| L7 | `src/plugins/messengers/discord/discord-adapter.ts:94-98` | typing interval 不配 `AbortController`，stop() 时残留 | 关机延迟 |
| L8 | `src/plugins/messengers/telegram/markdown-to-html.ts:68-75` | 表格按字符数截，CJK 字符宽度不一 | 视觉不齐 |
| L9 | `src/core/job-board.ts:205-215` | `cancelJob` 不校验状态机（可 cancel 已 completed） | 审计混乱 |
| L10 | `src/core/approval-bus.ts:332-336` | socket buffer 超 1 MiB 静默 destroy，sidecar 等 30 min | 应先回 deny |
| L11 | `src/core/cli.ts:294` | `await new Promise(()=>{})` 永不解决 | 仅靠信号退出 |
| L12 | `src/core/router.ts:289-297` | classifyIntent 异常被吞为 fallback | 调试难 |
| L13 | `src/core/agent-base.ts:414` | `plan.cleanup()` 异常仅 warn，资源可能未清 | tmpdir 残留 |
| L14 | `src/plugins/messengers/wechat/ilink-adapter.ts:31` | `contextTokens` Map 仅在 send 路径上清 expired | 周期清扫 |
| L15 | `src/core/onboarding.ts:150-151` | 注释与实现不一致 | 注释更新 |

---

## 三、横向关注点

### 3.1 多租户模型尚未对齐
README 与配置 schema 强调 multi-tenant workspace（agent whitelist + rate limit + member 列表），但权威边界只在 `router.ts` 默认路径上落实：
- `/job` / `/schedule` / `/audit` 命令绕过（H5、M6）
- `/api/jobs` / `/api/schedules` 全局可见（被 web token 鉴权，但同一 token 内所有 workspace 通用）
- workspace.rateLimit 已生效，但 `userLimiter`（默认）依然全局共享，不同 workspace 用户之间会争抢

**建议**：把 "workspaceId 是访问控制主键" 这一不变量落到一处中间件（`requireWorkspace(ctx)`），所有写操作都过它；命令 dispatch 时把 ctx.workspaceId 携带进 SQL `WHERE`。

### 3.2 Secrets 处理需要全局策略
- WeChat（H9）、Telegram（H10）、Feishu / Discord / ACP 都各自落盘或拼接 token；当前没有统一的 redaction / 文件权限规范。
- **建议**：(1) `src/core/secrets.ts` 提供 `writeSecret(file, payload)` 强制 `0o600` + parent `0o700`；(2) pino 启动时全局 `redact: ['*.botToken','*.apiKey','*.secret','*.token','headers.authorization','config.discord.botToken']`；(3) 错误日志 helper `redactUrl(url)` 把已知 token 字段从 URL 抹掉。

### 3.3 HITL approval 链路是亮点但还不够"防误伤"
- 默认拒否（denied-by-default）已经做到（注释 + 测试覆盖）；
- 但用户语义边界不清：
  - 在 pending 期间任何文本都视为隐式拒（U/X：用户继续闲聊变了误拒 — L 级体验问题，approval-router 已记 redirect 日志）
  - auto-allow 前缀过短（M13）
  - 同 thread 多 pending 队列已实现（test 覆盖），但同 thread 不同 run 的串接顺序在 approval-router 中没显式锁

**建议**：(1) approval card 文案显式列「在我决定前继续聊会自动拒」；(2) `/approval status` 输出 fingerprint 长度与覆盖范围；(3) 为多 pending 写一条端到端测试模拟「opencode HTTP 同 thread 三连发」。

### 3.4 时间相关代码需要统一
跨多处出现 `Date.now()` / `new Date()` / `local time` 混用：cron（M5）、rate-limiter（已确认 not bypass-able 但 lastRefill 不更新负值时仍有风格问题）、session metaStale、approval timeout。
**建议**：抽 `src/core/clock.ts: { nowMs, hrtime }`，测试时可注入；cron 内部全 UTC。

### 3.5 测试覆盖
强项：approval pipeline（4 测试文件）、bgjob-reader、feishu dedup、telegram media-download、cron、router；
覆盖不足：
- WS 多客户端 / 慢客户端背压
- SSRF 用 `notify_url` 攻击向量
- workspace 鉴权穿透（任何用户能不能调他人 jobs）
- 时钟跳变下 cron / rate-limiter 的稳定性
- 长 prompt 大 result 触发 H6 的边界
- 多用户场景下 approval socket 隔离

---

## 四、修复优先级建议

| 阶段 | 范围 | 对应条目 |
|------|------|---------|
| P0（本周内 hotfix） | 暴露漏洞 / 必坏功能 | H1, H2, H3, H8, H10 |
| P1（v0.2.16） | 长跑稳定性 / 多租户对齐 | H4, H5, H6, H7, H9, H11, H12, M5, M6 |
| P2（v0.3.0） | 生态与硬化 | M1–M15、HITL UX、secrets 全局策略 |
| 持续 | 代码质量 | LOW 表 + 测试补全 |

---

## 五、整体评价

**架构成熟度**：⭐⭐⭐⭐ — plugin 化清晰、单进程边界明显、SQLite + WAL 选型务实、HITL 链路设计有想法。

**安全姿态**：⭐⭐⭐ — 有意识（zod schema、ACP 常量时比、approval 默认拒），但执行不齐（webToken 比较不一致、SSRF、文件权限、token 落 URL、命令鉴权空缺）。

**多租户兑现**：⭐⭐ — README 写好了，落地仅一半，命令面 / API 面留有越权口子。

**可观测**：⭐⭐⭐⭐ — pino + traceId + Prometheus 已经超过同类项目均值，差一点就是 cardinality 控制。

**测试**：⭐⭐⭐⭐ — 覆盖路径合理，但缺并发 / 安全负向用例。

**结论**：v0.2.15 是一次内容很满的迭代，HITL approval 与 Discord 都是大件。下个 sprint 把 H1–H12 拿掉、把 multi-tenant 落实到命令面，整体水位会再上一档。

---

*Reviewed by 5 parallel Explore agents + main-thread verification on `c571ce4`. 行号针对该 commit；后续重排请以 git blame 为准。*
