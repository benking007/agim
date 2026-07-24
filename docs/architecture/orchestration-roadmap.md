# Subagent / 编排演进计划（Orchestration Roadmap）

> 状态：**现行计划（living）** · 2026-07-24  
> 立场：在现有桥接架构上**加薄编排层**，不推倒重来。  
> **概念 SSOT**：[`subagent.md`](./subagent.md)（Subagent）· [`loop-engineering.md`](./loop-engineering.md)（Phase C）  
> 关联：[`current.md`](./current.md) · [`../naming.md`](../naming.md) · [`../architecture-bridge-and-agim-agent.md`](../architecture-bridge-and-agim-agent.md) · [`../goals.md`](../goals.md) · [`../session-model.md`](../session-model.md)

本文是**实施计划**；Subagent / A2A / handoff 以 [`subagent.md`](./subagent.md) 为准；  
**Loop-engineering（Phase C）以 [`loop-engineering.md`](./loop-engineering.md) 为准（文档先行，未拍板前不写运行时）**。  
**实施顺序固定为 Phase A → B → C**；每阶段单独开 PR，合入后再开下一阶段。

---

## 0. 产品目标（一句话）

1. **Subagent 一等公民**：同 Agim（pro/flash）与跨 adapter（Claude/Codex）统一为 SubagentRun；父保留对用户回复的控制权。  
2. **前端实时看到**每个子代理进度与结果树。  
3. **并行 fan-out**（门控）加速独立子任务。  
4. **Loop-engineering**：观察者作为一类只读 Subagent，盯 goal 做阶段评审。

产品身份不变：Agim 仍是 **messenger ↔ agent 桥**。  
**Subagent ≠ 多 sticky Agent**；见 [`subagent.md`](./subagent.md) §1。

---

## 1. 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 同一 chat thread 上两个 sticky CLI **对等并行** | 保护 CLI session；不是 Subagent |
| 把 sticky `/cc` 叫成 Subagent | 那是 handoff（控制权转移） |
| 另起 Redis / worker「编排中台」 | 单进程 + job-board 是平台约束 |
| 用 `session.subtasks` / `/job switch` 冒充 Subagent | 用户钉住的子会话，语义不同 |
| 绕过 job/activity 的「隐形 spawn」 | 观测与 audit 破口 |
| 用规则引擎完全替代模型做任务拆解 | 业界证明 brief/heuristics + 硬预算才是主路径 |
| 把 `notification-evaluator` 改成 code reviewer | 威胁模型不对 |
| 在 router / approval 里按 `adapter.kind` 分支 | 违反 peer `AgentAdapter` |

---

## 2. 现状底座与缺口

### 2.1 已具备

| 能力 | 落点 | 说明 |
|---|---|---|
| 跨 adapter 委派 | `a2a.ts` `callAgentByName` | job 父子 / depth / artifacts |
| 工具入口 | `mcp__agim__call_agent` | 仅 `agent`+`prompt`；默认禁自调用 |
| llm roles | `llmRoles.cheap` 等 | flash 等已可配，**尚未**接到 subagent spawn |
| 实时步骤 | WS `activity-step` | Portal 单槽「Waiting for subagent」 |
| 委派 soft SOP | Agim Agent prompt | verification subagent；缺缩放启发式 |

### 2.2 关键缺口（相对 [`subagent.md`](./subagent.md)）

1. **同族 spawn 被 self-call 禁令挡住** → 无法「agim(pro) → agim(flash/pro 隔离子循环）」。  
2. 工具无 `role` / `backend` 参数。  
3. 多 Subagent UI / 与 job 树对齐不足。  
4. 父侧「何时拆、如何写 brief」指引弱。  
5. 同 turn 并行未开（Phase B）。  
6. EngineeringRun 未建（Phase C）。

---

## 3. 目标架构（薄编排层）

```text
Parent turn
    │
    ▼
spawn_subagent / call_agent   ← 统一 Subagent 入口
    │
    ├─ same_family → agim loop + role/backend   （必写 job + activity）
    └─ adapter     → callAgentByName            （现有 A2A）
    │
    ▼
SubagentRun 树 → WS / Portal / /tasks
```

原则：

- **语义一层（SubagentRun），后端两条（同族 / A2A）**。  
- Orchestrator 只编排 fan-out/join 与 engineering cadence。  
- 不取代 sticky；不第二套审批总线。

---

## 4. 分阶段实施

### Phase A — Subagent 主路径 + 可观测（优先）

> 目标：打通**同族 spawn**，统一观测；跨 adapter 继续走 A2A 但同一 UI。  
> 概念见 [`subagent.md`](./subagent.md) §4–§5。  
> 建议拆 PR：A1 运行时 → A2 UI → A3 prompt（可合并 A1+A3）。

#### A0. 文档（本批）

- [x] [`subagent.md`](./subagent.md) 概念 SSOT  
- [x] naming / README / current 交叉链接  
- [x] 本文与概念对齐  

#### A1. 同族 Subagent 运行时

- [x] 允许同 agent 当且仅当：`isolate` / `role` / `backend`（`agim`↔`native` 算同一 agent）。  
- [x] 扩展 `mcp__agim__call_agent`：`role` / `backend` / `isolate`（先扩展现有工具，未另开 `spawn_subagent`）。  
- [x] 同族一律走 `callAgentByName`（inline job + activity）；忽略 `AGIM_NATIVE_CALL_AGENT_IN_PROCESS` 快路径以免丢 job。  
- [x] 解析序：`backend` > `role` → `llmRoles` > 默认（不传 model）。  
- [x] 无 flash 时 `role=cheap` 明确报错。  

**验收**

- [x] 单元：`resolveSubagentSpawn` / A2A self-call gate / dispatcher 参数与拒绝路径。  
- [x] 测试环境：agim + mock-pro，`isolate:true` 派同族子循环，job/activity/`jobId`/`/api/a2a/tree/:id` 可见（`tools/phase-a-acceptance.mjs`）。  
- [x] 测试环境：mock-flash + `llmRoles.cheap`，`role=cheap` 嵌套请求命中 `mock-flash-model`。  
- [x] `call_agent('claude-code', …)` 仍走跨 adapter（单测 + 测试环境 stub 活动行）。  
- [x] 无差异的纯自调用仍拒绝（单测 + 测试环境 vacuous 脚本）。  

#### A2. 事件与前端

扩展 activity（`stepId` / `parentStepId?` / `jobId?` / target 标签）。  
Portal/桌面：**N 条** Subagent 行；同族与跨 adapter 同一列表。  
可选挂 `/api/a2a/tree/:parentJobId` 切片。  

**验收**

- [x] 串行 2 个子代理，UI 两条终态正确（desktop accordion 单测：success + error 分行）。  
- [x] UI 能区分 `agim/cheap` vs `claude-code`（`activityLabel` / `formatSubagentLabel`；多等待行列表）。  
- [x] activity step 携带 `jobId`（与 `a2a-${jobId}` / 既有 `GET /api/a2a/tree/:id` 对齐；本阶段未改 tree API）。  

**落地（2026-07-24）：**

- Core：`ToolActivityStep.jobId`；`listWaitingAgentSteps` / `formatWaitingSubagentLabels`。  
- A2A `emitAgentActivity` 带上 `jobId` + `activityLabel`。  
- 桌面 accordion / Portal run-status / TUI：≥2 个 running agent 时显示「等待 N 个子代理」+ 分行列表。  
- i18n：`activityWaitingSubagents` / `activityRunningSubagents` / `activitySubagentBadge`。  
- **消息流卡片 + 半浮层**：`chat-subagent-card` / `subagent-detail-dialog`；portal 到 composer sheet root，与内容列居中；长内容半高滚动。  
- **Plan 并存**：`activityFollowSignal` 驱动中途 Todo 刷新；Plan 叠在 Subagent 上方。  
- **Stop**：WS `stop-subagent` → `cancelJob`；`formatSubagentStoppedResult` 以 `ok:true, cancelled:true` 交回父 turn。  
- **审批**：主/子共用 ApprovalBus + `AGIM_AUTO_APPROVE`；原生默认放行 `agim_todo_write`。

#### A3. 拆解启发式（prompt）

按 [`subagent.md`](./subagent.md) §5 写入父 system / 工具 description：

- brief 四件套；复杂度缩放；编码场景慎并行写。  
- 不引入独立「分解 Agent」服务（除非日后评估证明必要）。  

**验收**

- [x] 测试环境：父请求 system/tool description 含 §5 启发式；`PHASE_A3_SIMPLE` 脚本路径不滥派（真实 LLM 过度/欠委派率仍属后续评估）。  
- [x] 单测锁定工具 description / 父 system 含关键启发式关键词（`subagent-heuristics.test.ts` + dispatcher / `buildSystemPrompt`）。  

**落地（2026-07-24）：**

- SSOT：`src/core/subagent-heuristics.ts`（`CALL_AGENT_TOOL_DESCRIPTION` + `buildSubagentDelegationGuidance`）。  
- `mcp__agim__call_agent` description 与 `buildSystemPrompt` 注入同一套 §5 启发式（四件套 brief、trivial 不派、same-family/A2A、勿并行写同文件、synthesize）。  
- 未新增独立「分解 Agent」服务。

#### A4. 触点（预估）

- `src/core/llm/agim-dispatcher.ts`、`a2a.ts`、agim-agent prompt/shared  
- `ws-chat.ts`、SPA chat / `portal-run-status`  
- `docs/naming.md`（API 名定稿）  

#### A5. 非本阶段

并行 fan-out、EngineeringRun、改 `thread-queue`、swarm 子代理互聊。

---

### Phase B — 任务内并行 Subagent fan-out

> 目标：一次 turn 可**并行**派出多个 SubagentRun（同族或跨 adapter），join 后交回父 agent。  
> 依赖：Phase A（同族路径 + 多行 UI 已就绪）。  
> 产品默认（2026-07-24）：**并行开**、批量工具、`MAX_PER_TURN=3`。

#### B1. 运行时

- [x] 批量工具 `mcp__agim__call_agents({ tasks[] })` → 内部 `mapPool` + `callAgentByName`（同族/跨 adapter）。  
- [x] **Env 门控** `AGIM_SUBAGENT_PARALLEL`（**默认 ON**；`0|off|false|no` 串行化 batch）。  
- [x] 预算：`AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN` 默认 **3**（单次 + batch 任务均计入）+ `AGIM_SUBAGENT_PARALLEL_MAX` 默认 **3**。  
- [x] 每个 callee：独立 job / activity stepId（`${toolCallId}#i`）/ trace。  
- [x] 父 turn 仍占 thread-queue（嵌套等 join）——不放开双 sticky。  
- [x] 失败策略：`allSettled`（工具层 ok，按 lane 报告 ok/error）。

#### B2. 冲突与安全

| 风险 | 策略 |
|---|---|
| 两子 agent 同写一文件 | 文档约定 brief 划目录；可选后续加 workspace lease（本阶段可不做） |
| 审批卡交错 | 每 callee 独立 pending；UI 按 stepId 分组；`call_agents` HITL 豁免同 `call_agent` |
| 开放 IM 放大攻击面 | 可设 `AGIM_SUBAGENT_PARALLEL=0`；接 IM 时保持 auto-approve 抑制逻辑 |
| 费用爆炸 | hard cap + 工具返回明确 `cap_exceeded` |

#### B3. 前端

- [x] Phase A 的多 step 列表在并行时同时 `running`（每 lane 一张卡）。
- Join 后父消息可折叠展示各子结果摘要（可选增强；全文仍走现有 cap / viewer spill）。

#### B4. 验收

- [x] `AGIM_SUBAGENT_PARALLEL` 默认开：`call_agents` 以 concurrency≤PARALLEL_MAX 并行。
- [x] `AGIM_SUBAGENT_PARALLEL=0`：batch 串行，行为可预期。
- [x] 审批、取消、超时：单个子失败不必然杀死兄弟（`allSettled` + 父汇总）。
- [x] audit / job 树完整；单测覆盖并行预算与门控。

#### B5. 非本阶段

观察者状态机、同 thread 多主 agent、Claude MCP sidecar 暴露 `call_agents`（Native 优先）。

---

### Phase C — Loop-engineering（观察者 + 执行者）

> 目标：围绕**一个 goal**，执行者干活，**观察者作为一类只读 Subagent** 按 checkpoint 评审。  
> **概念 SSOT**：[`loop-engineering.md`](./loop-engineering.md)（文档先行；未拍板开放决策前不写运行时）。  
> 依赖：Phase A；Phase B 可选（观察可先串行 spawn）。  
> 历史名：Long-engineering（与 Loop-engineering 同义）。

#### C0. 文档（本批）

- [x] [`loop-engineering.md`](./loop-engineering.md) 概念 / 状态机 / Observer 契约 / 开放决策  
- [x] naming / README / current / goals / roadmap 交叉链接  

#### C1–C4. 实现（详见 loop-engineering §14）

摘要（细节以概念文为准，避免双源漂移）：

| 切片 | 内容 |
|---|---|
| C1a–d | EngineeringRun 存储、start/stop、cadence、只读 Observer、reviseSteer |
| C2 | 与 goal-critic 分工与辅助调用预算 |
| C3 | Chat/Portal 徽章 + checkpoint 一行 |
| C4 | mock 验收脚本 |

#### C5. 验收（勾选在实现 PR 回写）

见 [`loop-engineering.md`](./loop-engineering.md) §15。

#### C6. 非本阶段

多执行者 DAG、自动合并 PR、跨机器编排；见概念文 §12。

---

## 5. 实施顺序与 PR 策略

```text
Phase A0 概念文档（本批）     ──►  #223
Phase A1 同族 spawn 运行时   ──►  实现 PR（可含 A3）
Phase A2 多 Subagent UI      ──►  可随 A1 或紧随
Phase B  并行 fan-out        ──►  A 合入后再开
Phase C  loop-engineering    ──►  概念文先行 → 拍板 §13 → 再实现
```

每个实现 PR 必须：

1. 更新本文对应 Phase 的验收勾选与「落地差异」小节；
2. 用户可见行为 → `CHANGELOG.md` `[Unreleased]`；
3. 不抬高 SPA bundle budget；超大 UI 拆路由/懒加载；
4. 保持 `check:file-budget` / `check:contracts`。

---

## 6. 配置与命名（预留，实施时写入代码）

| 键（草案） | 阶段 | 默认 | 含义 |
|---|---|---|---|
| （复用）`AGIM_A2A_MAX_DEPTH` | A/B/C | 8 | 嵌套深度 |
| （复用）`AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN` | B | **3** | 每 turn 委派上限（`call_agent` + `call_agents` 任务均计入） |
| `AGIM_SUBAGENT_PARALLEL` | B | **on**（unset=on） | `call_agents` 是否并行；`0/off` 串行 |
| `AGIM_SUBAGENT_PARALLEL_MAX` | B | `3` | 单次 batch 同时运行上限 |
| `AGIM_ENGINEERING_MODE` | C | `off` | 是否允许进入 Loop-engineering（见 loop-engineering.md） |
| `AGIM_ENGINEERING_OBSERVER` | C | （可选） | 默认观察者；空则 cheap→isolate |
| `AGIM_ENGINEERING_OBSERVE_EVERY_TOOLS` | C | `8` | 步数 cadence；`0`=仅手动 |

命名定稿时同步 [`../naming.md`](../naming.md)；避免再引入第三套 id。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| approval-bus 在并行下变厚 / 竞态 | Phase B 先隔离 runId；必要时先 peel `approval-bus`（见 tech-debt）再开并行默认 |
| 费用与超时叠加 | hard cap + 单子超时 + 父级 ceiling；UI 显示累计 |
| 观察者与执行者抢写 | 观察者默认只读工具集（planMode 或 tool allowlist） |
| 文档/实现双源 | Subagent→`subagent.md`；Loop-engineering→`loop-engineering.md`；计划勾选以本文为准 |
| 同族自调用变递归炸弹 | 无 role/backend/isolate 差异仍拒绝；深度与每 turn cap 保留 |

---

## 8. 建议阅读与动手顺序

1. 读 [`subagent.md`](./subagent.md)，对齐「Subagent ≠ 多 Agent」。  
2. 做 Phase C 前读 [`loop-engineering.md`](./loop-engineering.md)，拍板 §13 开放决策。  
3. 读本文 §0–§2，对齐非目标。  
4. **先做 Phase A1→A2→A3**（同族 spawn → UI → 拆解启发式）。  
5. 再 Phase B；最后 Phase C（概念文先行 → 再实现）。  
6. 每阶段结束后更新落地记录：

### 落地记录

| 日期 | 阶段 | PR | 备注 |
|---|---|---|---|
| 2026-07-24 | A0 文档 | #223 | subagent.md + roadmap 对齐 |
| 2026-07-24 | A1 运行时 | #223 | `subagent.ts` + call_agent role/backend/isolate |
| 2026-07-24 | A2–A3 | #223 | 多 Subagent UI / 消息流卡片 / Stop / 启发式；`phase-a-acceptance` 27/27 |
| 2026-07-24 | B | #228 | `call_agents` 并行 fan-out；验收 13/13 |
| 2026-07-24 | C0 文档 | （本 PR） | `loop-engineering.md` 概念先行；无运行时 |

---

## 9. TL;DR

> **Subagent 先于「多 Agent」：同族 pro/flash 与跨 adapter 都是子工人；A2A 是跨 adapter 的管子。**  
> **先打通同族 + 看得见（A），再并行（B），再 Loop-engineering 观察闭环（C，文档先行）。**  
> 拆解靠 brief/启发式 + 硬预算，不靠第二套中台。
