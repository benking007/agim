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

### 2.1 两个硬输入（拍板）

| 字段 | 是否必填 | 说明 |
|------|----------|------|
| **目标（objective）** | **必须** | 要达成什么；可同步写入 Focus |
| **退出条件（exit）** | **必须** | 何时停：如「验收通过」+ 上限轮次/时限/失败判据等；用户须明确至少一项可判定的退出语义 |
| 验收细则（acceptance） | 推荐 | 可并入目标讨论；缺省时用 objective 做验收锚 |

**缺任一硬输入 → 不得进入 PLANNING / 派子代理。**  
进入 **ALIGNING（对焦）**：用 `ask_user`（或等价对话）与用户讨论，直到目标和退出条件都确认。

对焦示例问法：

- 目标：「这次 Loop 要达成的结果是什么？怎么算做成？」  
- 退出：「什么情况下结束？例如：验收通过 / 最多 N 轮 / 超过 T 小时 / 连续失败 K 次就停？」

用户可一次给齐（`/loop 目标…；退出条件为…` 或 `；退出：…`），也可分步补全。

### 2.2 主流程

```text
/loop …
        │
        ▼
   ┌───────────┐  缺目标或退出条件
   │ ALIGNING  │◄──────────────── ask_user / 讨论
   └─────┬─────┘
         │ 两者都确认
         ▼
   PLANNING 拆解
         │
         ▼
   DISPATCHING 子代理
         │
         ▼
   VERIFYING 对照目标
         │
         ├─ 已达 → SUMMARIZE → ENDED
         ├─ 未达且未触达 exit → REFLECT → 再 PLANNING
         └─ 触达 exit / 用户 stop → ENDED
```

### 2.3 与现行薄实现的差距

| 能力 | 目标形态 | 现行 `/loop` |
|------|----------|--------------|
| 目标 + 退出条件硬门禁 | **必须**；缺则 ALIGNING | **R1**：ALIGNING + slash/`ask_user`；确认前禁派工 |
| 对焦讨论 | `ask_user` + `/loop objective\|exit\|confirm` | **R1** 已接线 |
| 拆解 → 子代理 | 核心 | **R3**：continue/revise 前本轮须 ≥1 次 call_agent(s) |
| 对照目标验收 | 硬门闸 | **R4**：`met`/`gaps`/`nextDirection`；exit 截断 |

**结论**：R1 锁门禁；R3/R4 补齐调度与验收，才是完整 L3。

---

## 3. 核心对象（目标 API 草图）

```ts
type LoopMission = {
  objective: string;                 // 必填（对焦确认后）
  acceptance?: string;               // 推荐
  exit: {                            // 必填（对焦确认后）
    /** 用户自然语言退出条件（一等展示） */
    description: string;
    maxRounds: number;               // 从描述解析或对焦时确认
    maxWallMs?: number;
    onFocusOff: "cancel";
  };
};

type LoopRun = {
  id: string;
  sessionKey: string;
  mission: LoopMission | null;       // ALIGNING 期间可为部分填写
  status:
    | "aligning"
    | "planning"
    | "dispatching"
    | "verifying"
    | "reflecting"
    | "ended";
  round: number;
  openedFocus: boolean;
  dispatchesThisRound: number;       // R3: 本轮已接受的子代理派工数
  lastPlan?: { at: number; tasks: Array<{ id: string; brief: string; agentHint?: string }> };
  lastVerification?: {
    at: number;
    met: boolean;
    summary: string;
    gaps?: string[];
    nextDirection?: string;
  };
  timeline: Array<{ at: number; kind: string; summary: string }>;
};
```

用户面：

```text
/loop <objective> [；验收：…] [；退出条件为… / 退出：…]  # 一次给齐
/loop                             # 有 Focus 可作目标草稿，仍须确认退出条件
/loop objective <text>            # 对焦中补目标（可含「；验收：…」）
/loop exit <text>                 # 对焦中补退出条件
/loop acceptance <text>           # 可选验收细则（写入 Mission）
/loop confirm                     # 两硬字段齐后确认
/loop status | stop | help        # status 恒展示目标+退出
```

路径 A/B 与 Focus 关系保留——见 [focus.md](./focus.md)。  
**即使 Focus 已有文案，退出条件仍必须对焦确认**（不可静默默认「跑到爽」）。

---

## 4. 状态机（L3）

```text
          start
            │
            ▼
       ┌──────────┐
       │ ALIGNING │ 目标 + 退出条件对焦（硬门禁）
       └────┬─────┘
            │ confirmed
            ▼
       ┌─────────┐
       │ PLANNING│
       └────┬────┘
            ▼
    ┌──────────────┐
    │ DISPATCHING  │ call_agents
    └──────┬───────┘
           ▼
     ┌───────────┐
     │ VERIFYING │
     └─────┬─────┘
           │
     met ──┼─ yes → SUMMARIZE → ENDED
           │
           no → REFLECTING →（未触达 exit）→ PLANNING
                          └（触达 exit / stop）→ ENDED
```

| 阶段 | 硬约束 |
|------|--------|
| ALIGNING | 无完整 objective+exit → **禁止**派子代理 |
| PLANNING | 产出可派发 tasks |
| DISPATCHING | 复用 Phase B；吃并行预算 |
| VERIFYING | 对照 mission.objective（+ acceptance） |
| REFLECTING | 写 nextDirection；防空转 |
| ENDED | openedFocus → focus off |

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

## 6. 验收与退出

- **达标退出**：VERIFYING `met: true` → 总结 → ENDED  
- **条件退出**：触达用户确认的 exit（轮次/时限/失败策略等）→ ENDED（可带「未完全达标」摘要）  
- **用户退出**：`/loop stop`；Focus off → cancel  
- VERIFYING 至少：`{ met, summary, gaps?, nextDirection? }`

---

## 7. 落地节奏（建议 PR 切片）

原则：**先锁门禁（目标+退出），再调度，再验收自动化，最后体验与触发器。**  
每一刀可单独合入、可演示；不把 L3 一次做完。

| 节奏 | 切片 | 交付物 | 验收 |
|------|------|--------|------|
| **R0** ✅ | Focus + `/loop` 壳 | 已在 main | — |
| **R1** ✅ | **对焦门禁** | `ALIGNING`；缺 objective/exit → slash + snippet→`ask_user`；确认前拒绝 `call_agent(s)`/`loop_verdict` | 无退出条件无法进入 planning |
| **R2** ✅ | **Mission 持久化** | `LoopMission` 为 store SSOT（对焦期可部分填写）；`sessionKey`；可选 `acceptance` / `maxWallMs`；`/loop status` 恒展示目标+退出 | status / reload 可读两硬字段 |
| **R3** ✅ | **PLAN + DISPATCH** | 确认后 snippet 强制拆解；`noteLoopDispatch` + `dispatchesThisRound`；`continue/revise` 无派工 → `no_dispatch` | 无子代理调用则不算完成一轮 |
| **R4** ✅ | **VERIFY + REFLECT** | `loop_verdict` 结构化 `met`/`gaps`/`nextDirection`；`met=true→stop`；未达 reflect→planning；`maxRounds`/`maxWallMs` 截断 | 死循环有 exit 截断 |
| **R5** ✅ | **收尾 UX（必备）** | `GET /api/loop`；Portal 状态条（对焦/派工/验收）；结束总结 Markdown；菜单文案对齐 L3 | 用户能看懂「卡在对焦/派工/验收」 |
| **R6** | **可选触发** | Heartbeat/cron **只负责 start**，仍走 ALIGNING | 不绕过对焦 |

推荐合入顺序：**R1 → R2 → R3 → R4 → R5**（产品闭环）；**R6 可选，暂缓**。

```text
R1 对焦门禁 ──► R2 Mission 存储 ──► R3 拆解+子代理 ──► R4 验收闭环 ──► R5 UX ✅
                                                                      │
                                                            R6 触发器（可选·暂缓）
```

---

## 8. 非目标

- 把 L2 Agent Loop 再包一层皮叫 Loop  
- 静默默认退出条件（禁止「没说就按 12 轮」不经确认）  
- 多团队 swarm、自动开 PR/merge（后置）  
- Focus 上做完成勾选 / evidence CAS  
- Heartbeat 与 LoopRun 共用存储  

---

## 9. TL;DR

> **Loop = L3：先对焦（目标+退出条件）→ 拆解 → 子代理 → 验收 →（未达）再来 → 退出。**  
> **两硬输入缺一不可；缺则 ALIGNING，不派工。**  
> 落地节奏：R1 门禁 → R2 存储 → R3 调度 → R4 验收 → R5 UX → R6 触发。

---

## 10. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-07-24 | 初稿（executor/observer 薄模型） |
| 2026-07-24 | 按三层图重写为 L3 |
| 2026-07-24 | **目标+退出条件硬门禁 + ALIGNING；落地节奏 R1–R6** |
| 2026-07-24 | **R1 落地**：ALIGNING 状态机 + slash 对焦 + dispatcher 门禁 |
| 2026-07-24 | **R2 落地**：Mission SSOT（对焦期部分填写）+ sessionKey + acceptance/maxWallMs + status |
| 2026-07-24 | **R3 落地**：PLAN+DISPATCH 门禁（本轮须派工才能 continue/revise） |
| 2026-07-24 | **R4 落地**：VERIFY+REFLECT 结构化验收 + exit 截断 |
| 2026-07-24 | **R5 落地**：Portal 状态条 + `/api/loop` + 结束总结；R6 暂缓 |
