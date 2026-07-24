# Subagent / 编排演进计划（Orchestration Roadmap）

> 状态：**现行计划（living）** · 2026-07-24  
> 立场：在现有桥接架构上**加薄编排层**，不推倒重来。  
> **概念 SSOT**：[`subagent.md`](./subagent.md)（先读再实施）  
> 关联：[`current.md`](./current.md) · [`../naming.md`](../naming.md) · [`../architecture-bridge-and-agim-agent.md`](../architecture-bridge-and-agim-agent.md) · [`../goals.md`](../goals.md) · [`../session-model.md`](../session-model.md)

本文是**实施计划**；Subagent / A2A / handoff 的定义以 [`subagent.md`](./subagent.md) 为准。  
**实施顺序固定为 Phase A → B → C**；每阶段单独开 PR，合入后再开下一阶段。

---

## 0. 产品目标（一句话）

1. **Subagent 一等公民**：同 Agim（pro/flash）与跨 adapter（Claude/Codex）统一为 SubagentRun；父保留对用户回复的控制权。  
2. **前端实时看到**每个子代理进度与结果树。  
3. **并行 fan-out**（门控）加速独立子任务。  
4. **Long-engineering**：观察者作为一类 Subagent，盯目标做阶段评审。

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
- [ ] 手工：agim + 仅 pro，`isolate:true` 派同族子循环，job/activity 可见。  
- [ ] 手工：另配 flash 且 `llmRoles.cheap`，`role=cheap` 走 flash。  
- [x] `call_agent('claude-code', …)` 仍走跨 adapter（单测不回归）。  
- [x] 无差异的纯自调用仍拒绝。  

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

#### A3. 拆解启发式（prompt）

按 [`subagent.md`](./subagent.md) §5 写入父 system / 工具 description：

- brief 四件套；复杂度缩放；编码场景慎并行写。  
- 不引入独立「分解 Agent」服务（除非日后评估证明必要）。  

**验收**

- [ ] 小样本手工：简单题不滥派；多路调研会派（需真实 LLM；本阶段以 prompt + 单测防回潮为准）。  
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

#### B1. 运行时

- 批量原语包装多次 Subagent spawn（同族 runner 与/或 `callAgentByName`）。  
- **Env 门控**（默认关），例如：`AGIM_SUBAGENT_PARALLEL=0|1`（实现时若沿用 `AGIM_A2A_PARALLEL` 须在 naming 注明别名）。  
- 预算：每 turn 总次数 + 同时运行上限（建议默认 3）。  
- 每个 callee：独立 `runId` / approval / trace。  
- 父 turn 仍占 thread-queue（嵌套等 join）——不放开双 sticky。

#### B2. 冲突与安全

| 风险 | 策略 |
|---|---|
| 两子 agent 同写一文件 | 文档约定 brief 划目录；可选后续加 workspace lease（本阶段可不做） |
| 审批卡交错 | 每 callee 独立 pending；UI 按 stepId 分组 |
| 开放 IM 放大攻击面 | 并行默认关；接 IM 时保持 auto-approve 抑制逻辑 |
| 费用爆炸 | hard cap + 工具返回明确 `cap_exceeded` |

#### B3. 前端

- Phase A 的多 step 列表在并行时同时 `running`。
- Join 后父消息可折叠展示各子结果摘要（全文仍走现有 cap / viewer spill）。

#### B4. 验收

- [ ] `AGIM_A2A_PARALLEL=1` 时，一次编排派出 2–3 个不同 agent（或同 agent 不同 brief），墙钟时间明显低于串行。
- [ ] 默认 `=0` 行为与今日一致。
- [ ] 审批、取消、超时：单个子失败不必然杀死兄弟（策略写清：`allSettled` + 父汇总）。
- [ ] audit / job 树完整；`npm test` 覆盖并行预算与门控。

#### B5. 非本阶段

观察者状态机、同 thread 多主 agent。

---

### Phase C — Long-engineering 模式（观察者 + 执行者）

> 目标：围绕**一个目标**，执行者干活，**观察者作为一类 Subagent** 按 checkpoint 评审。  
> 依赖：Phase A；Phase B 可选（观察可先串行 spawn）。

#### C1. 概念模型

```text
EngineeringRun
  id
  goalId                 -- 必须绑定 active / 指定 goal
  threadKey              -- platform:channel:thread
  executorAgent          -- 主执行者（sticky 或显式）
  observerAgent          -- 观察者（常为 agim/cheap 或另一 CLI）
  cadence                -- 检查点：每 N tool steps / 每阶段 / 手动
  status                 -- planned|running|observing|revising|completed|failed|cancelled
  checkpoints[]          -- { at, observerSummary, decision: continue|revise|stop }
```

存储建议：先 SQLite 新表或挂在 `goals` / `jobs` 扩展字段；**不要**塞进 session.messages。

#### C2. 协议（最小）

1. 进入模式：slash 或工具，如 `/engineer` / `mcp__agim__start_engineering`（命名实施时定，需进 `naming.md`）。
2. 要求存在可注入的 goal（或创建时一并 `goal set`）。
3. 执行者主循环照旧；在 checkpoint：
   - Orchestrator 调用 `callAgentByName(observer, self-contained brief)`；
   - brief 含：goal 摘要、近期进度、执行者产出指针（artifacts / diff 摘要）；
   - 观察者返回结构化结论：`continue | revise | stop` + 理由（schema 固定，便于 UI）。
4. `revise` → 把观察意见注入执行者下一轮（wire-only，类似 goal snippet）。
5. `stop` / `complete_goal` → 走现有 evidence 门闸。
6. `goal-critic`：模式开启时建议 `always` 或至少 goal-only 加强；与观察者分工：
   - **critic** = 廉价、同进程、拦明显跑偏；
   - **observer** = 可换 agent、带产物上下文的阶段评审。

#### C3. 前端

- Run 面板（桌面 chat 或 `/tasks`）：当前 phase、最近 checkpoint、observer 结论。
- 复用 Phase A 的 agent steps 展示观察者调用。
- Portal：至少显示「engineering · observing」类状态，避免只有 admin 看得见。

#### C4. 与 heartbeat 的边界

| | Heartbeat | Engineering observer |
|---|---|---|
| 触发 | 墙钟周期、「有没有事」 | 任务内 checkpoint |
| 目的 | 监控 / 提醒 | 盯目标、改计划、验收 |
| 评价器 | notification-evaluator（防刷） | 结构化 observe 结果 |
| 绑定 | 可跨多线程 | 绑定单次 EngineeringRun |

二者可并存，**禁止**合并成一个模块。

#### C5. 验收

- [ ] 无 goal 时无法进入模式（或强制创建 goal）。
- [ ] 一次 run 至少产生 1 次 observer checkpoint，UI 可见结论。
- [ ] `complete_goal` 仍受 evidence / epoch 约束。
- [ ] 关闭模式后行为回到普通 chat；无孤儿 run（取消 / META 清理策略写明）。
- [ ] 文档：`goals.md` 交叉链接 + `naming.md` 新术语 + CHANGELOG。

#### C6. 非本阶段

多执行者 DAG、自动合并 PR、跨机器编排。

---

## 5. 实施顺序与 PR 策略

```text
Phase A0 概念文档（本批）     ──►  #223
Phase A1 同族 spawn 运行时   ──►  实现 PR（可含 A3）
Phase A2 多 Subagent UI      ──►  可随 A1 或紧随
Phase B  并行 fan-out        ──►  A 合入后再开
Phase C  long-engineering    ──►  可先 RFC 再实现
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
| （复用）`AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN` | B | 2 | 每 turn 委派上限（并行计入） |
| `AGIM_SUBAGENT_PARALLEL` | B | `0` | 允许并行 Subagent |
| `AGIM_SUBAGENT_PARALLEL_MAX` | B | `3` | 同时运行 Subagent 上限 |
| `AGIM_ENGINEERING_MODE` / 或纯工具触发 | C | off | 是否允许进入 long-engineering |
| `AGIM_ENGINEERING_OBSERVER` | C | （可选默认 agent id） | 默认观察者 |

命名定稿时同步 [`../naming.md`](../naming.md)；避免再引入第三套 id。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| approval-bus 在并行下变厚 / 竞态 | Phase B 先隔离 runId；必要时先 peel `approval-bus`（见 tech-debt）再开并行默认 |
| 费用与超时叠加 | hard cap + 单子超时 + 父级 ceiling；UI 显示累计 |
| 观察者与执行者抢写 | 观察者默认只读工具集（planMode 或 tool allowlist） |
| 文档/实现双源 | 概念以 `subagent.md` 为准，计划以本文为准；`current.md` 只加短链 |
| 同族自调用变递归炸弹 | 无 role/backend/isolate 差异仍拒绝；深度与每 turn cap 保留 |

---

## 8. 建议阅读与动手顺序

1. 读 [`subagent.md`](./subagent.md)，对齐「Subagent ≠ 多 Agent」。  
2. 读本文 §0–§2，对齐非目标。  
3. **先做 Phase A1→A2→A3**（同族 spawn → UI → 拆解启发式）。  
4. 再 Phase B；最后 Phase C。  
5. 每阶段结束后更新落地记录：

### 落地记录

| 日期 | 阶段 | PR | 备注 |
|---|---|---|---|
| 2026-07-24 | A0 文档 | #223 | subagent.md + roadmap 对齐 |
| 2026-07-24 | A1 运行时 | #223 | `subagent.ts` + call_agent role/backend/isolate |
| （待填） | A2–A3 | | |
| （待填） | B | | |
| （待填） | C | | |

---

## 9. TL;DR

> **Subagent 先于「多 Agent」：同族 pro/flash 与跨 adapter 都是子工人；A2A 是跨 adapter 的管子。**  
> **先打通同族 + 看得见（A），再并行（B），再观察者长工程（C）。**  
> 拆解靠 brief/启发式 + 硬预算，不靠第二套中台。
