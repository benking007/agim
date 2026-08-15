# Agim 功能实用性评估与取舍建议（2026-08-15 · v1.6.1）

> **目的**：为功能裁剪决策提供依据。按「必须保留 / 建议精简合并 / 建议降级 / 建议裁掉」四档给出清单，附维护成本与引用风险。
> **方法**：3 个并行深读（插件层 / 核心 AI 能力 / 用户面）+ 主 agent 交叉验证关键发现。所有结论附 `文件:行号` 证据，只读未改码。
> **一手基准**：`docs/architecture/retirement-candidates.md`（官方退役清单，2026-07-26）与本评估交叉验证——官方自评（plans UI、chat-docks、Viewer 隧道、Search/STT 降级）与本评估高度一致；**新增发现**：heartbeat 自动调度器死代码、`/sessions` 外部依赖、SPA token 死链、native-agent 路由死/模块活。

---

## 0. 最重要结论（非直觉，先读）

1. **README 宣传的 heartbeat「自动 proactive loop」目前根本不运行**：`startHeartbeatScheduler()`（`src/core/heartbeat.ts:356`）全树零调用者；`start-runtime.ts:385-390` 只启动了 schedule 与 reminders。生产环境自动 tick 从未跑过，仅 `/heartbeat run-now` 手工可达；1.5.99 修的重叠 bug 实际在死路径上。README:90 还把 heartbeat 文档指到 `reminders.md`（该文件 0 处 heartbeat）。→ **二选一：start-runtime 补一行启动调用（激活卖点），或删调度器死代码降级为 run-now 工具。**
2. **goals.ts / goal-evidence.ts 不是退役残留，是承重墙**：用户面 `/goal` 已退役，但存储与证据层被 focus.ts（12 个 import）、a2a.ts:42、agim-agent/index.ts:78（goal-critic 偏航检测）、tool-bridge（exec 审批围栏）依赖。删除会连锁击穿 /focus、A2A 与 Agim Agent 工具安全。**不可删**。
3. **claude-code 是「CLI 生态的基础设施」而非普通 agent**：共享 MCP 审批 sidecar（`claude-code/mcp-approval-server.ts`）被 8 个 CLI agent 引用（copilot/kimi/mimo/qoder/cursor/antigravity/codex/opencode）。删 claude-code 前必须先提取 sidecar。

---

## 1. 四档结论清单（决策入口）

### 🟢 必须保留（核心资产，动前需正式立项）

| 域 | 项 | 理由（摘要） |
|---|---|---|
| IM | wechat / feishu / dingtalk / email | 国内立身之本（README 首列）；wechat 附件能力最全、feishu/dingtalk 官方 SDK 免 webhook、email 是 reminder/outbox 投递兜底（160 行，裁剪收益≈0） |
| IM | telegram（门控内） | 海外最佳 HITL/附件；门控实现≈0 成本且是安全姿态，保留 |
| Agent | agim-agent + agim-agent-shared | 零安装默认路径 + Loop/Subagent 唯一宿主 + 近期迭代最密集处（61 提交/3 月） |
| Agent | claude-code / codex / opencode(stdio) / pi | 前两者派工默认（`dispatch-routes.ts:22`）；opencode stdio 被 bgjob/skills 硬依赖；pi 与 agim-agent 同源引擎 |
| AI 能力 | Loop 全家桶、subagent/a2a、approval 系、outbox、reminders、memory 流水线、skills、session 系、focus、memos、ask-user、audit-log、job-board/recovery、intent 双实现、prompt-injection-guard、workspace、coord、goals/goal-evidence | 见 §3 组 A |
| Web | chat `/`、`/m/chat`、`/setup`、`/login`、`/approvals`、`/workspace`、`/memos`、`/reminders`、settings/{llm,messengers,agents,security,service,policy}、tasks/{overview,jobs,outbox}、memory/{facts,persona,vector,distill}、observability/{health,audit} | 核心链路页（chat 26 提交/3 月最活跃） |
| CLI | `agim`（入口菜单）、go、web、start/stop/restart/status、doctor、diag、token、uninstall、quickstart | **token 必须留**：Web 无 token 管理 UI，且 `health-api.ts:313` 的 revokeHint 指向不存在的 `/settings/security/tokens`（死链，顺带修） |

### 🟡 建议精简/合并（保留功能，砍重复面）

| 项 | 做法 | 收益 |
|---|---|---|
| tasks 11 页 → 4 页 | jobs+subtasks+bgjobs 合并（同驻 jobs-api.ts）；outbox+a2a 合并「投递」（同驻 outbox-a2a-api.ts）；schedules+heartbeat 合并「自动化」（overview 已做 stats 相加）；asks→approvals 并入（同为 HITL 队列） | 消除导航碎片化；6 页纯只读查看器收拢 |
| memory 6 页 + 2 form → 4 页 | overview 并入 layout 状态条（它重读 4 端点纯冗余）；distill-config-form + vector-backend-form（各 ~400 行近同构 env 表单）抽共享 env-form 原语 | 消 2×400 行同构 |
| observability 3 → 2 页 | health + topn 是同一 invocation store 的两个 pivot（列集完全相同），一页两 tab | 消重复 pivot |
| dashboard ≈ settings/start | 两页同用四查询 + 同一状态卡模型，dashboard 吸收 start | 消一页 |
| approval/ask-user 基座合并 | 两套 pending 注册表/超时/router install 归一（ask-user 头注释自称走 approval-bus 但实际无此方法，陈旧注释） | 约省 200 行 |
| 会话级开关持久化归一 | focus/plan/think/step-reflect 四个 flag 分散在 session 行 + goals.db + plan-mode.db + plan-history.db 三库，归一 session 行 | 消三库分散（远期） |
| 文档修正 | memory-distill.ts 头注释、memory-and-vector.md:20（/memo 实走 memos.db 非 facts）、README:90 heartbeat 文档指针 | 消宣传与实现落差 |

### 🟠 建议降级（保留代码，收窄入口/停止投入）

| 项 | 做法 |
|---|---|
| `agim config` 向导（1249 行） | 7 段全被 Web settings 覆盖（docs/first-run-setup.md:4 已背书"配置在浏览器里完成"）→ 仅文档/兜底 |
| `agim setup llm` / `setup mcp` | 与 Settings→LLM / →MCP 高重叠 → 仅文档 |
| `agim tui`（3721 行） | 与 Web chat 高重叠，但无 GUI/SSH 场景必需 → 保留功能、收敛宣传位 |
| `/settings/search` + `/settings/stt` | 提供商矩阵降「高级/CLI-only」（官方已列）；stt 19 提交高活跃但使用面窄，保留 whisper.cpp + openai + 1 中文云商 |
| `/settings/viewer` 隧道设置 | 藏设置项（cloudflared quick tunnel 偏冷，官方已列） |
| `/settings/workspaces` | 折叠/标注「多租户」（单机无用） |
| copilot / kimi-code / antigravity / cursor | 从「支持的 agent」宣传（README:74）降为「兼容但非主推」；adapter/画像保留（各有独有画像：GitHub 生态/中文长上下文/Gemini/IDE），进入社区维护状态 |
| heartbeat 自动调度器 | 二选一：start-runtime 补一行启动（推荐，激活 README 卖点）或删死代码降级 run-now（命令面/SPA 不可连带删，background-tasks-api.ts:57 依赖） |
| metrics.ts（422 行） | /api/metrics admin-only、SPA 零消费 → 保留端点不再投入 |
| agent-profiles.ts | 保留派工画像面，降投入（3 月仅 4 条 CHANGELOG） |

### 🔴 建议裁掉（安全，破坏面已核实）

| 项 | 依据 |
|---|---|
| `commands/setup.ts`（17 行） | 废弃 shim，tech-debt 软弃用 |
| `commands/sessions.ts`（103 行） | 依赖外部 `AGIM_DASHBOARD_URL:8001` 服务，个人用户必然 ECONNREFUSED |
| `/dev/chat-docks-preview` | 未挂导航、无鉴权（router.tsx:197-198），官方已列 |
| `/settings/native-agent` 独立路由 | 死重定向（router.tsx:169）；`NativeAgentSettingsPanel` 保留在 llm.tsx:58 嵌入 |
| `/tasks/plans` UI | 官方已列；保留 `/api/plans` 审计 API |
| mimo 或 qoder 二选一 | 画像逐字重复（agent-profiles.md:28,30 均"通用编码 CLI"）、零独立迭代；保留其一 + 文档指引 |
| opencode http 驱动 | 自身承诺"promote 后 drop 开关"（opencode/index.ts:1-13），保留 stdio |
| discord（可选收紧） | 能力最弱（matrix 第 24/34 行）+ 唯一拖入 undici 漏洞的依赖；代码不必删，门控已天然关闭 |

---

## 2. 分域总览表

### 2.1 IM 通道（代码量 / 实用性 / 维护成本 / 建议）

| 通道 | 代码量 | 实用性 | 维护成本 | 建议 |
|---|---|---|---|---|
| wechat (iLink) | 1780 | 高 | 高 | 保留（骨架；iLink 逆向协议是最大外部稳定性单点，配套 runbook 预案） |
| feishu | 697 | 高 | 低 | 保留（官方 SDK 免 webhook；零迭代=稳定） |
| dingtalk | 1411 | 高 | 中 | 保留（官方 Stream 免 webhook；richText 多形态兼容） |
| email | 160 | 中 | 低 | 保留（reminder 投递兜底，勿删） |
| telegram | 1664 | 高(海外) | 中 | 保留 + 门控 |
| discord | 388 | 中(海外) | 中低 | 精简候选（能力最弱 + undici 依赖风险），门控保留 |

### 2.2 Agent 后端（代码量 / 实用性 / 维护成本 / 建议）

| 后端 | 代码量 | 实用性 | 维护成本 | 建议 |
|---|---|---|---|---|
| agim-agent | 4019 | 高 | 高 | 保留（立身之本） |
| claude-code | 2024 | 高 | 中 | 保留（共享 MCP sidecar 宿主） |
| opencode | 1623 | 中高 | 高（双驱动） | 保留 stdio；裁 http 驱动 |
| pi | 798 | 中 | 中 | 保留（与 agim-agent 同源引擎） |
| codex | 527 | 高 | 中 | 保留（派工默认） |
| antigravity | 501 | 中 | 低 | 精简（Gemini 画像差异化，可留） |
| cursor | 440 | 中 | 低 | 精简候选 |
| kimi-code | 412 | 中 | 低 | 精简候选（中文长上下文画像） |
| copilot | 349 | 中 | 低 | 精简候选（GitHub 画像差异化） |
| mimo | 356 | 中 | 低 | **合并候选**（与 qoder 画像重复） |
| qoder | 312 | 中 | 低 | **合并候选**（与 mimo 画像重复） |

### 2.3 核心 AI 能力（代码量 / 实用性 / 建议）

| 模块 | 代码量 | 实用性 | 建议 |
|---|---|---|---|
| loop-run + 6 门禁 | 2264+ | 高 | 保留，拆导出面 |
| approval 系（bus/router/policy） | 1125+812 | 极高 | 保留（HITL 核心，作收敛主体） |
| session 系 | 1269+189+494 | 极高 | 不可裁（27 文件引用） |
| outbox | 549 | 极高 | 不可裁（README 头版卖点） |
| reminders | 1117 | 高 | 保留（65 测试用例） |
| memory 流水线 | 1124+ | 高 | 保留（distill/distiller/consolidate 是流水线非三套重复） |
| ask-user-rpc | 989 | 高 | 保留，与 approval 合并 pending 基座 |
| heartbeat | 390 | 低-中 | **接上启动 或 删死代码**（见 §0-1） |
| cron/schedule | 204+454 | 中 | 保留 |
| memos | 639 | 高 | 保留（位置功能绑定） |
| focus | 221 | 高 | 保留（goals.db 薄封装） |
| plan 四件套 | 176+117+132 | 高 | 保留，远期归一持久化 |
| think/step-reflect/btw | 41/74+200/58 | 中 | 保留，补文档（CHANGELOG/docs 全 0 记录） |
| coord 三件套 | 316+96+104 | 中 | 保留（memos 位置链路真实用户） |
| metrics | 422 | 低-中 | 保留端点，不再投入 |
| transcribe-*（8 文件） | ~1950 | 中 | 收敛云商（whisper.cpp + openai + 1 中文） |
| goals/goal-evidence | 606+708 | 中 | **不可删**（承重底座，见 §0-2） |

### 2.4 用户面（SPA 52 路由 + CLI 14 命令）

- **保留核心**：chat、m/chat、setup、login、approvals、workspace、memos、reminders；settings 核心 6 页；tasks 3 页；memory 4 页；observability 2 页；CLI 10 命令
- **合并**：tasks 11→4 页；memory 6+2→4 页+1 组件；observability 3→2 页；dashboard≈start
- **降级**：`agim config`/`setup-llm`/`setup-mcp` → 仅文档；search/stt → 高级折叠；viewer 隧道 → 藏
- **裁掉**：chat-docks、native-agent 独立路由、tasks/plans UI、commands/setup.ts、commands/sessions.ts
- **bundle 提示**：裁冷门页对 350KiB entry 预算几乎无帮助（均已 lazy）；entry 热点是 Chat 急切加载树，真降压路径是 chat route 整体 lazy

---

## 3. 分组要点（为什么）

### 组 A「核心卖点，必须保留」

Loop 工程（README 双位宣传 + loop-engineering.md 596 行 SSOT，R1-R5 已落地，R6 Heartbeat 触发官方暂缓）；subagent/a2a（分层非重复：a2a.ts:68 import subagent.ts，A2A ⊂ Subagent 实现手段）；approval（HITL 安全核心，tech-debt 已列"peel approval-bus"为收敛主体）；outbox（15+ 文件 + SPA + API 消费）；reminders（7 处引用 + email 通道）；memory 流水线 + vector（默认 FTS5 兜底、vector 可 env 独立关闭）；skills（tier-1 注入 + tier-2 RPC）；session 系（27 文件引用、3 月 37 条 CHANGELOG 最高频）；intent 规则版 + LLM judge 互补（非重复）；audit-log/stats（30+ 依赖方）。

### 组 B「有重叠可合并」

ask-user/approval 通道已半合并（共用 socket-rpc.ts:45 统一分发），残留两套 pending/超时/install 可归一；focus/plan/think/step-reflect **不是四套并行机制而是四个正交层**（注入/门禁/推理深度/循环节奏），真正合并点是持久化；coord 不是死代码（memos 位置链路 + 3 个 IM adapter）；audit-log/metrics 非两套数据（metrics 由 audit-log 供数）。

### 组 C「疑似低使用」

STT 云商矩阵（iflytek/tencent/baidu 零专属测试）；metrics（SPA 零消费）；/sessions（外部依赖）；/setup 命令（自述废弃）；chat-docks（未挂导航）；agent-profiles（降投入）；/tasks/plans（官方已列）。

---

## 4. 裁剪前置依赖与风险（动手前必读）

1. **claude-code sidecar 耦合**：删/合并 claude-code 前必须先提取 `mcp-approval-server.ts` 为独立共享模块，否则 8 个 agent 全失效。
2. **跨文件接线面广**：每个 agent 涉及 registry/config-wizard/readiness/agent-cwd/agent-profiles/session-bindings/intent/plan.ts/SPA label/i18n 共 10+ 处 + adapter.test.ts；核心测试 21 个文件引用各 agent 名。
3. **代码路径硬编码**：`bgjob-reader.ts:83-84`（'opencode'/'codex'）、`workspace-skills-api.ts:44`（'claude'|'opencode'）——裁 opencode/codex/claude 会破坏 Tasks→Background 与 Skills。
4. **goals/goal-evidence 承重**：focus.ts 12 import + a2a.ts:42 + agim-agent/index.ts:78 + tool-bridge exec 审批围栏——"裁掉"会连锁破坏 /focus 与 Agim Agent 工具安全。
5. **reminders 引用面最广**：router.ts:365、remind-intent.ts:15、agim-dispatcher.ts:84、email adapter、jobs-api.ts:114、start-runtime.ts:389、graceful-shutdown.ts:109。
6. **focus/plan/think/step-reflect 删除破坏面**：focus→loop-run.ts:36；plan→native adapter policy denyList + portal 开关 + /tasks/plans；think/step-reflect→chat.tsx:457-462 拦截 + ws.ts:88-91 SSE 契约。
7. **文档与代码漂移**：memory-and-vector.md:20 称"/memo 手动写"进 facts（实际走 memos.db）；README:90 heartbeat 文档指针指错文件；`/settings/security/tokens` 死链（health-api.ts:313）。
8. **降级 ≠ 删代码**：copilot/kimi/antigravity/cursor 各 ≤700 行、已稳定，真正省成本的是停止新功能投入与收敛宣传面（README/文档/向导），删除反而要付 10+ 处接线清理成本。
9. **测试盲区**（合并前补）：tasks/{asks,heartbeat,plans,loops}、memory forms、settings/{search,stt,mobile,native-agent,agim-skills}、m/chat、use-background-tasks.ts hooks。

---

## 5. 建议实施顺序（低风险先行）

| 阶段 | 动作 | 风险 |
|---|---|---|
| **P0（本周，纯删除，破坏面已核实）** | ① commands/setup.ts ② commands/sessions.ts ③ /dev/chat-docks ④ native-agent 独立路由（保留嵌入面板）⑤ mimo/qoder 二选一（先同步 10+ 处接线 + 测试） | 低 |
| **P1（本月，激活或降级）** | ① heartbeat：start-runtime 补一行 `startHeartbeatScheduler()`（激活 README 卖点）或删调度器 ② `agim config`/setup-llm/setup-mcp 降级仅文档 ③ opencode http 驱动裁掉 ④ 修三处文档漂移 + token 死链 | 低-中 |
| **P2（下月，页面合并）** | ① tasks 11→4 页（先给 use-background-tasks.ts 补测试）② memory 6+2→4+1 ③ observability 3→2 ④ dashboard≈start ⑤ approval/ask-user 基座归一 | 中（前端重构 + 契约回归） |
| **P3（远期）** | ① 会话级开关持久化归一 ② STT 收敛云商 ③ discord 宣传面收紧 ④ copilot/kimi/antigravity/cursor 转社区维护 ⑤ chat route 整体 lazy（bundle） | 中 |

---

## 6. 一句话总结

**骨架（wechat/feishu/dingtalk/email + agim-agent + claude-code + approval/outbox/session/Loop/memory/skills）一根不动**；可立即裁的是 5 个死面（setup/sessions 命令、chat-docks、native-agent 路由、plans UI、mimo/qoder 二选一）；可降级的是 CLI 配置向导与冷门设置页（配置路径全归 Web）；heartbeat 是"宣传 vs 实际"最大落差，先接上或明确降级。删除动作前先处理 claude-code sidecar 提取与 bgjob/skills 路径耦合两个前置依赖。
