# Loop Engineering（循环工程 · Phase C）

> **状态**：概念 SSOT（按三层定义重对齐）· 2026-07-24  
> **用户面**：`/loop`  
> **关联**：[Focus](./focus.md) · [Subagent](./subagent.md) · [命名](../naming.md) · [残留盘点](./goal-residue.md)

---

## 0. 一句话（对齐产品图）

**人对齐的是「设计 Loop（系统）」，不是「给模型写一句 prompt」。**  
Loop Engineering = **自动发现/承接任务 → 自动调度 Agent（可含子代理）多轮执行 → 自动验收，直到目标达成或触达退出条件。**

这对应图中的 **第 3 层**，不是第 2 层「单个 Agent 内部的 while 循环」。

---

## 1. 三层定位（必读）

```text
┌─────────────────────────────────────────────────────────┐
│  L3  Loop Engineering（自动调度层）  ← 本文 /loop         │
│   触发条件 · 验收标准 · 退出条件 · 升级路径 · 调度逻辑      │
│   例：扫异常单 → 派 Agent 诊断 → 验收修复 → 未达再规划      │
├─────────────────────────────────────────────────────────┤
│  L2  Agent Loop（智能体循环层）                           │
│   while not done: Observe → Think → Tools → Results      │
│   = Agim Agent / Claude / … 单代理内部跑法（已有）         │
├─────────────────────────────────────────────────────────┤
│  L1  LLM API（大模型调用层）                              │
│   模型选择 · token · 参数 · 流式输出                      │
└─────────────────────────────────────────────────────────┘
```

| 层 | 在 Agim 里是什么 | 不是什么 |
|----|------------------|----------|
| **L1** | `llmBackends` / provider / streaming | Loop |
| **L2** | 单 Agent 的 tool loop（pi-agent / dispatcher） | Loop Engineering |
| **L3** | **`/loop`：调度 + 验收闭环** | 再写一个「更大的 L2」 |

**Focus** 仍是注意力锚点（注入 / on / off），给 L3 提供「本轮使命文案」；**完成判定、拆解、派子代理、验收**属于 Loop，不塞回 Focus。

---

## 2. 产品形态（任务团队 Loop）

用户意图示例：

> `/loop` 以 **XX** 为目标，让团队完成；其中子任务完成 a、b…  
> 主控对照 XX **验收**；未达则反思换方向，直到完成。  
> **退出条件**为 …  

### 2.1 主流程

```text
/loop 设定：目标 +（可选）验收标准 + 退出条件
        │
        ▼
   ┌─ 规划 / 拆解任务 ──────────────────────────┐
   │                                            │
   │   调度子代理（call_agent / call_agents）      │
   │         │                                  │
   │         ▼                                  │
   │   汇总结果 → 对照目标验收                     │
   │         │                                  │
   │    未达 ─┴─ 反思 / 改方向 / 再拆解 ──────────┘
   │    已达 → 总结成果 → 结束 Loop
   │
   └─ 或触达退出条件（轮次/时限/用户 stop）→ 结束
```

### 2.2 与现行薄实现的差距（诚实对照）

| 能力 | 目标形态（本文） | 现行 `main` 上的 `/loop` |
|------|------------------|-------------------------|
| 目标 + 退出条件 | 一等字段 | 弱：多半靠 Focus 文案 |
| 强制拆解 → 子代理 | **核心骨架** | 未强制；仅提示可调工具 |
| 对照目标验收 | 硬门闸 / 结构化结果 | `loop_verdict` 软信号 |
| 未达再规划 | 状态机内建 | 靠模型自觉 |
| 达标总结结束 | 必做收尾 | `stop` 即可结束 |

**结论**：现行代码是 **L3 占位壳**；需按本文演进，不能把「Focus + continue/revise/stop」误当成完整 Loop Engineering。

---

## 3. 核心对象（目标 API 草图）

```ts
type LoopMission = {
  /** 要达成的目标（可与 Focus 正文同步或快照） */
  objective: string;
  /** 验收标准（可选但推荐） */
  acceptance?: string;
  /** 退出条件：轮次 / 墙钟 / 用户 stop / 显式失败 */
  exit: {
    maxRounds: number;
    maxWallMs?: number;
    onFocusOff: "cancel"; // Focus off → 取消 Loop
  };
};

type LoopRun = {
  id: string;
  sessionKey: string; // platform+channel+thread
  mission: LoopMission;
  status: "planning" | "dispatching" | "verifying" | "reflecting" | "ended";
  round: number;
  openedFocus: boolean; // 路径 B 代开 Focus → 结束 off
  lastPlan?: { tasks: Array<{ id: string; brief: string; agentHint?: string }> };
  lastVerification?: {
    met: boolean;
    summary: string;
    gaps?: string[];
    nextDirection?: string;
  };
  timeline: Array<{ at: number; kind: string; summary: string }>;
};
```

用户面（目标）：

```text
/loop <objective>                 # 路径 B：代开 Focus + 启动
/loop                             # 路径 A：Focus 已 on 时启动
/loop start <objective|note>
/loop status
/loop stop
/loop help                        # 始终打印用法
```

路径 A/B 与 Focus 的开法关系 **保留**（分步不关 Focus；直开结束 Focus off）——见 [focus.md](./focus.md)。

---

## 4. 状态机（L3）

```text
          start
            │
            ▼
       ┌─────────┐
       │ PLANNING│ 拆解任务（可廉价模型）
       └────┬────┘
            │
            ▼
    ┌──────────────┐
    │ DISPATCHING  │ call_agent / call_agents（子代理团队）
    └──────┬───────┘
           │ join
           ▼
     ┌───────────┐
     │ VERIFYING │ 对照 objective / acceptance
     └─────┬─────┘
           │
     met? ─┬─ yes → SUMMARIZE → ENDED
           │
           no → REFLECTING →（未超 exit）→ PLANNING
                          └（超 exit / stop）→ ENDED
```

| 阶段 | 谁做 | 硬约束 |
|------|------|--------|
| PLANNING | 主控（可 `role=cheap`） | 产出可派发的 task 列表；避免空拆解 |
| DISPATCHING | Subagent fan-out | 复用 Phase B `call_agents`；预算 `MAX_PER_TURN` / parallel |
| VERIFYING | 主控或只读观察角色 | **对照 mission**，不是只看「感觉做完了」 |
| REFLECTING | 主控 | 写下 `nextDirection`；禁止无变更死循环 |
| ENDED | 系统 | 可选总结；`openedFocus` 则 focus off |

---

## 5. 与 Focus / Subagent / Heartbeat

| 原语 | 关系 |
|------|------|
| **Focus** | 使命文案与注入；Loop **不**替代 Focus；完成门闸在 Loop |
| **Subagent** | Loop 的默认劳动力；L3 负责「何时派、派几个、如何验收」 |
| **Agent Loop (L2)** | 每个子代理内部仍是 L2；L3 不重写 L2 |
| **Heartbeat** | 墙钟「有没有事」；**不是** Loop。定时触发可 *启动* 一个 Loop，但不共用状态机 |
| **goal（废弃）** | 勿复活；Loop 的 objective ≠ 旧 `/goal` 完成 CAS |

---

## 6. 验收与退出（L3 一等公民）

启动时尽量收集：

1. **objective**（必填语义）  
2. **acceptance**（可选；缺省则用 objective 自评）  
3. **exit**：`maxRounds`（默认有限）、可选墙钟、用户 `/loop stop`、Focus off → cancel  

VERIFYING 输出至少：

```ts
{ met: boolean; summary: string; gaps?: string[]; nextDirection?: string }
```

`met: true` → 总结并 ENDED；`met: false` 且未触达 exit → REFLECTING → 再 PLANNING。

---

## 7. 分阶段落地（修订）

| 阶段 | 内容 | 备注 |
|------|------|------|
| **C0** | Focus 运行时 | ✅ 已在 main |
| **C1壳** | `/loop` 路径 A/B + 状态注入 + `loop_verdict` | ✅ 已在 main；**视为占位** |
| **C2** | PLANNING + DISPATCHING 强制走 `call_agents`（可配串行） | 下一实现重点 |
| **C3** | VERIFYING 对照 mission；未达 REFLECT | |
| **C4** | SPA：Loop 状态条 / 验收摘要 | |
| **C5** | 触发器（可选接 Heartbeat/cron **只负责 start**） | |

---

## 8. 非目标

- 把 L2 Agent Loop 再包一层皮叫 Loop  
- 多团队互聊 swarm、自动开 PR/merge（可后置）  
- 在 Focus 上做完成勾选 / evidence CAS  
- Heartbeat 与 LoopRun 共用存储  

---

## 9. TL;DR

> **Loop Engineering = L3 自动调度层：目标 → 拆解 → 调度子代理 → 验收 →（未达）反思再来 → 退出。**  
> **Agent Loop = L2，单个工人怎么干活；Loop = 工头怎么排班和收工。**  
> 现行 `/loop` 是壳；按本文 C2+ 演进。

---

## 10. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-07-24 | 初稿（executor/observer 薄模型） |
| 2026-07-24 | **按三层图 + 产品意图重写**：L3 调度/验收/子代理团队；标明与现行壳的差距 |
