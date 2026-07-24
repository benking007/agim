# Loop-engineering 设计（概念与架构）

> 状态：**现行设计（planning · 文档先行）** · 2026-07-24  
> Roadmap 阶段名：**Phase C — Long-engineering**（见 [`orchestration-roadmap.md`](./orchestration-roadmap.md)）。  
> 产品称呼以本文 **Loop-engineering** 为准；文中「Long-engineering」视为同义历史名。  
> 关联：[`subagent.md`](./subagent.md) · [`../goals.md`](../goals.md) · [`../naming.md`](../naming.md) · [`../architecture-bridge-and-agim-agent.md`](../architecture-bridge-and-agim-agent.md)

本文钉死 **Loop-engineering 是什么 / 不是什么**，以及它与 **goal、goal-critic、Subagent、Heartbeat** 的边界。  
**先文档、后实现**；落地前以本文为准，落地后回写「落地差异」。

---

## 0. 一句话

**Loop-engineering = 绑在一个 active goal 上的「执行者干活 → 检查点 → 观察者评审 → 继续/改道/停下」闭环。**

观察者是一类 **只读 Subagent**，不是第二个 sticky 主 Agent，也不是 Heartbeat。

---

## 1. 为什么单独成篇（复杂度来源）

相对 Phase A/B（spawn + 并行），Loop-engineering 同时碰到：

| 维度 | 难点 |
|---|---|
| **状态跨 turn** | EngineeringRun 生命周期长于单次 user message；要持久化、可恢复、可取消 |
| **双角色** | Executor（可写）与 Observer（只读）权限、工具集、上下文不同 |
| **触发节奏** | 何时 observe：步数 / 阶段 / 手动 / 用户请求 —— 过密烧钱，过疏失控 |
| **结论契约** | 观察者必须吐结构化 `continue\|revise\|stop`，才能驱动状态机与 UI |
| **与现有门闸共存** | 不得绕过 `complete_goal` evidence / epoch；不得与 Heartbeat、goal-critic 职责搅成一团 |
| **产品语义** | 用户仍只面对「一个对话主人」；观察是内部评审，不是换人聊天 |

因此 Phase C **禁止**「先写半套状态机再补文档」。本文是实施准入。

---

## 2. 术语矩阵（勿混用）

| 概念 | 含义 | 是否转移用户控制权 |
|---|---|---|
| **Loop-engineering / EngineeringRun** | 绑定 goal 的长任务闭环（执行 ↔ 观察） | 否 |
| **Executor** | 主循环上干活的 agent（通常即当前 sticky / Agim） | 否（它就是对话主人） |
| **Observer** | 检查点派出的只读 Subagent，回报结构化决策 | 否 |
| **Goal**（`/goal` · `long_task`） | 跨 turn 目标注入与完成门闸 | 否 |
| **goal-critic** | 同进程廉价语义巡检：是否还在轨道上 | 否（不是 Subagent） |
| **Subagent** | 父保留控制权的隔离子工人 | 否 |
| **Heartbeat** | 墙钟周期「有没有事」+ notification-evaluator | 否 |
| **Handoff / sticky** | `/cc` 等把用户会话交给另一 backend | **是** |

对照业界（概念近似，非 API 对齐）：

| 来源 | 对应 Agim |
|---|---|
| Anthropic multi-agent「lead + workers」 | Executor +（可选）fan-out Subagents |
| 「reviewer / evaluator agent」 | Observer（阶段评审） |
| CI 里的 lint gate | goal-critic（廉价、频繁、窄） |
| 值班巡检 cron | Heartbeat（与 Loop-engineering **禁止合并**） |

---

## 3. 产品意图（用户真正要什么）

典型场景：

> 「帮我把这个功能做完」—— 不是一轮问答，而是多 turn、多工具、可能跑偏；  
> 用户希望系统**自己按阶段验收**，而不是只靠最后一句「做完了」。

用户可见承诺（最小）：

1. 明确进入 / 退出 engineering 模式（可感知）。  
2. 绑定一个 goal（没有 goal 不能空转）。  
3. 过程中能看到「正在观察 / 观察结论」。  
4. 结束时仍走既有 `complete_goal` 证据链，不能「观察者说完成就算完成」。

---

## 4. 概念模型

### 4.1 EngineeringRun

```text
EngineeringRun
  id
  goalId                 -- 必须指向可注入的 goal（通常即 thread 上 active goal）
  goalVersion            -- 启动时快照，防止中途换 goal 静默串线
  threadKey              -- platform:channel:thread
  executorAgent          -- 主执行者 id（默认当前对话 agent）
  observerRef            -- 观察者定位：adapter id + 可选 role/backend/isolate
  cadence                -- 见 §6
  status                 -- 见 §5
  startedAt / updatedAt
  checkpoints[]          -- 见 §4.2
  meta                   -- 可选：lastObserveAt, toolStepsSinceObserve, stopReason
```

存储原则：

- **SQLite 新表**（或等价持久化），挂 `goalId` + `threadKey`。  
- **禁止**把 EngineeringRun 全文塞进 `session.messages`。  
- 每 thread **至多一个** `status ∈ { planned, running, observing, revising }` 的活跃 run。

### 4.2 Checkpoint

```text
Checkpoint
  at                     -- ISO / unix ms
  trigger                -- steps | manual | user | stop_request | …
  observerJobId          -- Subagent job 行（可空：解析失败时）
  rawSummary             -- 观察者自然语言摘要（截断后存）
  decision               -- continue | revise | stop
  reasons[]              -- 短列表
  reviseSteer            -- decision=revise 时注入执行者的 wire-only 文本
```

### 4.3 与 Goal 的关系

```text
        ┌──────────── Goal (active) ────────────┐
        │  injection / evidence / complete_goal │
        └───────────────┬───────────────────────┘
                        │ 1:0..1 active EngineeringRun
                        ▼
              ┌─ EngineeringRun ─┐
              │  executor loop   │
              │  observer @ cp   │
              └──────────────────┘
```

- Goal **可以**没有 EngineeringRun（普通 sustained objective）。  
- EngineeringRun **不可以**没有 Goal。  
- `complete_goal` / `cancel` goal 时：活跃 EngineeringRun 必须进入 `completed` / `cancelled`（无孤儿）。

---

## 5. 状态机

```text
                  start_engineering
   (no run) ──────────────────────► planned
                                      │
                                      │ bind ok + first executor turn
                                      ▼
                                   running ◄──────────────┐
                                      │                   │
                          cadence hit / manual observe    │ continue
                                      ▼                   │
                                  observing ──────────────┤
                                      │                   │
                          decision=revise                 │
                                      ▼                   │
                                  revising ───────────────┘
                                      │
                    decision=stop / goal complete|cancel / user stop
                                      ▼
                     completed | failed | cancelled
```

规则摘要：

| 转移 | 条件 |
|---|---|
| → `observing` | cadence 触发或手动 observe；派出 Observer Subagent |
| `observing` → `running` | `decision=continue` |
| `observing` → `revising` → `running` | `decision=revise`：写入 steer，下一 executor 轮消费后清掉 |
| → `completed` | goal `complete_goal` 成功，或用户显式结束且 goal 已收尾 |
| → `cancelled` | 用户 `/engineer stop`、goal cancel、线程清理 |
| → `failed` | 连续观察失败 / 无法解析决策超过阈值（策略见 §10） |

任意时刻用户 Stop 子观察者：按现有 Subagent cancel（partial + 父继续）；EngineeringRun 回到 `running` 或按策略记一次失败 checkpoint（实施时二选一，默认：**记 `decision=continue` + warning**，避免一次 Stop 拆掉整条 run）。

---

## 6. Cadence（何时观察）

实施第一刀只启用 **一种主节奏 + 手动**：

| 触发 | 默认建议 | 说明 |
|---|---|---|
| **每 N 次成功 tool step** | N=8 | 在 executor 的 harness 计数；只计成功或「有进展」的调用（细则实施定） |
| **手动** | `mcp__agim__request_observe` / `/engineer observe` | 用户或执行者主动请求 |
| 每「阶段」 | **延后** | 需要阶段边界定义，C 首期不做 |
| 墙钟 timer | **不做** | 避免与 Heartbeat 混淆 |

环境旋钮（草案）：

| 键 | 建议默认 | 含义 |
|---|---|---|
| `AGIM_ENGINEERING_MODE` | `off` | 总开关；off 时拒绝 start |
| `AGIM_ENGINEERING_OBSERVER` | 空 | 默认观察者：有 `llmRoles.cheap` → `agim`+cheap；否则 `agim`+isolate |
| `AGIM_ENGINEERING_OBSERVE_EVERY_TOOLS` | `8` | 步数 cadence；`0` 表示仅手动 |

---

## 7. 协议（最小闭环）

### 7.1 进入

入口（命名待 `naming.md` 定稿，推荐双入口）：

- 工具：`mcp__agim__start_engineering`  
- Slash：`/engineer`（start/status/observe/stop）

启动参数（草案）：

```json
{
  "goalId": 42,
  "observer": { "agent": "agim", "role": "cheap" },
  "cadence": { "everyTools": 8 }
}
```

校验：

1. `AGIM_ENGINEERING_MODE` 允许。  
2. `goalId` 存在且为该 thread 的 active goal（或允许创建时一并 `long_task`——**产品二选一，见 §13**）。  
3. 无其它活跃 EngineeringRun。  
4. observer 可解析（同族 spawn 规则与 `call_agent` 一致）。

### 7.2 执行中

- Executor 主循环**照旧**（工具、审批、Plan、evidence）。  
- Orchestrator（薄层，挂在 Agim Agent turn 生命周期）维护 `toolStepsSinceObserve`。  
- 触发观察时：  
  1. status → `observing`  
  2. `callAgentByName` / 同族 spawn，**强制 `planMode: true`（只读）**  
  3. brief 自包含（见 §8）  
  4. 解析 JSON 决策 → append checkpoint → 转状态  

### 7.3 退出

- `/engineer stop` 或工具 `stop_engineering` → run `cancelled`；goal **不自动** complete。  
- `complete_goal` 成功 → run `completed`。  
- goal `cancel` → run `cancelled`。

---

## 8. Observer 契约

### 8.1 Brief（父 → 观察者）

必须自包含，观察者**不**继承 executor 全文 history：

1. Goal title/body 摘要 + `goalId`/`goalVersion`  
2. EngineeringRun id + 当前 cadence 说明  
3. 近 N 步工具轨迹（name / ok / preview 截断）  
4. 产物指针：artifacts 路径、关键 diff/文件列表（有则给）  
5. **要求的输出 schema**（原文粘贴进 brief）

### 8.2 输出 schema（观察者 → 编排）

观察者最终消息必须可解析为：

```json
{
  "decision": "continue" | "revise" | "stop",
  "summary": "≤500 chars，中文短评",
  "reasons": ["…", "…"],
  "reviseSteer": "仅 revise 时：给执行者的下一轮纠正指令（可空）"
}
```

解析失败：

- 重试一次（同 brief + 「请只输出 JSON」）。  
- 仍失败：记 checkpoint `decision=continue` + `summary=unparseable`，并打 metric；连续失败达阈值 → run `failed` 或降级为仅手动 observe（实施定默认：**阈值 3 → failed**）。

### 8.3 工具与权限

| | Executor | Observer |
|---|---|---|
| 文件系统写 / exec | 按原策略 | **禁止**（planMode / allowlist） |
| 读文件 / grep / web_fetch | 允许 | 允许 |
| `call_agent` / `call_agents` | 允许（受 cap） | **默认禁止**（防观察者再开摆） |
| `complete_goal` | 允许（门闸照旧） | **禁止** |

观察者 HITL：与只读 Subagent 一致，尽量不弹审批卡（否则检查点体验崩）。

---

## 9. 与 goal-critic / Heartbeat 的分工

| | goal-critic | Observer | Heartbeat |
|---|---|---|---|
| 形态 | 同进程廉价 LLM | Subagent（可换 backend） | 周期任务 |
| 上下文 | 近几步 tool 摘要 | goal + 轨迹 + 产物指针 | 「有没有事」 |
| 输出 | onTrack + redirect | continue/revise/stop | 通知 / 无 |
| 频率 | 单 turn 内节流 | cadence / 手动 | 墙钟 |
| 能否完成 goal | 否 | 否（只能建议 stop） | 否 |

Loop-engineering **开启时**建议：

- critic 模式加强为 `always` 或至少 `goal-only`（已有旋钮则复用）。  
- **同一时间窗**避免 critic 与 observe 双发：优先 observe 回合跳过 critic，或共享「本 turn 已花辅助调用」预算。

Heartbeat **禁止**复用 EngineeringRun 表或 observer 代码路径。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 费用爆炸（观察过勤） | 默认 MODE=off；N=8；每 run 观察次数硬顶（建议 20） |
| 观察者写坏工作区 | 强制 planMode；单测锁定 |
| 观察者装完成绕过 evidence | `complete_goal` 仍只认 evidence/epoch；observer 禁调 complete |
| 状态机卡在 `observing` | 观察超时走现有 A2A/tool 超时；失败降级策略见 §8.2 |
| 与并行 fan-out 叠加失控 | 观察触发时**不**并行再开观察；executor 的 `call_agents` 仍受 Phase B cap |
| UI 只有 admin 看得见 | Portal/chat 必须有非 admin 可见状态（roadmap C3） |
| 文档/实现双源 | 概念 SSOT=本文；计划勾选=roadmap Phase C |

---

## 11. UI（文档级要求，不规定像素）

最小可见：

1. 模式徽章：`engineering · running|observing|revising`  
2. 最近一条 checkpoint：decision + summary 一行  
3. 观察者调用：复用 Subagent 卡片（label 建议 `observer` / `agim/cheap·observer`）  
4. Stop：可停当前观察者；停整条 run 走 `/engineer stop`

`/tasks` 大面板可二期，不阻塞 C1 运行时。

---

## 12. 非目标（本文级）

- 多执行者 DAG / 自动合并 PR / 跨机器编排  
- 观察者之间互聊、swarm  
- 用 Loop-engineering 替代 sticky 多开  
- 把 Heartbeat 或 notification-evaluator 改成 code reviewer  
- 无 goal 的「纯循环 agent」（必须绑 goal）  
- 首期「智能阶段边界检测」

---

## 13. 开放决策（实施前拍板）

| # | 议题 | 选项 | 文档倾向 |
|---|---|---|---|
| D1 | 入口形态 | 仅工具 / 仅 slash / **两者** | 两者 |
| D2 | 无 active goal 时 start | 拒绝 / start 时强制创建 goal | **拒绝**（更简单、更安全） |
| D3 | `AGIM_ENGINEERING_MODE` 默认 | **off** / on | off |
| D4 | 默认观察者 | cheap / isolate 默认模型 / 固定 adapter | cheap，否则 isolate |
| D5 | Cadence N | 5 / **8** / 12 | 8 |
| D6 | 用户 Stop 观察者 | continue+warning / 计失败 | continue+warning |
| D7 | 解析失败阈值 | 3 次 → failed | 是 |

未拍板前，实现 PR **不得**擅自改默认；变更写回本节。

---

## 14. 建议实施切片（仍属文档；无排期）

> 切片按依赖排序；每一刀可单独 PR。不在此估计日历时间。

| 切片 | 内容 | 验收要点 |
|---|---|---|
| **C0** | 本文 + naming + roadmap/goals 交叉链（本 PR） | 术语一致；开放决策表在场 |
| **C1a** | SQLite `engineering_runs` + checkpoint 读写 API | 单测 CRUD；无会话污染 |
| **C1b** | `start_engineering` / `stop_engineering` / status | 无 goal 拒绝；MODE=off 拒绝 |
| **C1c** | Cadence 钩子 + 派出只读 Observer + schema 解析 | 一次 run ≥1 checkpoint；planMode 强制 |
| **C1d** | reviseSteer wire-only 注入执行者 | revise 后下一 turn 可见 steer |
| **C2** | critic 联动与辅助调用预算 | 文档行为有单测或集成测 |
| **C3** | Chat/Portal 徽章 + checkpoint 一行 + observer 卡 | 非 admin 可见 |
| **C4** | 验收脚本（mock LLM）+ desktop-regression 条目 | 对标 Phase A/B harness |

Phase B 并行 **不是** C 的硬依赖；观察者首期串行 spawn 即可。

---

## 15. 验收清单（阶段完成定义）

- [ ] 无 goal（或 MODE=off）无法进入  
- [ ] 一次 run 至少 1 次 observer checkpoint，UI 可见 decision/summary  
- [ ] 观察者只读（写/exec/complete_goal 被拒）  
- [ ] `complete_goal` 仍受 evidence / epoch 约束  
- [ ] stop / goal cancel 后无孤儿活跃 run  
- [ ] Heartbeat 代码路径零复用  
- [ ] `CHANGELOG` + `naming.md` + `goals.md` 交叉链接已更新  

---

## 16. TL;DR

> **Loop-engineering 是绑在 Goal 上的执行–观察闭环。**  
> 观察者是只读 Subagent，输出 `continue|revise|stop`；不能替代 evidence，不能变成第二个主聊。  
> 与 goal-critic（廉价巡检）、Heartbeat（墙钟提醒）严格分职。  
> **先定契约与状态机，再写代码。**

---

## 17. 修订记录

| 日期 | 变更 |
|---|---|
| 2026-07-24 | 初稿：概念、状态机、Observer 契约、与 goal/critic/Heartbeat 边界、开放决策、实施切片 |
