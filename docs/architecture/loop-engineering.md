# Loop Engineering（循环工程 · Phase C）

> **状态**：现行设计 SSOT（R1–R5 + 派工/验收硬门禁已落地）· 2026-07-24  
> **用户面**：`/loop` · Portal `/m/chat` 底栏/小精灵  
> **关联**：[Focus](./focus.md) · [Subagent](./subagent.md) · [Portal 输入框](../portal-composer.md) · [命名](../naming.md) · [残留盘点](./goal-residue.md) · [编排路线图](./orchestration-roadmap.md)

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
   DISPATCHING 子代理 ──（本轮 live>0：父侧只 wait，禁 ask_user）──┐
         │                                                       │
         ▼                                                       │
   VERIFYING 对照目标 ◄──────────────────────────────────────────┘
         │
         ├─ live=0 且不确定 → 父侧 ask_user →（用户回复）→ 再 VERIFY
         ├─ met=true → PENDING_USER_CONFIRM（Portal 结案浮窗）→ 结束 / 继续
         ├─ met=false 且未触达 exit → REFLECT → 再 PLANNING
         └─ 触达 exit / 用户 stop → ENDED
```

### 2.3 现行落地（对照目标形态）

| 能力 | 目标形态 | 现行 |
|------|----------|------|
| 目标 + 退出条件硬门禁 | **必须**；缺则 ALIGNING | **R1** ✅ slash / Portal 对焦浮层 / `ask_user` |
| 拆解 → 子代理 | 核心 | **R3** ✅ + **派工硬门禁**（本轮 0 派工时父侧禁调研类工具） |
| 本轮子代理守候 | live=0 才验收 | ✅ `roundJobIds` + `live_subagents` |
| 对照目标验收 | 硬门闸 | **R4** ✅ + **验收硬门禁**（派工后须 `loop_verdict`；跳过则强制收尾） |
| 中间评审 HITL | 不确定可提问 | ✅ VERIFY 中途 `ask_user`；pending ask 推迟 `verify_skipped` |
| 结案 HITL | met 不自动结束 | ✅ `pending_user_confirm` + Portal 浮窗 |
| 退出截断 | 不挂死 | `minRounds` / `maxRounds` / `maxWallMs`；live/pending ask 时推迟 |
| Portal 可操作 | 用户懂「待哪」并能点 | **R5** ✅ 底栏 + 小精灵（见 §6.3） |

**结论**：R1–R5 + 门禁加固已构成可演示的 L3；R6（定时触发）暂缓。

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
  usage: {
    dispatchCount: number;
    evaluatorCount: number;   // 独立 cheap 验收次数（≠ loop_verdict 次数）
    continueCount: number;
    reviseCount: number;
  };
  timeline: Array<{ at: number; kind: string; summary: string }>;
};
```

**UX 桶**（Portal / status，非 store status）：`待对焦` / `待派工` / `待验收` / `已结束`  
（`getLoopUxBucket`：有本轮派工后即进「待验收」，直至 ENDED。）

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
     │ VERIFYING │◄── ask_user（不确定/异常）后继续
     └─────┬─────┘
           │
     met ──┼─ yes → PENDING_USER_CONFIRM →（Portal 结束）→ ENDED
           │                         └（Portal 继续）→ PLANNING
           │
           no → REFLECTING →（未触达 exit）→ PLANNING
                          └（触达 exit / stop）→ ENDED
```

| 阶段 | 硬约束 |
|------|--------|
| ALIGNING | 无完整 objective+exit → **禁止**派子代理 |
| PLANNING | 产出可派发 tasks |
| DISPATCHING | 复用 Phase B；吃并行预算；本轮 live>0 时父侧禁调研/再派工 |
| VERIFYING | 对照 mission.objective（+ acceptance）；可中途 `ask_user` |
| PENDING_USER_CONFIRM | `met=true` 后等人确认结束/继续 |
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

## 6. 验收、退出与硬门禁

### 6.0 环节硬约束矩阵（SSOT）

原则：**退出与阶段推进靠硬字段/硬门禁，不靠模型「记得遵守」的软提示。**

| 环节 | 约束 | 落地 |
|------|------|------|
| **ALIGNING** | 缺 objective 或 exit.description → 禁止派工 / verdict | Hard ✅ |
| **Confirm** | `/loop confirm`（或一次写齐）前不得 PLAN/DISPATCH | Hard ✅ |
| **PLAN → 首次派工** | 本轮 0 派工时父侧禁调研类工具，须先 `call_agents` | Hard ✅（`AGIM_LOOP_DISPATCH_GATE`） |
| **DISPATCH 计数** | `continue/revise` 要求本轮 `dispatchesThisRound≥1` | Hard ✅（`no_dispatch`） |
| **本轮子代理守候** | 仍有 pending/running 子代理 → **不进验收桶、不触发 VERIFY follow-up、拒绝 `loop_verdict`** | Hard ✅（`live_subagents` / `canVerify`） |
| **VERIFY 中途 HITL** | **仅父侧**；`live=0` 后结论不确定 → `ask_user` 再 `loop_verdict`；`live>0` 禁提问解阻塞；子代理禁 `ask_user`/`loop_verdict` | Hard ✅（父侧门禁 + `callerDepth`） |
| **VERIFY** | 子代理全结束后须成功 `loop_verdict`；跳过 → follow-up → `verify_skipped` | Hard ✅（`AGIM_LOOP_VERIFY_GATE`） |
| **退出下限 `minRounds`** | `stop`+`met=true` 在 `round < minRounds` 时拒绝 | Hard ✅（`need_more_rounds`） |
| **退出上限 `maxRounds` / `maxWallMs`** | 触达即截断（可不经 verdict）；有 live 子代理时推迟 | Hard ✅ |
| **独立 cheap 验收** | `stop`+`met=true` 前可选再判 | Soft/auto（`AGIM_LOOP_EVALUATOR`） |
| **R6 Heartbeat 触发** | 只负责 start，仍走 ALIGNING | 暂缓 |

#### 已拍板（2026-07-25）

| 问题 | 决议 |
|------|------|
| 「重复 N 轮」 | **min=N，max=N×2**（可多做，有上限） |
| `met=true` | **不自动结案** → `pending_user_confirm`；Portal 底部浮窗展示结论，用户可补充后选 **结束 / 继续下一轮** |
| 子代理守候粒度 | **按本轮**：`roundJobIds` live=0 才启动评审；评审后再开下一轮派工 |
| 验收前父侧 | **live>0 只 wait**（sleep/now）；**live=0** 才可 `ask_user` / `loop_verdict`；验收后可总结或补充调研 |
| 中间评审提问 | **仅父侧**；不确定结论 / 疑问 / 数据异常时先 `ask_user`，用户回复后再 `loop_verdict` |
| 子代理与门禁 | 派工/等待门禁 **仅 depth=0**；子代理共享 threadId 但不得被 wait-gate 禁调研 |
| 子代理工具审批 | **代审免卡**（`callDepth>0`）；主 turn 仍受 `AGIM_AUTO_APPROVE`；敏感路径仍硬拒 |
| Turn 委托上限 | `continue/revise` 进入下一轮时 **重置** 本 turn 的 `call_agent` 计数 |

`至少/最少/不少于 N 轮` 仍为 `minRounds` only；`做满 N 轮` 仍为 min=max=N；`最多 N 轮` 仅为上限。

### 6.1 退出路径

| 路径 | 条件 | `endReason`（示意） |
|------|------|---------------------|
| 达标 | `loop_verdict` `stop`+`met=true`（且 `round≥minRounds`）→ 用户 Portal **确认结束** | `objective_met` |
| 轮次/墙钟 | 触达 Mission 的 `maxRounds` / `maxWallMs` | `limit` / `wall_limit` |
| 跳过验收 | 强制 follow-up 后仍无 verdict（或回合结束仍缺），且无 live 子代理 | `verify_skipped` |
| 用户/Focus | `/loop stop`；Focus off/clear | `cancelled` / `focus_off` |

退出 NL → 硬字段（`parseExitConstraints`）：

| 文案 | 硬字段 |
|------|--------|
| `至少/最少/不少于 N 轮` | `minRounds=N` |
| `最多 N 轮` / `N 轮结束` / `N rounds` | `maxRounds=N` |
| `重复 N 轮` | `minRounds=N`，`maxRounds=N×2` |
| `做满 N 轮` | `minRounds=maxRounds=N` |
| `超过 T 小时/分钟` | `maxWallMs` |

VERIFY 结构化字段至少：`{ met, summary, gaps?, nextDirection? }`。  
`continue|revise` 要求本轮已派工 + `met=false` + `nextDirection` + **无 live 子代理**。

**重要**：墙钟 / 轮次截断 **不等待** `loop_verdict`（`maybeEnforceLoopExit`）；避免报告已写出却永远停在「待验收」。  
但若本线程仍有 **进行中的 Subagent job**，自动收尾（`wall_limit` / `verify_skipped`）与 **验收启动** 都会 **推迟** 到子代理全部结束后；若仍有 **未完成的 `ask_user`**（`threadHasPendingAsk`），`verify_skipped` 与 VERIFY follow-up 同样推迟，等用户回复后再继续。主 Loop / Portal 通过 `GET /api/loop` 轮询 `liveSubagents`。`/loop stop` 会立刻结束 Loop **并取消** 未完成子代理。

#### 中间评审 `ask_user`（VERIFY HITL）

| 触发 | 行为 |
|------|------|
| 子代理结果冲突 / 数据异常 / 验收标准不清 | **父侧**在 `live=0` 后调用 `mcp__agim__ask_user` |
| 用户回复 | 工具返回后父侧再调 `loop_verdict` |
| 有 pending ask | `loopNeedsVerdict=false`；不强制 follow-up；不 `verify_skipped` |
| `live>0` | 父侧 **不得** `ask_user`「解阻塞」；只 sleep/now |
| 子代理 | `callerDepth>0` → `ask_user` / `loop_verdict` **拒绝** |
| 仍禁止（父侧验收前） | 调研类工具、`call_agent(s)` |

详见 [`ask-user.md`](../ask-user.md) § Loop Engineering。

### 6.2 硬门禁（运行时）

| 门禁 | 默认 | 行为 | 开关 |
|------|------|------|------|
| **ALIGNING** | on | 确认前拒绝 `call_agent(s)` / `loop_verdict` | （核心，无关） |
| **派工** | on | 本轮 `dispatchesThisRound===0` 时父侧拒绝调研类工具（`web_fetch`/`exec`/…），须先 `call_agents` | `AGIM_LOOP_DISPATCH_GATE`（`off` 关闭） |
| **子代理守候** | on | **本轮** `roundJobIds` live>0 → 不进验收、`loop_verdict`→`live_subagents` | （核心） |
| **父侧等待** | on | 本轮已派工后至 verdict 前：**仅 depth=0**；`live>0` 仅 sleep/now；`live=0` 才可 `ask_user`/`loop_verdict` | 同 `AGIM_LOOP_DISPATCH_GATE` |
| **验收** | on | 本轮已派工且 live=0 后须成功 `loop_verdict`；缺则 follow-up 一轮，仍缺 → `verify_skipped`（有 pending `ask_user` 时推迟） | `AGIM_LOOP_VERIFY_GATE`（`off` 关闭） |
| **结案确认** | on | `met=true` → `pending_user_confirm`；`POST /api/loop/confirm-met` | （核心） |
| **退出下限** | on | `stop`+`met=true` 且 `round < minRounds` → `need_more_rounds` | （核心，由 exit NL 解析） |
| **独立验收** | auto | `stop`+`met=true` 前用 `llmRoles.cheap` 再判（无 cheap / `off` 则 skip） | `AGIM_LOOP_EVALUATOR=auto\|on\|off` |

实现要点：

- `mcp__agim__loop_verdict` 与 `call_agents` 一样设 **`timeoutMs: 0`**，避免嵌套独立验收超过 Native 默认 60s 后，工具桥把**已成功结束的 Loop** 报成超时 → 模型重试得到 `no_active_loop`。  
- mutation 墙钟 abort 后若副作用已成功，tool-bridge **回报成功**（附注），不覆盖为假超时。  
- `GET /api/loop` DTO 含 `liveSubagents` / `canVerify` / `minRounds`；Portal 在 live>0 时隐藏「立即行动」。

### 6.3 Portal UX（R5）

不挡聊天的状态条已去掉；Loop 进展是小精灵的一种任务状态。

| 场景 | UI | 用户动作 |
|------|-----|----------|
| **待对焦** | 底部浮层：目标 + 退出条件 | 「确定并开始」→ 发送 `/loop …；退出条件为…` |
| **待派工 / 待验收**（Agent 空闲） | 底部「立即行动」条（类审批） | 代用户发推进指令（`call_agents` / `loop_verdict`） |
| **中间评审提问** | 与全局一致：`ask_user` 选择卡（Portal / IM） | 点选或文本回复 → Agent 继续 `loop_verdict` |
| **结论已就绪** | 底部结案浮窗（`pending_user_confirm`） | 可补充说明 →「确认结束」或「继续下一轮」 |
| **任意活跃阶段** | 小精灵气泡 + 任务面板 `loop` 行 | 展示桶名 · 轮次 · 派工/独立验收用量 |
| **结束** | Markdown 结束总结；小精灵可短暂显示后消失 | — |

API：`GET /api/loop?threadId=&lang=zh|en` → `LoopStatusDto`（`bucket` / `bucketLabel` / `liveSubagents` / `canVerify` / `minRounds` / `usage` / `lastVerification`…）。  
轮询在 lazy chunk（`portal-loop-dock` + `use-portal-loop`），避免撑破 SPA entry 350 KiB。

**文案**：一律「待对焦 / 待派工 / 待验收」，不用「卡在…」。子代理进行中时小精灵可显示「子代理进行中」，且不弹出验收「立即行动」。  
用量行写 **「独立验收 N」**（`usage.evaluatorCount`），**不要**读成「loop_verdict 次数」——独立验收 skip 时 N 可为 0，但 Loop 已通过 verdict 结束。

相关文件：`portal-loop-dock.tsx` · `use-portal-loop.ts` · `portal-pet.tsx` · `src/web/loop-api.ts` · `loop-parent-wait-gate.ts` · `ask-user-rpc.ts`（`threadHasPendingAsk`）。

### 6.4 离线 / mock 验收

| 工具 | 用途 |
|------|------|
| `tools/loop-gates-sim.mjs` | 无浏览器：派工门禁 / 验收门禁 / wall / `verify_skipped` / 文案解析 |
| `tools/mock-llm-server.mjs` | `LOOP_E2E_TEST` · `LOOP_SKIP_VERDICT_TEST` · `LOOP_SELF_RESEARCH_TEST` |

手测清单见 [`desktop-regression.md`](../desktop-regression.md) §3.2。

### 6.5 环境变量速查

| 变量 | 默认 | 含义 |
|------|------|------|
| `AGIM_LOOP_DISPATCH_GATE` | on | 派工前禁父侧调研 |
| `AGIM_LOOP_VERIFY_GATE` | on | 派工后强制 `loop_verdict` |
| `AGIM_LOOP_EVALUATOR` | `auto` | `stop`+`met=true` 前独立 cheap 验收 |
| `AGIM_LOOPS_DIR` | `~/.agim/loops` | Loop JSON 目录（测试可覆盖） |

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
| **R5** ✅ | **收尾 UX（必备）** | `GET /api/loop`；Portal 对焦/立即行动底栏 + 小精灵 Loop 状态；结束总结 Markdown；菜单文案对齐 L3 | 用户能看懂「待对焦/待派工/待验收」并直接操作 |
| **加固** ✅ | **门禁 + 超时** | 派工/验收硬门禁；exit 不等待 verdict；`loop_verdict` `timeoutMs:0`；假超时不覆盖成功 | 不出现「已提交却无活跃 Loop / UI 假待验收」 |
| **R6** | **可选触发** | Heartbeat/cron **只负责 start**，仍走 ALIGNING | 不绕过对焦 |

推荐合入顺序：**R1 → R2 → R3 → R4 → R5 → 加固**（产品闭环）；**R6 可选，暂缓**。

```text
R1 对焦门禁 ──► R2 Mission 存储 ──► R3 拆解+子代理 ──► R4 验收闭环 ──► R5 UX ✅
                                                                      │
                                                         加固（门禁/超时/exit）✅
                                                                      │
                                                            R6 触发器（可选·暂缓）
```

---

## 8. 与 Claude Code「Loop Engineering」对照

来源：[Getting started with loops](https://claude.com/blog/getting-started-with-loops)（Claude Code 团队分类）。

| Claude 类型 | 你移交什么 | Claude 原语 | **Agim 对应** |
|-------------|------------|-------------|----------------|
| Turn-based | 检查 | 普通对话 / skills | **L2 Agent Loop**（每轮工具循环） |
| Goal-based | 停止条件 | **`/goal`**（达成或轮次上限；可有独立 evaluator） | **`/loop`（本 SSOT）** + R4 `met`/`nextDirection` + 可选 **cheap 独立验收** |
| Time-based | 触发 | **`/loop` / `/schedule`**（按间隔再跑） | **Heartbeat / 提醒**（R6 暂缓；**不**占用 `/loop` 名） |
| Proactive | prompt + 组合 | schedule × goal × workflow | 未做；勿与使命 `/loop` 混谈 |

**命名要点**：用户从 Claude 过来时，听到「Loop」常以为是定时轮询——在 Agim 里请说「使命闭环 / Loop Engineering L3」；定时能力另开刀。

**已吸收**：

- **A** 本文对照表 + `/loop help` + naming  
- **B** `stop`+`met=true` 前 `AGIM_LOOP_EVALUATOR`（默认 `auto`：有 `llmRoles.cheap` 则独立验收）  
- **C** Loop 累计用量（派工 / 独立验收 / continue / revise）进 status、结束总结、Portal（小精灵/底栏）  

---

## 9. 非目标

- 把 L2 Agent Loop 再包一层皮叫 Loop  
- 静默默认退出条件（禁止「没说就按 12 轮」不经确认）  
- 多团队 swarm、自动开 PR/merge（后置）  
- Focus 上做完成勾选 / evidence CAS  
- Heartbeat 与 LoopRun 共用存储  

---

## 10. TL;DR

> **Loop = L3：先对焦（目标+退出条件）→ 拆解 → 子代理 → 验收 →（未达）再来 → 退出。**  
> **两硬输入缺一不可；缺则 ALIGNING，不派工。**  
> **≠ Claude 的定时 `/loop`；≈ 他们的 `/goal` 级闭环。**  
> 节奏：R1–R5 + 门禁加固已齐；R6 触发暂缓。

---

## 11. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-07-24 | 初稿（executor/observer 薄模型） |
| 2026-07-24 | 按三层图重写为 L3 |
| 2026-07-24 | **目标+退出条件硬门禁 + ALIGNING；落地节奏 R1–R6** |
| 2026-07-24 | **R1 落地**：ALIGNING 状态机 + slash 对焦 + dispatcher 门禁 |
| 2026-07-24 | **R2 落地**：Mission SSOT（对焦期部分填写）+ sessionKey + acceptance/maxWallMs + status |
| 2026-07-24 | **R3 落地**：PLAN+DISPATCH 门禁（本轮须派工才能 continue/revise） |
| 2026-07-24 | **R4 落地**：VERIFY+REFLECT 结构化验收 + exit 截断 |
| 2026-07-24 | **R5 落地**：`/api/loop` + Portal 底栏/小精灵状态 + 结束总结；R6 暂缓 |
| 2026-07-24 | **吸收 Claude 文 A/B/C**：对照表、cheap 独立验收、Loop 用量 |
| 2026-07-24 | **加固**：派工/验收硬门禁；exit 不等待 verdict；`loop_verdict` 超时与假超时修复；Portal「待*」话术 + 独立验收计数 |
| 2026-07-24 | **文档**：§6 展开门禁/Portal/env/mock；与 orchestration / portal-composer / 回归清单对齐 |
| 2026-07-24 | **子代理未完成不自动收尾**：wall/verify_skipped 推迟；`/loop stop` 取消子代理；`loop_verdict`→`live_subagents` |
| 2026-07-25 | **退出硬字段 `minRounds` + 子代理守候不进验收**：§6.0 硬约束矩阵；`need_more_rounds`；DTO `liveSubagents`/`canVerify` |
| 2026-07-25 | **拍板落地**：重复N→min/max=N/N×2；met 结案浮窗；本轮 `roundJobIds`；父侧验收前只等待 |
| 2026-07-25 | **VERIFY 中途 ask_user**：父侧等待门禁放行提问；pending ask 推迟 `verify_skipped`；主流程/状态机/Portal/`ask-user.md` 对齐 |
| 2026-07-25 | **门禁误伤修复**：wait/dispatch 仅 depth=0；子代理禁 HITL；live>0 禁父侧提问解阻塞；continue 重置 turn 委托上限；子代理工具代审免卡 |
