# Subagent 设计（概念与架构）

> 状态：**现行设计（planning）** · 2026-07-24  
> 实施阶段见 [`orchestration-roadmap.md`](./orchestration-roadmap.md)（Phase A 起）。  
> 关联：[`../naming.md`](../naming.md) · [`../architecture-bridge-and-agim-agent.md`](../architecture-bridge-and-agim-agent.md) · [`../llm-backends.md`](../llm-backends.md)

本文先钉死 **Subagent 是什么 / 不是什么**，以及它与 **A2A、多 Agent、sticky 切换** 的关系。  
实现之前以本文为准；落地后若有偏差，回写「落地差异」一节。

---

## 0. 一句话

**Subagent = 父 turn 仍握有用户对话控制权时，派出的隔离子工人（agents-as-tools）。**  
它首先是编排语义，其次才是「调用了哪个后端」。

---

## 1. 术语矩阵（勿混用）

| 概念 | 含义 | 用户是否换「主 Agent」 | 典型例子 |
|---|---|---|---|
| **Subagent** | 父 agent 委派的嵌套工人；父汇总后对用户说话 | 否 | agim(pro) 派子循环用 flash 搜代码；agim 派 claude-code 写补丁 |
| **A2A** | 调用**另一个已注册** `AgentAdapter` 的传输/护栏层（`callAgentByName`） | 否（嵌套） | `call_agent('claude-code', …)` |
| **多 Agent（产品口语）** | 常被误解为「多个 sticky 同时聊」；本项目对外只承诺 **任务内多 subagent** + **跨 thread 各跑各的** | — | 见 roadmap 非目标 |
| **Handoff / sticky 切换** | 把**用户会话控制权**交给另一 backend（`/cc`、`/oc`） | **是** | 用户之后消息打给 Claude |
| **session.subtasks / `/job switch`** | 用户钉住的子会话焦点 | 是（焦点切换） | 与 Subagent **不同产品** |

对照业界：

| 来源 | 对应 Agim |
|---|---|
| OpenAI Agents SDK **agents-as-tools** | Subagent（父保留控制权） |
| OpenAI **handoffs** | sticky `/cc` 等（控制权转移） |
| Claude Code **Agent / Task tool** | Subagent（隔离上下文，只回摘要） |
| Anthropic Research **orchestrator-worker** | 父 = lead；子 = Subagent fan-out |

---

## 2. 用户意图对齐（本设计的产品原点）

### 2.1 Subagent ≠「再挂一个 CLI 品牌」

示例（用户原话语义）：

1. 主对话用 **Agim Agent + deepseek-v4-pro**。  
2. 派出 subagent 时，**默认仍可用同一 backend（pro）**做隔离上下文的子任务。  
3. 若同时配置了 **deepseek-v4-flash**（通常挂在 `llmRoles.cheap`），则可选择 flash 跑廉价子任务。

也就是说：**同 adapter、同或不同模型**，都是合法 Subagent。  
「叫了隔壁 Claude」只是 Subagent 的**一种后端形态**，不是定义本身。

### 2.2 广义上也算 Subagent 的情况

| 委派目标 | 是否 Subagent | 走哪条实现 |
|---|---|---|
| `agim` + 默认/`native-chat` backend（如 pro） | ✅ | **同族 spawn**（见 §4） |
| `agim` + `role=cheap` / 指定 backend（如 flash） | ✅ | 同族 spawn + role/backend 覆盖 |
| `claude-code` / `codex` / … | ✅（广义） | **A2A**（`callAgentByName`） |
| sticky `/cc` | ❌ | handoff，不是 subagent |

架构要把它们**框进同一套 SubagentRun**，而不是两套产品话术。

---

## 3. 业界要点（研究摘要 → 我们采纳什么）

来源：Anthropic *How we built our multi-agent research system*；Claude Code subagents / Agent tool；OpenAI Agents SDK orchestration。

| 原则 | 含义 | Agim 采纳 |
|---|---|---|
| **隔离上下文** | 子工人拿 brief，不吞父会话全文；只回摘要 | 已有 A2A「不写父 history」；同族 spawn 必须同样 |
| **父保留控制权** | 父合成最终对用户回复 | Subagent；区别于 sticky handoff |
| **委派质量决定成败** | brief 要含目标 / 输出格式 / 工具边界 / 完成条件 | **核心难点**；靠 prompt + 可选结构化字段，不是再造调度器 |
| **按复杂度缩放** | 简单题 0 子代理；对比 2–4；广搜才更多 | 写入父 system / 工具 description；硬 cap 防爆 |
| **并行是加速器不是定义** | Research 用 3–5 并行；编码任务往往并行点更少 | Phase B 门控并行；先串行可观测（Phase A） |
| **贵** | 多代理常数倍～十余倍 token | 默认偏保守；cheap role 优先子任务 |
| **编码场景慎用无脑 fan-out** | Anthropic：多数 coding 不如 research 那么可并行 | Loop（观察者）与「广搜 fan-out」分开设计 |

**结论：最难的不是进程模型，而是「何时拆、怎么写 brief、何时停」。**  
运行时先提供可靠 spawn + 观测；分解策略以 prompt/heuristics 为主，辅以硬预算。

---

## 4. 统一架构：SubagentRun

### 4.1 一层语义，两条后端

```text
                    Parent turn (owns user reply)
                              │
                              ▼
                    spawn_subagent / call_agent
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
        Same-family spawn              Cross-adapter A2A
        (agim → agim loop)             (callAgentByName)
        + optional role/backend        claude-code / codex / …
                │                           │
                └─────────────┬─────────────┘
                              ▼
                     SubagentRun record
                     (job row + activity step + trace)
                              │
                              ▼
                     summary → parent tool result
```

| 字段（草案） | 说明 |
|---|---|
| `runId` / `jobId` | 与 job-board / activity 对齐 |
| `parentJobId` / `parentTraceId` | 树与 audit |
| `target.kind` | `same_family` \| `adapter` |
| `target.agent` | registry id（`agim` / `claude-code` / …） |
| `target.role?` | `cheap` \| `native-chat` \| `evaluator` …（同族） |
| `target.backend?` | 显式 backend name（同族；覆盖 role） |
| `brief` | 自包含任务说明（父写入） |
| `status` | queued \| running \| completed \| failed \| cancelled |
| `summary` | 回传父模型的文本（可 cap / spill） |

### 4.2 与今日代码的差距

| 现状 | 问题 |
|---|---|
| `call_agent` **禁止** `callerAgent === agentName` | 堵住了「agim → agim(flash)」主路径 |
| in-process `call_agent('agim')` 默认关，且可无 job 行 | 同族 spawn 观测不一致 |
| 工具参数只有 `agent` + `prompt` | 无法表达 `role` / `backend` |
| UI「Waiting for subagent」单槽 | 多子任务不可见 |
| 父 prompt 对「何时委派」指引弱 | 易过度委派或从不委派 |

### 4.3 目标 API 形态（实施时二选一，倾向 B）

**A. 扩展现有工具** `mcp__agim__call_agent`：

```json
{
  "agent": "agim",
  "prompt": "…self-contained brief…",
  "role": "cheap",
  "backend": "deepseek-v4-flash"
}
```

- `agent === caller` **且**（`role`/`backend` 不同 **或** 显式 `isolate: true`）→ 允许同族 spawn。  
- `agent !== caller` → 走现有 A2A。

**B. 新工具** `mcp__agim__spawn_subagent`（推荐长期）：

- 产品名与 Subagent 对齐；内部仍复用 job / activity /（跨 adapter 时）`callAgentByName`。  
- `call_agent` 保留为跨 adapter 别名或逐步薄包装，避免两套语义漂移。

命名定稿写入 [`../naming.md`](../naming.md)。

### 4.4 模型选择规则（同族）

解析顺序（草案）：

1. 显式 `backend`（须在 `llmBackends` 且有密钥）  
2. 否则 `role` → `llmRoles[role]`  
3. 否则父 turn 当前 backend（与主对话相同，如 pro）  
4. 再否则任意可用 backend  

只配 pro、不配 flash 时：子任务仍可派，只是**不能**选 cheap；系统不得假装有 flash。

---

## 5. 核心难点：任务拆解与「要不要派」

运行时**不**尝试用规则引擎替代模型做分解；采用 Anthropic 已验证的路：

### 5.1 教父 agent 如何委派（prompt / tool description）

每个 subagent brief **建议强制四件套**（可在工具 schema 里拆成可选字段，或写进 description）：

1. **Objective** — 子任务要完成什么  
2. **Output format** — 父期望收回什么（bullet / 紧凑表 / JSON）  
3. **Boundaries** — 不要做什么、不要重复搜什么  
4. **Done when** — 完成条件，避免空转  

**产出契约（父须写进 Output format；子最终消息须兑现）**：

| 要求 | 说明 |
|------|------|
| 关键发现在消息里 | Portal「执行结果」= 子代理最终 assistant 文本；表格/数字/结论须出现在正文 |
| 落盘须引路径 | 另写文件时须给出**绝对路径**；禁止「文件已写好」而不报 path |
| 禁止空指代 | 禁止只有「见上文输出 / see above / 详见文件」而无实质内容 |

长文可**额外**落盘，但不可「只落盘、消息空壳」。SSOT：`subagent-heuristics.ts` + Agim Agent Closure/IM 指引。

### 5.2 缩放启发式（写入父指引）

| 任务类型 | 建议 |
|---|---|
| 单事实 / 短改 | **0** subagent，自己干 |
| 可独立的 2–3 路调研或验证 | 1–3 串行或并行 subagent |
| 广搜 / 多目录只读探索 | 可 fan-out；子用 cheap |
| 强依赖写同一文件 | **不要**并行写；串行或划目录 |
| 验收 / 对抗复核 | 1 个观察向 subagent（fresh context） |

硬预算（已有 / 将加）：

- `AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN`（每 turn 次数）  
- 深度 `AGIM_A2A_MAX_DEPTH`  
- 并行门控见 roadmap Phase B  

### 5.3 决策流程（父模型心里的清单）

```text
这个子问题是否会污染主上下文 / 很长 / 可独立？
  否 → 自己用工具做完
  是 → 写自包含 brief
        → 需要别家 CLI 能力？ → adapter 目标（A2A）
        → 只需隔离上下文或换便宜模型？ → 同族 agim + role/backend
        → 多路独立？ →（Phase B）一次派出多个
```

### 5.4 评估（后续）

- 小样本（~20）真实任务：过度委派率、零委派该委派率、brief 完整度。  
- LLM-as-judge 看子结果是否被父正确合成。  
- 先不阻塞 Phase A 落地。

---

## 6. A2A 与 Subagent 的关系（架构框）

```text
┌─────────────────────────────────────────────┐
│  Subagent（产品/编排语义）                      │
│  父控制权 · 隔离上下文 · brief→summary · 可观测  │
└───────────────────┬─────────────────────────┘
                    │ 实现
        ┌───────────┴───────────┐
        ▼                       ▼
 Same-family runner      A2A transport
 (agim-agent loop        (callAgentByName
  + role/backend)         + peer adapters)
```

- **A2A ⊂ Subagent 的实现手段之一**（跨 adapter）。  
- **Subagent ⊄ 仅 A2A**：同族换 model/role 也是 Subagent，今天反而被 self-call 禁令挡住。  
- **Handoff ⊄ Subagent**：`/cc` 换的是用户主会话 agent。

文档与 UI 文案：

- 对用户：统一说 **「子代理 / Subagent」**。  
- 对运维：跨 adapter 细节可写「经 A2A」；不要把 admin「A2A 树」改名打散，可显示为 **Subagent 树（A2A jobs）**。

---

## 7. 前端反馈（与 roadmap Phase A 对齐）

最低产品要求：

1. 父消息下可列出 **N 个** SubagentRun（running / done / failed）。  
2. 展示目标摘要：`agim/cheap` 或 `claude-code`，而非只有一句 Waiting。  
3. 与 `jobId` / tree API 一致，便于 `/tasks` 深链。  
4. 同族与跨 adapter **同一组件**，仅 badge 不同。

### 7.1 消息流卡片与半浮层（已落地）

| 能力 | 行为 |
|---|---|
| **消息流卡片** | 父 turn 下按 `jobId` 渲染 Subagent 卡片（状态 / 标签 / Todo 级联） |
| **半浮层详情** | 点击卡片 → 半浮层（portal 到 `[data-agim-composer-sheet-root]`，与内容列居中对齐）；展示父 brief + 子结果（`GET /api/jobs/:id`） |
| **长内容** | 默认半高 + 内部滚动；expand / collapse（mock：`PHASE_A_LONG_SHEET_TEST`） |
| **Plan 叠放** | Todo/Plan 在 Subagent 卡片**上方**；`activityFollowSignal` 驱动中途刷新（不只看 `steps.length`） |
| **Stop** | 运行中卡片右侧 Stop → WS `{ type: 'stop-subagent', jobId }` → `cancelJob`；保留 partial，格式化为 `formatSubagentStoppedResult`，以 **`ok: true, cancelled: true`** 交回父 turn，父继续 summarize / 推进 |

---

## 7.2 审批与 HITL（父 / 子分工）

| 角色 | 工具审批（exec / write …） | `ask_user` / `loop_verdict` |
|------|---------------------------|----------------------------|
| **父 turn**（`callDepth=0`） | 受 `AGIM_AUTO_APPROVE`；默认弹卡人工批 | 允许（对焦 / 中间评审） |
| **子代理**（`callDepth>0`） | **代审免卡**（系统替用户批准） | **拒绝**；澄清写进 FINAL message |

**主 Agent 开关（Portal / 桌面 composer）**：输入框下方状态栏可选 **「替我审批」**（`AGIM_AUTO_APPROVE=1`）或 **「请求审批」**（默认 `=0`）。API：`GET/PUT /api/policy/auto-approve`（任意已登录 token，含 Portal QR）。与 Settings → Policy 同源热更新。

**代审仍拦截**：敏感路径硬拒绝、self-protect、`deny-all`、显式 denylist、`requiresExplicitDecision`（如 plan-exit）。  
实现：原生 `buildPiApprovalGate` + ApprovalBus `_registerPending`（日志 `approval.bus.subagent_auto_approve`）。

与 Loop 门禁配合：派工/等待门禁**仅父侧**；子代理共享 `threadId` 但可正常调研。详见 [`loop-engineering.md`](./loop-engineering.md) §6 · [`ask-user.md`](../ask-user.md) §9。

---

## 8. 分阶段（只列 Subagent 相关；细节在 roadmap）

| 阶段 | 内容 |
|---|---|
| **A0** | 本文 + naming + roadmap 对齐（本 PR） |
| **A1** | 同族 spawn：解除「无 role 差异的自调用」误伤；支持 `role`/`backend`；**必写 job + activity** |
| **A2** | UI 多 Subagent 行 + 树切片 |
| **A3** | 父 prompt：委派启发式 + brief 四件套（可与 A1 同 PR 或紧随） |
| **B** | 并行 fan-out：`mcp__agim__call_agents` + `AGIM_SUBAGENT_PARALLEL`（默认开） |
| **C** | Focus + Loop：观察者作为一类只读角色（见 [`focus.md`](./focus.md) · [`loop-engineering.md`](./loop-engineering.md)） |

---

## 9. 非目标（本文级）

- 子代理之间直接聊天（swarm mesh）—— 先 star 型（只与父通信）。  
- 子代理自动继承父全文（fork）—— 默认隔离；fork 若做须显式 opt-in。  
- 用 subagent 替代 sticky 多开—— 不做同 thread 双 sticky。  

---

## 10. 落地记录

| 日期 | 变更 | PR |
|---|---|---|
| 2026-07-24 | 初稿：概念矩阵、同族/A2A 统一、拆解原则 | #223 |
| 2026-07-24 | **A1**：`resolveSubagentSpawn`；`call_agent` 增加 `role`/`backend`/`isolate`；同族经 `callAgentByName`（job+activity）；自调用无差异仍拒 | #223 |
| 2026-07-24 | **A2**：多 Subagent UI — activity `jobId`；桌面/Portal/TUI 多等待行；标签区分同族 (`agim/cheap`) 与跨 adapter | #223 |
| 2026-07-24 | **A3**：拆解启发式写入 `call_agent` description + 父 system（`subagent-heuristics.ts` SSOT） | #223 |
| 2026-07-24 | **Phase A 测试环境正式验收**：`tools/mock-llm-server.mjs` + `tools/phase-a-acceptance.mjs`（27/27） | #223 |
| 2026-07-24 | **Subagent 消息流卡片**：Todo 级联可见；点击半浮层查看父提示词 + 结果（`GET /api/jobs/:id`） | #223 |
| 2026-07-24 | **半浮层对齐 / 长内容滚动**；Plan 中途可见（`activityFollowSignal` + todo status 归一）；Plan 叠在 Subagent 上方 | #223 |
| 2026-07-24 | **审批收紧体验**：紧凑审批卡；Settings 未设时显示 AUTO_APPROVE=OFF；子代理审批标 origin | #223 |
| 2026-07-25 | **子代理代审免卡**：`callDepth>0` 不弹工具审批；禁子代理 `ask_user`/`loop_verdict`；Loop 门禁仅 depth=0 | #249 |
| 2026-07-25 | **Composer「替我审批」**：主 Agent `AGIM_AUTO_APPROVE` 芯片 + `/api/policy/auto-approve` | #250 |
| 2026-07-24 | **Stop Subagent**：卡片 Stop → `stop-subagent` WS；abort 保留 partial → 父侧 summarize 并继续 | #223 |
| 2026-07-24 | **call_agent 墙钟**：`timeoutMs:0` 跳出 Native tool-bridge 默认 60s；超时 abort 不再误标「Stopped by user」 | — |
| 2026-07-24 | **Phase B**：`mcp__agim__call_agents` 批量 fan-out；`AGIM_SUBAGENT_PARALLEL` 默认开；`MAX_PER_TURN=3`；allSettled | — |
| 2026-07-24 | **loop_verdict 墙钟**：同样 `timeoutMs:0`（嵌套独立验收可 >60s）；mutation 成功后不以假超时覆盖（见 Loop §6.2） | #243 |
| 2026-07-24 | **子代理产出契约**：最终消息须含关键发现；落盘须绝对路径；禁空「见上文」 | — |

### 落地差异（相对 §4.3）

- 采用扩展 `mcp__agim__call_agent`，暂未新增 `spawn_subagent` 工具名。  
- `AGIM_NATIVE_CALL_AGENT_IN_PROCESS` 对同族 Subagent **不再走无 job 快路径**（打日志后仍走 A2A）。  
- A2 UI：消息流卡片 + 半浮层详情（`chat-subagent-card` / `subagent-detail-dialog`），activity 仍带 `jobId`；未另开独立「Subagent 面板」路由树。  
- A3 不引入独立分解 Agent；启发式仅以 prompt / tool description 形式注入父侧。  
- 用户 Stop 子代理时返回 **cancelled + ok**（非硬失败），以便父 turn 用阶段性内容继续。  
- Subagent **墙钟由 A2A**（`AGIM_A2A_TIMEOUT_DEFAULT_MS`，默认 30 min）负责；同族 Agim 子会话仍经 `buildSystemPrompt` 注入 skills 摘要，但**不继承父对话历史**（isolate 设计如此，brief 须自包含）。

---

## 11. TL;DR

> **Subagent 是「父还在开会对用户负责」时的隔离子工人。**  
> 同 Agim 换 pro/flash、或派 Claude/Codex，都是 Subagent；A2A 是跨 adapter 的管子。  
> 子代理工具代审免卡；提问与 Loop 验收只归父侧。  
> 难关在拆解与 brief，不在再写一个调度中台。  
> 先打通同族 spawn + 统一观测，再并行，再 Focus + Loop（见 [`focus.md`](./focus.md) · [`loop-engineering.md`](./loop-engineering.md)）。
