# 多 Agent 编排演进计划（Orchestration Roadmap）

> 状态：**现行计划（living）** · 2026-07-24  
> 立场：在现有桥接架构上**加薄编排层**，不推倒重来。  
> 关联：[`current.md`](./current.md) · [`../architecture-bridge-and-agim-agent.md`](../architecture-bridge-and-agim-agent.md) · [`../goals.md`](../goals.md) · [`../session-model.md`](../session-model.md) · [`../tech-debt.md`](../tech-debt.md)

本文把「多 Agent 并行 / Subagent 可观测 fan-out / Long-engineering（观察者+执行者）」落成可分阶段实施的计划。  
**实施顺序固定为 Phase A → B → C**；每阶段单独开 PR，合入后再开下一阶段。

---

## 0. 产品目标（一句话）

让一次任务里可以：

1. **并行派出多个 subagent** 干活；
2. **前端实时看到**每个子任务的进度与结果树；
3. 在 **long-engineering 模式**下，用「执行者 + 观察者」盯着同一目标，把长任务做得更稳。

产品身份不变：Agim 仍是 **messenger ↔ agent 桥**。编排是桥上的能力，不是第二套 Agent OS。

---

## 1. 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 同一 chat thread 上两个 sticky CLI **对等并行**抢同一原生 session | `thread-queue` 存在就是为了保护 CLI resume / stdin；破坏契约收益低、风险高 |
| 另起 Redis / worker「编排中台」 | 单进程 + job-board 是平台约束；水平扩展不是本路线目标 |
| 用 `session.subtasks` / `/job switch` 冒充 A2A | 那是用户钉住的子会话，语义不同 |
| 绕过 `callAgentByName` 的「隐形 spawn」 | 会丢 audit / artifacts / cancel / `/api/a2a/*` 树 |
| 把 `notification-evaluator` 改成 code reviewer | 它是通知防刷（fail-open），威胁模型不对 |
| 在 router / approval 里按 `adapter.kind` 分支 | 违反 peer `AgentAdapter` 原则 |

「多 Agent 同时跑」的**对外语义**约定为：

- ✅ **跨 thread / 跨 job** 已支持，保持；
- ✅ **一次任务内并行 subagent（fan-out）** —— 本计划主交付；
- ❌ **同 thread 多 sticky CLI 对等并行** —— 不做（文档与 UI 文案避免暗示）。

---

## 2. 现状底座（复用，不重造）

### 2.1 已具备

| 能力 | 落点 | 说明 |
|---|---|---|
| A2A spawn | `src/core/a2a.ts` `callAgentByName` | 唯一委派原语；`parent_id` / `call_depth` / audit / artifacts |
| Agim Agent 委派 | `src/core/llm/agim-dispatcher.ts` `mcp__agim__call_agent` | 每 turn 默认 cap=2；串行；非 parallel-safe |
| 线程串行 | `src/core/thread-queue.ts` | 同 thread 顶层一轮一次（IM）；Web 为 abort 换跑 |
| Job 树 | `src/core/job-board.ts` + `/api/a2a/tree/:id` | 父子可查；admin `/tasks/a2a` |
| 实时步骤 | `onToolActivity` → WS `activity-step` | Portal 已有单条「Waiting for subagent」 |
| 长程目标 | `goals.ts` + `goal-evidence` + `goal-critic` | 注入 / 证据 / 跑偏打断 |
| 周期监控 | `heartbeat.ts` + `notification-evaluator` | decide→execute→evaluate；**不是**工程观察者 |
| Verification SOP | Agim Agent prompt | 用 `call_agent` 做核验（软约束） |

### 2.2 已知缺口（本计划要补）

1. 同 turn 内 `call_agent` **不能并行**（CHANGELOG 曾 defer，因审批总线 / UI）。
2. 前端几乎只展示**单个** nested agent；无 live 树。
3. in-process `call_agent('agim')` 快路径（默认关）可**跳过 job 行**，破坏观测 parity。
4. 无「EngineeringRun」状态机；观察者/执行者只是角色想象，不是一等协议。

---

## 3. 目标架构（薄编排层）

```text
Surfaces (IM / Web / ACP / CLI)
        │
        ▼
Pre-route gates (auth · allowlist · tenant)
        │
        ▼
core/router  （入口、sticky、slash —— 职责不变）
        │
        ▼
┌───────────────────────────────────────┐
│  Run Orchestrator  （新薄层，Phase 渐进长出）│
│  - fan-out / join                      │
│  - activity 多 step + 树切片            │
│  - engineering run 状态机（Phase C）    │
└───────────────────────────────────────┘
        │
        ▼
callAgentByName / agent-loop / approval-bus / message-sink
```

原则：

- Orchestrator **只编排**「谁跑、是否并行、何时观察、如何汇总」。
- **不**取代 router sticky，**不**按 `kind` 分支，**不**第二套审批总线。
- 所有 spawn 仍走 `callAgentByName`（或经其包装的批量 API）。

---

## 4. 分阶段实施

### Phase A — Subagent 可观测性（优先）

> 目标：一次任务派出的每个 subagent，前端都能看到状态；观测与 job 树一致。  
> 依赖：无。建议**第一个开干**。

#### A1. 事件模型扩展

扩展 `ToolActivityStep`（或等价结构），支持：

| 字段 | 用途 |
|---|---|
| `stepId` | 稳定 id（建议与 a2a call / job id 对齐） |
| `parentStepId?` | 嵌套树 |
| `kind: 'agent'` | 已有；允许多条并存 |
| `agent` / `label` / `status` / `preview` | 已有语义 |
| `jobId?` | 链到 job-board |

WS 仍用 `activity-step`（可增量字段）；避免新开协议。

#### A2. 观测 parity

- **默认保持** in-process 快路径关闭；若开启，必须同样写 inline job 行或显式标记「untracked」（产品上倾向：开启时也写 job）。
- Portal / 桌面 chat：同一 turn 可展示 **N 条** subagent 行（running / done / failed），不只「Waiting for subagent」单槽。
- 可选：当前 turn 的 job 树切片（复用 `/api/a2a/tree/:parentJobId` 或 job SSE），挂在消息 accordion 下。

#### A3. 验收

- [ ] 父 turn 串行调用 2 次 `call_agent`，UI 先后出现两条 agent step，终态正确。
- [ ] `/api/a2a/tree/:id` 与 UI 展示的 jobId 一致。
- [ ] in-process 路径若启用：要么有 job 行，要么测试锁定「不可用于 engineering UI」。
- [ ] 既有单 subagent Portal 行为无回归。
- [ ] `npm test` / `typecheck` / `lint` 绿。

#### A4. 主要触点（预估）

- `src/core/llm/agim-dispatcher.ts`（activity id / job 对齐）
- `src/core/a2a.ts` / activity 类型定义
- `src/web/ws-chat.ts`
- `src/web-app/.../chat/*`、`portal-run-status.tsx`（或等价）
- 单测 + 少量 SPA 测

#### A5. 非本阶段

并行 `call_agent`、EngineeringRun、改 `thread-queue`。

---

### Phase B — 任务内并行 fan-out

> 目标：一次 turn / 一次编排步骤可**并行**派出多个 subagent，join 后把结果交回父 agent。  
> 依赖：Phase A（否则并行时 UI 不可用）。

#### B1. 运行时

- 新增显式批量原语（推荐二选一，优先 1）：
  1. `callAgentsParallel([{ agent, prompt, ... }])` 包装多次 `callAgentByName`；或
  2. 将 `mcp__agim__call_agent` 标为可并行安全（需严格隔离），由 agent-loop 的 `Promise.allSettled` 调度。
- **Env 门控**（默认关），例如：`AGIM_A2A_PARALLEL=0|1`。
- 预算：
  - 每 turn 总委派次数上限（沿用 / 上调 `AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN`，并行也计入）；
  - 同时运行上限（如 `AGIM_A2A_PARALLEL_MAX`，建议默认 3，对齐 `AGIM_MAX_CONCURRENT_JOBS` 量级）。
- 每个 callee：**独立** `runId` / approval 上下文 / trace `${parent}/a2a-${id}`。
- 父 turn 仍占住 thread-queue（嵌套等待 join）——**不**放开同 thread 双 sticky CLI。

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

> 目标：围绕**一个目标**，在一次工程 run 内更好完成任务：执行者干活，观察者按节奏检查并反馈。  
> 依赖：Phase A（反馈面）；Phase B 可选（观察可先串行 `call_agent`）。

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
Phase A  可观测 subagent     ──►  单独 PR，合入后再开 B
Phase B  并行 fan-out        ──►  单独 PR（可拆 runtime / UI）
Phase C  long-engineering    ──►  可先 RFC PR（仅文档+类型）再实现 PR
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
| `AGIM_A2A_PARALLEL` | B | `0` | 允许并行 call_agent |
| `AGIM_A2A_PARALLEL_MAX` | B | `3` | 同时运行子 agent 上限 |
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
| 文档/实现双源 | 本文为计划 SSOT；合入后 `current.md` 只加短链，不复制大段 |

---

## 8. 建议阅读与动手顺序

1. 读本文 §0–§2，对齐非目标。  
2. **先做 Phase A**（文档勾选 → 开分支实现 → 合入）。  
3. 再 Phase B；最后 Phase C（可先补一小节「C0 RFC」把 schema 钉死）。  
4. 每阶段结束后在本节追加「落地记录」：

### 落地记录

| 日期 | 阶段 | PR | 备注 |
|---|---|---|---|
| （待填） | A | | |
| （待填） | B | | |
| （待填） | C | | |

---

## 9. TL;DR

> **先看得见（A），再跑得并行（B），再谈盯着目标做长工程（C）。**  
> 全部架在 `callAgentByName` + job 树 + activity/WS + goal/critic 上；加薄 Orchestrator，不新造平台。
