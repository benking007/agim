# Step Reflect（步思 · 一步一想）

> **状态**：设计草案（R0 · 文档先行，无运行时）· 2026-08-14  
> **用户面（拟）**：Composer「一步一想」· `/step-reflect on|off` · activity `kind: 'reflect'`  
> **代码名**：`step-reflect` / `stepReflect`  
> **关联**：[命名](../naming.md) · [Loop L3](./loop-engineering.md) §1 · [编排路线图](./orchestration-roadmap.md) · [Focus](./focus.md) · [Portal 输入框](../portal-composer.md) · [现行架构](./current.md)

---

## 0. 一句话

**Step Reflect = L2 节拍策略：每次行动的工具结果落地之后、下一次可能再调工具之前，先露出 2–4 句短反思，再继续动手。**

它**不是** `/loop`（L3 调度/验收），**不是** Focus，**不是** 思考模式（`reasoning_content` / `/think`），**不是** 用户本轮补充（Steer）。

对照 DeepSeek Harness 的默认 agent-loop：一步 = 一次模型请求 + 它发出的工具 → 结果写回 → 再开下一步。Agim 底层已有这条 L2 while；缺的是**可开关、用户可见、可门禁**的「结果 → 短反思 → 再行动」。

---

## 1. 分层（必读）

```text
┌─────────────────────────────────────────────────────────┐
│  L3  Loop Engineering（/loop）                           │
│   对焦 → 派工 → 整轮验收 / 反思再来 → 退出                 │
│   粒度：一轮 Subagent / 一轮使命，不是每步工具              │
├─────────────────────────────────────────────────────────┤
│  L2  Agent Loop                                          │
│   while not done: Observe → Think → Tools → Results      │
│   Step Reflect 挂在这里：Results 之后插入短反思节拍         │
├─────────────────────────────────────────────────────────┤
│  L1  LLM API                                             │
│   streaming · reasoning_content · token                  │
│   隐藏 CoT ≠ 步思（步思必须用户可见）                       │
└─────────────────────────────────────────────────────────┘
```

| 层 | Step Reflect | 不是 |
|----|--------------|------|
| **L2 cadence** | 单代理 tool loop 的节拍策略 | 第二个 `/loop` |
| **可见过程** | activity 卡片夹在工具组之间 | 把完整 CoT 摊开 |
| **门禁（R2）** | 未反思则挡住**变更类**工具 | 强制「一次只调一个工具」 |

**父进程仅 Agim Agent**（`agim` / 遗留 `native`）。Codex 等 sticky CLI 跑在子进程里，做不了进程内门禁——与 Plan / critic / todo-gate 同一边界。

---

## 2. 用户意图（不可漂移）

用户要的是：

> 「它刚读完 / 改完 / 搜完，先用两句话说清看到了什么、下一步为什么这样，再动手。」

不是：

> 「再包一层自动调度，验收整轮使命。」（那是 `/loop`）  
> 「把模型脑子里的长思考全文播出来。」（那是 `/think`）  
> 「我中途改口。」（那是 Steer）  
> 「动手前先写清单。」（那是 todo-gate / Plan）

因此 Step Reflect **只做三件事**：

1. **定义节拍**：一次 act 之后，若还要再 act，必须先 reflect  
2. **露出短反思**：用户在 activity 里看见，而不是只进隐藏上下文  
3. **（R2）挡住抢跑**：模式开启时，未反思不得再写/执行

---

## 3. Beat 契约

### 3.1 什么算一次 act

**同一次 assistant 完成里发出的全部工具调用 = 一次 act**（含并行 fan-out）。

不强制「一次只调一个工具」。并行读三个文件、或 `call_agents` 一次派三个工人，仍是 **一个** act；反思覆盖这整批结果。

```text
assistant ──► tool A ┐
              tool B ├─ results 落地 ──► 短反思 ──► 下一拍 assistant
              tool C ┘
                 ▲
              一次 act
```

### 3.2 反思插在哪

反思发生在 **本拍工具结果写回之后**、**下一次可能再调工具的模型请求发出之前**（或该请求的可见正文开头）。

终局（模型不再调工具、直接回复用户）**不是**一拍 beat，不强制再插一条空反思。

### 3.3 短反思长什么样

2–4 句，结构化，**禁止**把 hidden CoT 原样倾倒。字段：

| 字段 | 必填 | 含义 | 上限（拟） |
|------|------|------|------------|
| `observed` | 是 | 这批结果实际看到了什么（事实，不抒情） | 240 字 |
| `stance` | 是 | `keep` 继续原计划 / `adjust` 改道 / `stop` 该收了 | enum |
| `next` | 是 | 下一拍只说一件事 | 160 字 |
| `risk` | 否 | 若继续，最大风险一句 | 120 字 |

用户面默认展开 `observed` + `next`；`stance` 用小徽章（继续 / 改道 / 收束）。`risk` 折叠。

### 3.4 跳过（不发 beat）

下列情况 **不**要求反思，也 **不**挡工具：

| 跳过 | 原因 |
|------|------|
| 模式关闭 / `disabled` | 日常闲聊不纳税 |
| 本拍 0 个工具（纯文本收尾） | 没有「结果」可反思 |
| 本拍工具 ⊆ 豁免集（含纯只读） | 已拍板跳过；澄清/勾清单/读文件自己不是「待反思的 act」 |
| 即将收尾：模型本请求不再调变更类工具 | 终局回复即可 |
| 本轮到目前只有 1 次工具且随即终局 | 单工具问答不插卡片 |
| sticky CLI / 非 Agim 父进程 | 无进程内 hook |
| 子代理内部 | **不**在主 activity 再插 `reflect` 行；同族工人的步思只在 Subagent **行内**轮播（§6.5） |

用户 **Steer** 插入本轮时：视为人类改道，**清掉**「待反思」标记，不要求先补一条反思再消化 Steer。

---

## 4. 与现有能力分工

| 能力 | 时机 | 可见性 | 硬门禁 | 职责 |
|------|------|--------|--------|------|
| **todo-gate / Plan** | 动手**前** | Plan 卡 | 无清单则挡变更 | 先想清楚再动手 |
| **Step Reflect** | 每拍 act **后** | activity `reflect` | R2：未反思挡变更 | 看完结果再决定下一拍 |
| **goal-critic** | 满 5 次工具后每 5 次 | 默认不可见（偏航才 soft-steer） | 重复偏航可 `off_track` | 带外巡检：还在不在为本轮请求做事 |
| **Steer** | 用户中途 | 队列卡片 | 无 | 人打断、改口 |
| **Loop VERIFY / REFLECT** | 一轮派工**之后** | Loop dock / 结案 | 未验收不能伪称完成 | L3 使命闭环 |

不合并：

- 不要把 critic 改成「每次 beat 都跑且用户可见」——那是 R3 的可选 cheap 拆分，且仍叫 critic 会污染命名。  
- 不要把 Loop 的 REFLECT 相位复用为本功能的 UI 文案。用户面只说 **一步一想 / 步思**。  
- Focus 仍是背景锚点，**不得**因「没做 Focus 里的事」而要求改道；与 critic 同一优先级：本轮用户请求优先。

```text
动手前          每拍结果后         每 5 次工具         用户中途         整轮派工后
todo-gate       Step Reflect      critic（带外）      Steer            Loop verify
  │                 │                  │                │                  │
  ▼                 ▼                  ▼                ▼                  ▼
先写清单         短反思再行动        偏航才出声         人改口            验收/再规划
```

---

## 5. 运行时形状（拟）

### 5.1 开关

| 表面 | 键 | 默认 | 说明 |
|------|----|------|------|
| 环境 | `AGIM_STEP_REFLECT` | `off` | `on` \| `off` \| `disabled`（`disabled` = 隐藏开关且永不生效） |
| 会话 | `session.stepReflect` | 跟随环境；用户可拨 | 与 `planMode` 同级的会话补丁 |
| 斜杠 | `/step-reflect on\|off` | — | 不要用 `/reflect`（撞 Loop REFLECT） |
| Composer | 状态栏芯片「一步一想」 | 仅 Agim Agent | 对齐思考开 / Plan；非 Agim 隐藏 |

布尔极性跟 Plan：`on`/`off`，写进 `naming.md` env 表。历史前缀 `AGIM_NATIVE_*` **不要**再开一支。

### 5.2 豁免工具（拟，对齐 todo-gate）

反思本身、澄清、清单、只读探测 **不**构成「待反思的 act」：

- `agim_reflect`（R2）
- `agim_todo_write` / `agim_exit_plan_mode`
- `mcp__agim__ask_user`
- `agim_echo` / `agim_now` / `agim_random_uuid` / `agim_sleep_ms`
- 只读：`agim_read_file` / `list_dir` / `glob` / `grep` / `web_fetch` / `web_search` / memory·skill 查询

**读也算 act 吗？已拍板：跳过。** 一批纯只读不插反思、不挡下一拍。若该拍出现 **任一非豁免工具**（写、exec、`call_agent(s)`、浏览器操作等），该拍结束后进入「待反思」；下一拍变更类工具必须先反思。

R1 可先用「有非豁免工具才提示」，不做硬挡。

### 5.3 两条落地路径

**路径 A（R1–R2 主路径）· 同模型 in-band**

工具结果写回后，若本拍产生了待反思：

1. 给下一拍模型请求挂一条 **ephemeral steer**（机制复用 critic / 用户 Steer 的 in-context 注入，文案前缀 `[step-reflect]`，勿复用 `[loop steer]`）。  
2. 要求先输出短反思（R1：可见文本块；R2：优先 `agim_reflect`）。  
3. R2：`evaluateStepReflectGate` 挂在现有 tool preflight 旁（与 `evaluateTodoMutationGate` 并列）。未反思且工具非豁免 → 拒绝并回写原因，**不**消耗「乱调工具」的 stuck 计数。

同一 completion 里允许「先 `agim_reflect` 再发下一拍工具」（一轮请求内完成 reflect→act）。

**路径 B（R3 可选）· cheap 拆分**

像 critic 那样另打一枪 `llmRoles.cheap`，但：

- **每次**待反思 beat 都跑（不是每 5 次）；  
- 结果 **用户可见**（activity `reflect`）；  
- 主模型下一拍只看到结构化反思，不再自己编。

更贵、更像 Trajectory 回放。默认关；需 `AGIM_STEP_REFLECT_SPLIT=on` 且已配 cheap。

### 5.4 `agim_reflect`（R2）

内置工具，前缀 `agim_*`。建议 schema：

```json
{
  "observed": "string",
  "stance": "keep | adjust | stop",
  "next": "string",
  "risk": "string?"
}
```

实现要点：

- 与 `agim_todo_write` 一样发 `activity-step`（`kind: 'reflect'`），同一 beat 重复调用 **折叠到同一 step id**。  
- `stance=stop` **不是**硬停；只是建议。真正终止仍走模型终局或用户 Stop。  
- 工具本身只记账 + 广播，不改文件。

R1 若尚未做工具：可从助手可见文本里解析 `<!-- step-reflect -->` 围栏（仅过渡）。R2 上岸后删解析器，避免双源。

### 5.5 挂载点（现码）

| 点 | 文件 | 做什么 |
|----|------|--------|
| 工具结果之后 | `src/plugins/agents/agim-agent/index.ts`（critic 段附近，约 toolResults 处理之后） | 标记 `pendingReflect`；注入 ephemeral steer |
| 变更预检 | 同文件，`evaluateTodoMutationGate` 旁 | R2 门禁 |
| 工具定义 | `agim-agent-shared` + dispatcher | `agim_reflect` |
| 会话补丁 | `src/core/session.ts` | `stepReflect?: boolean`（与 `planMode` 同模式：on 才落盘） |
| WS | `activity-step.step.kind` 增 `'reflect'` | 前后端类型一起改 |
| Portal / 桌面 | 现有 activity accordion | 新 kind 的卡片；**不**新开路由、不抬 bundle 预算 |
| 斜杠 | 现有 `/plan` `/think` 注册表 | `/step-reflect` |

Critic 与 Step Reflect 若同一拍都该跑：**先落反思标记 / 注入步思 steer，再跑 critic**。critic 偏航时的 soft-steer 可以追加在步思 steer 后面，不要互相覆盖。

---

## 6. UI

### 6.1 activity 卡片

现有 `ChatActivityStep.kind`：`'tool' | 'approval' | 'ask' | 'skill' | 'status' | 'agent'`。  
**加 `'reflect'`**，不要新开一种气泡，也不要塞进 assistant 正文当普通段落（刷新 / `get-history` 会丢过程感）。

卡片夹在 **上一拍 tool 组** 与 **下一拍 tool 组** 之间：

```text
▾ 工作中
  ✏️ write_file  src/core/llm/todo-gate.ts
  🧪 agim_exec   bun test todo-gate
  💭 一步一想    门禁测过了，但 toolResults 之后还没 hook · 改道 · 下一拍补 evaluateStepReflectGate
  ✏️ write_file  src/core/llm/step-reflect-gate.ts
```

视觉：与 tool 行同宽、弱一档底色；左图标用已有 Lucide（如 `MessageCircle` / `Thought`），**不要**新依赖。`stance` 三色点即可。

### 6.2 Composer（R1 就要做）

输入框下方状态栏加一颗开关，对齐现有「思考开」：

- 仅 sticky = Agim Agent 时显示；切到 Codex 等 CLI 则隐藏  
- 文案 zh：**一步一想** / en：`Step reflect`  
- 默认关；拨开只影响**当前会话**（`session.stepReflect`），不改全局默认  
- 环境 `AGIM_STEP_REFLECT=disabled` 时整颗开关不渲染  
- 斜杠 `/step-reflect on|off` 与开关同源，互相同步  

不要做第三套「模式菜单」。不要和 Plan 互斥——Plan 是动手前只读，步思是动手后复盘，可同时开。

### 6.3 演示

`/m/chat?demo=step-reflect`：静态夹一条 `kind: 'reflect'` 在两工具组之间（仿 `steer-queue` / `jump-latest` fixture）。R1 即可做，不依赖真模型。

### 6.4 非目标（UI）

- 不做独立 Trajectory 时间轴页（R3 再说）  
- 不把反思做成可编辑的用户表单（要改口走 Steer）  
- 不抬 SPA entry / chunk 预算；卡片进现有 accordion  
- **不**把工人步思做成主对话里多出来的 `reflect` 行（那会刷屏、撑高整列）

### 6.5 子代理卡片：行内轮播（已拍板）

父 Agent 派工人时，工人的「一步一想」**露在现有 Subagent 行上**，不另开一行、不另开一张卡。

只对 **同族 Agim 工人**（走 `agim-agent` L2、能发 `agim_reflect` / 围栏）有数据。Codex / Claude 等 CLI 工人没有进程内步思，**不要编造**「一步一想」；继续用现在的 preview / 状态行。

挂在现有 `kind: 'agent'` step 上（与 `todoItems` 同级），例如 `reflects?: Array<{ stance, next, at }>`。同一 `step.id` 上追加，**禁止**再 emit 一条 `kind: 'reflect'` 进父 activity。

```text
┌ Subagents · 1 waiting                         in progress
│  ⟳  → agim · flash          SUBAGENT   12.3s   [Stop]
│     调研 auth 中间件是否已有 gate          ← 现有 preview（任务摘要，不动）
│     💭 改道 · 下一拍补 evaluateStepReflectGate ← 固定 1 行轮播
│     Waiting · View prompt & result
```

**防抖动（硬约束，实现时当验收）**

现有 preview 已会换行（最长约 280 字），步思**不得**再往那段里塞，否则每拍改高度。

| 约束 | 做法 |
|------|------|
| 高度锁死 | 轮播槽 **永远 1 行**：`h-5`（20px）+ `truncate` + `whitespace-nowrap`。禁止换行、禁止 markdown |
| 先占位 | 父开关 on 且该行 live 且工人是同族 Agim：槽 **一开始就占着**（空或「一步一想…」），等第一拍到来再换字。禁止「第一拍才插入一行」把卡片顶高 |
| 只换字、不改盒 | 新拍用 opacity crossfade（≤200ms）。禁止 height / padding 动画，禁止增删 DOM 行 |
| 文案极短 | 卡上只显示 `stance` 徽章（继续 / 改道 / 收束）+ `next`，合计按 CSS 截断；`observed` / `risk` **不上卡** |
| 缓冲上限 | 客户端只留 **最近 3 条**；每条展示约 3.5s，hover 暂停。第 4 条丢掉最旧的，不增加高度 |
| 结束 | 停轮播，**保留最后一条**（槽还在，高度不变）。不要在完成瞬间拆掉槽（那会往上收一截） |
| 全文 | 点行打开现有详情 sheet，在内部滚动区列最近 3–5 条；不撑主列表 |

父开关 off：不占槽、工人也不跑步思节拍。  
父开关 on：同族工人跟父会话跑同一套 R1 软提示 / R2 门禁，但可见出口只有这行轮播。

R1 就可以做槽 + 假数据 demo（`?demo=step-reflect` 给一条 live Subagent 行轮播）。真数据随同族工人能发出反思再接。

---

## 7. 落地节奏

| 节奏 | 内容 | 运行时 |
|------|------|--------|
| **R0** | 本文 + naming / L3 图 / roadmap 交叉链 | 无 |
| **R1** | Composer「一步一想」开关（默认 off）+ `/step-reflect` + 父 activity `reflect` 卡 + **Subagent 行内固定 1 行轮播** + demo | 软；无硬门 |
| **R2** | `agim_reflect` + `evaluateStepReflectGate`（变更类）+ 去围栏解析；同族工人反思挂到 `kind:agent`.`reflects` | 硬门仅挡非豁免工具 |
| **R3** | 可选 cheap 拆分；CLI 工人是否用别的摘要冒充过程（默认仍不做假步思）；Trajectory 分组回放 | 默认关 |

R1 验收（拍板后才开刀）：

1. 开关默认 off；on 之后，含 `write`/`exec` 的 act 结束，下一拍助手可见文案出现短反思，并出现 `reflect` 卡。  
2. 纯问答 / 单次 read 终局 **无** 卡。  
3. Steer 之后不补「为上一拍补反思」。  
4. sticky CLI 无芯片、无门禁。  
5. `npm run lint` / `typecheck` / 相关 bun + SPA 测试绿；i18n 双份。

R2 额外：无 `agim_reflect` 时写文件被拒，原因含 `step-reflect`；先 reflect 再写则通过。与 todo-gate **叠加**（先有清单，再按拍反思）。

---

## 8. 风险

| 风险 | 缓解 |
|------|------|
| 变成第二个 Loop | 命名禁止 Loop/Focus/goal；粒度写死在 L2 beat；不进 `/loop` 状态机 |
| 延迟翻倍 | R1/R2 同模型 in-band，不另开请求；R3 split 默认关 |
| 模型把 CoT 当反思 | 字段上限 + stance enum；UI 截断；R2 走工具 schema |
| 每步都卡，用户嫌烦 | 默认 off；只读拍跳过；单工具终局跳过 |
| 子代理卡随反思抖动 | 固定 1 行槽、先占位、只换字；`observed` 不上卡；见 §6.5 |
| 与 critic 抢 ephemeralSteer | 约定拼接顺序（§5.5），单测锁 |
| CLI 用户以为开了 | 芯片隐藏 + 文档写明仅 Agim |
| 文档/实现双源 | 概念以本文为准；勾选进 roadmap「相关 L2」 |

---

## 9. 已拍板

| # | 决策 | 结论 |
|---|------|------|
| 1 | 默认开不开 | **默认 off**。Chat 输入框下方给「一步一想」开关（仅 Agim；当前会话） |
| 2 | 纯只读拍 | **跳过**。只读探测不插卡、不挡下一拍；写出/执行/`call_agent(s)` 才进入待反思 |
| 3 | 第一版做不做界面开关 | **做。** 原先问的「芯片」= 状态栏那颗小开关（和「思考开」一排）。已由 #1 拍板，R1 就做，不拖到 R2 |
| 4 | 子代理要不要也出步思 | **要，但只在 Subagent 卡片上行内轮播。** 见下 |

**#4（已改）**

父 Agent 派工人时，工人的步思**不要**在主对话里再插一串「一步一想」卡片（会刷屏、整列乱跳）。

改成：露在**现有那一行 Subagent 上**，固定 1 行轮播最近几句（`改道 · 下一拍…`），高度锁死，避免卡片抖动。全文进点开后的详情。

只对同族 Agim 工人有真数据；CLI 工人不编造步思。细节与防抖约束见 §6.5。

---

## 10. 非目标

- 替代 `/loop` 或复用 Loop REFLECT 相位  
- 强制单工具串行  
- 把完整 `reasoning_content` 当反思  
- 给 sticky CLI 做「假步思」（prompt 里写一句但无门禁、无卡片）  
- 抬 SPA bundle 预算  
- 新 Redis / 新路由 / 新气泡类型  

---

## 11. TL;DR

> **步思 = L2：结果 → 2–4 句可见反思 → 再行动。**  
> **一次 assistant 的并行工具 = 一拍 act。**  
> **≠ Loop，≠ Focus，≠ `/think`，≠ Steer。**  
> **默认 off，Chat 状态栏开关；只读拍跳过。**  
> **子代理：行内 1 行轮播，不往主对话插卡。**  
> **R0 本文；R1 开关 + 父卡片 + 子代理轮播槽；R2 `agim_reflect` 硬门；R3 才考虑 cheap 拆分。**

---

## 12. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-08-14 | R0 初稿：beat / 门禁 / UI / 与 todo·critic·steer·loop 对照 |
| 2026-08-14 | 拍板：默认 off + Chat 开关；只读跳过；R1 做状态栏开关；子代理 R1–R2 不冒泡 |
| 2026-08-14 | #4 改：子代理步思在卡片行内固定 1 行轮播（防抖动）；不往主 activity 插行 |
