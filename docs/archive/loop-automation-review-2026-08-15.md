# Loop 专项审查：定时触发缺失 + 自闭环程度（2026-08-15 · v1.6.2）

> **问题来源**：用户自查发现 ① 定时任务无法唤起 Loop；② 怀疑 Loop 循环未自闭环。
> **方法**：2 个并行深读（定时触发可行性 / 自闭环状态机）+ 主 agent 回源验证关键路径（startLoop、applyLoopVerdict、maybeEnforceLoopExit、buildLoopSnippet、routeMessage 调用点）。
> **结论**：① 确认无法定时唤起，根因是"无工具调用 + 无后台回合唤醒入口"两层；② Loop 是**半闭环**——回合内自闭环、回合间人工驱动、结案人工确认（5.5/10）。两问题同源：**Loop 缺无人值守/定时驱动能力，R6 官方暂缓是根因**。

---

## 1. 问题一：定时任务为何无法唤起 Loop

### 1.1 现状

三条定时路径都只做"无工具的一次性 agent 调用或文本投递"，**全库无一行引用 loop-run 的启动函数**：

| 路径 | 执行方式 | 证据 |
|---|---|---|
| `/heartbeat` | DECIDE（cheap LLM）→ EXECUTE（`callHelperAgent`，**空 tools `[]`**）→ EVALUATE（通知门） | `agent-helper.ts:140` `sendPrompt('llm-helper', composed, [], …)` |
| `/cron` → schedule | `fireSchedule` → `createJob` → `sendPrompt('schedule-…', prompt, [], …)`（**空 tools**），结果写 job + 可选 webhook | `schedule.ts:337` |
| `/remind` → reminders | 到点投递纯文本，仅可选润色；头注释明说"No LLM is invoked、no Job is created" | `reminders.ts:3-6` |

`startLoop`（`loop-run.ts:1448`）签名 `{platform, channelId, threadId, userId, text?}`，**纯函数、不依赖交互上下文**；文本经 `parseLoopStartText` 拆出 objective/exit，双字段齐全直接 `status='planning', round=1`。但全库调用者只有 `commands/loop.ts` 与 Portal 聊天消息路径。

### 1.2 阻碍点（两层）

1. **B1 定时路径的 agent 是无工具调用**：即使指令文本写"跑一个 Loop"，agent 没有 `call_agents`/`loop_verdict` 工具，Loop 工具门禁会拒绝（`agim-dispatcher.ts:227-242 refuseIfLoopAligning` 等）。
2. **B2 Loop 状态机没有内部 ticker**：状态迁移全靠父 agent 工具调用（`noteLoopDispatch` ← call_agent(s)，`applyLoopVerdict` ← loop_verdict），而父回合只能由用户消息触发——`routeMessage`（`router.ts:331`）全库只有 3 个调用点：`handle-message.ts:231`、`ws-chat.ts:402`、`messengers-api.ts:259`。**没有任何"后台唤醒某线程 agent 回合"的服务**。
3. **B3 父 agent 必须是 Agim Agent**：`router.ts:674-690` 硬门禁（`loop.parent_agent_blocked`），定时唤起前需确认/切换 sticky agent。
4. **B4 `pending_user_confirm` 是硬性 HITL 门**：met=true 后永久挂起，被明确排除在所有自动截断之外（见问题二 S2）。
5. **B5 文档 R6 设计与"自动开跑"需求相悖**：`loop-engineering.md:509` 约定"R6 只负责 start，仍走 ALIGNING"（要用户对焦确认）；`:548` 明确"静默默认退出条件（禁止"没说就按 12 轮"不经确认）"。

### 1.3 最小实现方案（推荐 A）

```ts
// src/core/loop-scheduler.ts（新增，全用现有导出，不改 loop-run.ts 状态机）
export async function wakeLoopForThread(input: {
  platform: string; channelId: string; threadId: string; userId: string
  objective: string; exitDescription: string
  body?: string; maxRounds?: number; maxWallMs?: number
}): Promise<{ ok: true; run: LoopRun } | { ok: false; error: string }>
```

1. **建 run**：`startLoop({…, text: '目标…；退出条件为…'})`——已 active 返回 `already_running`（调用方记 skipped）；未 aligned 则 `setLoopObjective`/`setLoopExit` + `confirmLoopMission` → `planning, round=1`。
2. **确保父 Agent 是 Agim**：`sessionManager` 检查/切换（参照 `commands/loop.ts:86-90` 反判断 + `router.ts:630-632` 切换写法）。
3. **触发父回合**：复用已导出的 `callAgentWithHistory`（`router.ts:651`，与 `commands/agent.ts:69-72` 同款），单回合内 `runAgentLoop` 带 Loop snippet + 全套 Agim 工具一直跑到模型停止调工具（planning → call_agent(s) 同步 join → loop_verdict → 下一轮…直到 met/maxRounds/maxWallMs）。
4. **接线点**：`schedule.ts fireSchedule` 加 `loop:` 前缀分支（`s.prompt` 以 `loop:` 开头 → wakeLoopForThread，跳过 createJob）；或 heartbeat EXECUTE 检测标记。

**无人值守必需的小改**：`LoopMission.exit` 增加 `unattended?: boolean`（或 env `AGIM_LOOP_HEADLESS=1`），`applyLoopVerdict` 的 `stop+met=true` 分支（`loop-run.ts:1919-1925`）改为：unattended 且 `round >= minRounds` → 直接 `endLoopInternal('objective_met')`；否则维持 `pending_user_confirm`。

**方案 B（补充）**：新增 `mcp__agim__start_loop` 工具——但定时路径 agent 无工具（B1），对它们不可见，改动面更大，仅作补充。
**方案 C（R6 完整版）**：schedules 表加 `kind='loop'` + objective/exit 字段 + Portal 展示——方案 A 的第二刀。

### 1.4 无人值守风险与兜底

| 风险 | 现状兜底 | 缺口/建议 |
|---|---|---|
| 无限轮/烧钱 | maxRounds 默认 12/上限 100；maxWallMs 上限 168h；maybeEnforceLoopExit 免 verdict 截断 | wall 截断在 **live subagent 时 defer**（`loop-run.ts:1135-42`）——卡死的子代理会拖过墙钟；建议定时 loop 强制 exit 含轮数/时长 + 子代理 job 超时 |
| pending_user_confirm 卡死 | 无 | 实现 unattended 标志；或给该状态加独立超时（如 24h 归档） |
| approval 卡住 | 子代理代审免卡（callDepth>0）；主 turn 受 AGIM_AUTO_APPROVE | headless 下要求 `AGIM_AUTO_APPROVE=1`（启动校验告警）或限制父侧只派工不改写 |
| ask_user 阻塞 | 默认 5min 超时自动回 timeout | headless 时禁用 ask_user 或缩短 timeoutSec |
| 父回合被截断 | maybeReapIdleLoopVerify 按 verify_skipped 收尾 | 多轮 Loop 一轮没跑完会被提前结束——定时场景可接受（下次触发再起），但结果文案需说明 |
| Focus 抢占 | Path B 代开 Focus、结束自动 focusOff | 定时 Loop 建议落**专用线程**，避免抢占用户在用 Focus |
| 重入/重复触发 | startLoop already_running + schedule CAS + heartbeat ticking | wake 对 already_running 记 skipped，不重试轰炸 |
| 父 agent 不可用 | circuitBreaker.peek / isAgentAvailableCached | wake 需 try/catch + 失败落回 schedule/heartbeat 行状态，不静默丢失 |

---

## 2. 问题二：Loop 自闭环审查

### 2.1 状态迁移图

```
触发源（全部为指令/消息/点击，无定时器）：
  /loop 指令 · Portal「立即行动/确定并开始」· 用户任意普通消息

startLoop (loop-run.ts:1448)
  objective+exit 齐 → planning, round=1 (1532-33)    缺一 → aligning, round=0
      │
 ALIGNING → 用户补字段（/loop objective|exit / Portal 浮层）
      │     双字段齐自动 confirm (commands/loop.ts:221-230)
      ▼ confirmLoopMission (loop-run.ts:1671 → planning)
 PLANNING (round≥1) ◄────────────────────────────────────────┐
      │ noteLoopDispatch: call_agent(s) 接受派工               │
      │   (agim-dispatcher.ts:1019/1196 → loop-run.ts:1717)   │
      ▼                                                      │
 DISPATCHING ── 父回合 await 子代理 join（同步阻塞）             │
      │   (agim-dispatcher.ts:1031 / 1219-1265)              │
      │ 子代理全结束 → notifyLoopJobTerminal (loop-run.ts:1056)│
      │   ★ 仅刷新快照+timeline+WS loop-changed，不触发验收      │
      ▼                                                      │
 父模型调 mcp__agim__loop_verdict（唯一验收入口）                │
      │   (agim-dispatcher.ts:1359-1414)                     │
      ▼ applyLoopVerdict (loop-run.ts:1830)                  │
 ├─ live_subagents>0 → 拒绝 (1851)                           │
 ├─ 墙超时 → ENDED wall_limit (1856)                         │
 ├─ continue/revise + met=false + nextDirection：            │
 │    → round+1 → planning（同回合内自动，1941-48）───────────┘
 │    └ 模型就此结束回合 → 停在 PLANNING 等用户（人工点）
 ├─ stop + met=true → PENDING_USER_CONFIRM (1922)  ← 永久挂起
 │    └ Portal 浮窗「确认结束」→ ENDED objective_met (1979)
 │    └ Portal 浮窗「继续下一轮」→ planning round+1 (1984-2005)
 │    └ /loop stop → ENDED user_stop（唯一非浮窗逃逸）
 ├─ stop + met≠true → ENDED stop_verdict (1927)
 └─ round≥maxRounds → ENDED limit (1932)

强制收尾（均为"停止"语义）：
  · wall_limit ← maybeEnforceLoopExit（回合开始/join 后/Portal 轮询）
       —— pending_user_confirm 与 live 子代理时 defer (1132-42)
  · verify_skipped|limit ← maybeReapIdleLoopVerify（父回合已亡+派工≥1+live=0）
       (loop-verify-gate.ts:92-118 → loop-run.ts:1158-1205)
  · user_stop ← /loop stop（取消在跑子代理，1783-95）
  · focus_off ← focus off/clear（1799-1828）
```

### 2.2 人工依赖点

| # | 环节 | 必需？ | 无人工时 |
|---|---|---|---|
| 1 | ALIGNING 对焦 | **可跳过**（一条指令给齐两字段即 planning） | 缺字段时无限等，无超时 |
| 2 | **父回合触发** | **必需（每个回合）**——无定时器，R6 暂缓 | 回合结束即停，等用户下一条消息 |
| 3 | 子代理完成→验收 | 父模型必须调 loop_verdict；notifyLoopJobTerminal 不触发验收 | 父回合亡 → verify_skipped 强制结束 |
| 4 | VERDICT 产生 | 父模型调 loop_verdict；evaluator 仅否决 met=true 主张 | 否决后模型自行修正，无自动降级 |
| 5 | continue/revise 后下一轮 | **同回合内自动**（round+1/planning/cap 重置/门禁强制先派工） | 模型未继续派工 → 停 planning 等人 |
| 6 | **pending_user_confirm 结案** | **必需（设计刻意）**，无超时逃逸；IM-only 用户无确认入口 | 永久挂起，只能 /loop stop |

### 2.3 闭环断裂点（按严重度）

- **S1（最重）"子代理完成 → 自动验收"不存在**：`notifyLoopJobTerminal` 只 writeRun+timeline（`loop-run.ts:1056-1093`），验收完全依赖父模型同回合内自觉调 `loop_verdict`；父回合已亡时 `maybeReapIdleLoopVerify` 走 **verify_skipped 强制结束**——保险丝是"停止"不是"续跑"。**修复**：`AGIM_LOOP_AUTO_VERIFY=on` 时 live=0+派工≥1+父回合亡 → 自动起 cheap 评估回合生成 verdict；met=false 按 nextDirection 自动派下一轮；默认保持强停。
- **S2 `pending_user_confirm` 无超时逃逸**：墙钟/轮次/reap 全部 defer（`loop-run.ts:1132-34,1168`；`loop-verify-gate.ts:49`），仅 Portal REST 可解；**IM-only 用户（微信/Telegram/Discord）没有 end/continue 入口**（`commands/loop.ts:151-163` 只对 aligning 有效）。**修复**：(a) `AGIM_LOOP_CONFIRM_TIMEOUT_MS` 超时自动结束/继续；(b) IM 增加 `/loop confirm end|continue`（把 `resolveLoopMetConfirm` 下沉 core 复用）。
- **S3 跨回合无自动续跑**：R6 暂缓；heartbeat 与 Loop 不互通（`loop-engineering.md:288`）。**修复**：同 S1 的自动续跑开关；或 heartbeat tick 检测"活跃 Loop 闲置 N 分钟 → 自动起父回合"。
- **S4 evaluator 否决即卡**：met=true 被否决时 loop_verdict 报错（`agim-dispatcher.ts:1404-1410`），模型需自行修缺口重试，无自动改判 continue 路径。**修复**：disagree 时允许自动降级 met=false+continue（evaluator reason 塞进 nextDirection），或提供 `force:true`。
- **S5 planning(0派工) 无 reap 兜底**：continue 后模型没派工就结束回合 → planning 无限等（人工续点）。

### 2.4 自闭环评分

**半闭环（5.5/10）——"回合内自闭环、回合间人工驱动、结案人工确认"**：

- ✅ **回合内**：派工（同步 join）→执行→验收→continue→下一轮全自动链式（`applyLoopVerdict` 单函数推进 + cap 重置 + 门禁强制先派工），一次用户消息可跑完多轮直到 met/maxRounds/wall。
- ❌ **回合间**：无定时/事件驱动续跑，一轮结束即等用户。
- ❌ **结案**：met=true 必须人工确认（设计刻意保留的 HITL，但无超时逃逸属断裂）。
- ❌ **中断兜底**：父回合死亡时子代理完成 → 强制结束而非自动验收。

### 2.5 亮点（自动衔接好的）

1. 同回合多轮链式推进四件套齐活（round+1/planning/cap 重置/派工门禁）。
2. 派工即等待：call_agent(s) 同步 join 子代理，join 后立即 `maybeEnforceLoopExit`，墙钟不依赖模型自觉。
3. 子代理完成 → UI 即时刷新（notifyLoopJobTerminal → WS loop-changed → Portal dock 实时重算 canVerify）。
4. 验收硬门禁 + 强制 follow-up：父回合结束缺 verdict 强制再推一 hop，再不行 verify_skipped 强停——不会无限挂"待验收"。
5. 旁路设计完整：/loop stop 取消在跑子代理、focus off 取消、wall 三处主动截断、pending ask 正确 defer。

---

## 3. 统一结论与建议路线

两个问题同源：**Loop 缺"无人值守/定时驱动"能力，R6（`loop-engineering.md:509` "Heartbeat/cron 只负责 start"）官方暂缓是根因**。

| 阶段 | 动作 | 对应 |
|---|---|---|
| **P0** | `wakeLoopForThread()` + schedule `loop:` 前缀分支 + `unattended` 标志（auto-end met=true） | 问题 1 方案 A + 无人值守必需改 |
| **P1** | `AGIM_LOOP_AUTO_VERIFY`（父回合亡后自动 cheap 验收续跑）| 问题 2 S1 |
| **P1** | `AGIM_LOOP_CONFIRM_TIMEOUT_MS` + IM `/loop confirm end\|continue` | 问题 2 S2 |
| **P2** | heartbeat 闲置检测自动续跑；evaluator 否决自动降级 continue | 问题 2 S3/S4 |
| **P2** | schedules `kind='loop'` 结构化存储 + Portal 展示（R6 完整版） | 方案 C |

**核心原则**：定时路径自带 objective+exit（跳过 ALIGNING 对焦，不违反 `:548`"禁止静默默认退出条件"——因为退出条件是调用方显式给的）；无人值守必须显式 opt-in（env 开关），默认保持 HITL。
