# Focus 设计（概念与架构）

> 状态：**现行设计（planning · 文档先行）** · 2026-07-24  
> 产品定位：**让 agent 时刻聚焦在某件事上**（软约束注入）。  
> **废弃**：[`../goals.md`](../goals.md) 所描述的 `/goal` 原语（见 §6）。  
> 关联：[`loop-engineering.md`](./loop-engineering.md)（Phase C · `/loop`）· [`../naming.md`](../naming.md)

---

## 0. 一句话

**Focus = 当前对话线程上的「注意力锚点」：开启时自动注入 system/wire 上下文，关闭时停止注入，内容可保留。**

它**不是**任务完成系统，**不是** Loop Engineering（L3 调度/验收），**不是** Heartbeat，**不是** L2 Agent Loop。

---

## 1. 用户意图（不可漂移）

用户要的是：

> 「接下来一段时间，你说话做事都围着 X。」

不是：

> 「创建一个带证据门闸的可验收工程任务。」（那是 `/loop` 的范畴）

因此 Focus **只做三件事**：

1. **定义**聚焦内容（title / body）  
2. **开启**自动注入  
3. **关闭**注入（可选：保留或清空内容）

---

## 2. 行为契约

### 2.1 每 thread 至多一条 Focus 记录

Scope：`platform + channelId + threadId`（与今日 goal 相同）。

### 2.2 开关与注入

| 状态 | 注入？ | 含义 |
|---|---|---|
| **on**（开启） | **是** | 每 turn wire-only 注入 Focus 块 |
| **off**（关闭） | 否 | 不注入；title/body **默认保留**，可再 `/focus on` |
| **cleared**（无记录 / 已 clear） | 否 | 无内容 |

推荐 slash（定稿进 `naming.md`）：

```
/focus                 show（或 help）
/focus help
/focus set <title…>    设置内容并默认开启（on）
/focus body <body…>    补充/替换正文
/focus show
/focus on              开启自动注入（需已有内容）
/focus off             关闭注入，保留内容
/focus clear           清除内容并关闭
```

别名可考虑：`/f`、`/聚焦`（实施时定）。

### 2.3 注入形态（草案）

Wire-only（不写进 session.messages 持久副本），例如：

```
[agim context — focus ON for this thread]
Title: …
Body: …
Focus is background context only. The user's current-turn ask always wins; …
```

**与目标巡检（goal-critic）**：有 Focus 时默认会启用巡检（`AGIM_NATIVE_CRITIC` 默认 `goal-only`），但巡检的**硬目标是本轮用户 prompt**，Focus 只作背景。用户这轮在干别的事（未开 `/loop`）时，**不得**因未推进 Focus 而硬停并拉回 Focus。闭环硬拉回属于 Loop。

边界：title/body 截断策略可复用今日 goal 的预算（body store cap / snippet cap），实施时从 `goals.ts` 迁出或共用 helper。

### 2.4 工具面（草案）

| 工具（建议名） | 作用 |
|---|---|
| `mcp__agim__focus_set` | 设置并默认 on |
| `mcp__agim__focus_on` / `focus_off` | 开关 |
| `mcp__agim__focus_clear` | 清除 |

旧名 `mcp__agim__long_task` 已退役；使用 `mcp__agim__focus_set`。

---

## 3. 非目标

- 完成门闸 / evidence / epoch（不放在 Focus）  
- 拆解 / 派子代理 / 对照目标验收（那是 `/loop` · L3）  

- 墙钟提醒（Heartbeat）  
- 多条并行 Focus（首期一 thread 一条）

---

## 4. 与 Loop 的关系

```text
Focus (on)  ──门禁──►  /loop start   （Phase C）
   │                      │
   │ 每 turn 注入正文      │ 另注入 Loop 状态（plan / 验收…）
   ▼                      ▼
 agent 聚焦         拆解→子代理→验收→（未达）再来
```

**「Loop 绑 Focus」= 生命周期门禁，不是两套聚焦正文抢优先级。**  
Loop 本体定义见 [`loop-engineering.md`](./loop-engineering.md)（L3，不是 L2 Agent Loop）。

| 问题 | 答案 |
|------|------|
| Focus 正文以谁为准？ | **永远只有 thread 上那一条 Focus**（SSOT）。Loop **不**另存一份可覆盖的「聚焦文案」。 |
| Loop 跑着时还注 Focus 吗？ | **要。** Focus on → 照常注 Focus 块。 |
| 还注什么？ | **再注** Loop 运行态（round、计划、验收摘要等）——互补，不是二选一。 |
| `focusSnapshot`？ | 仅启动时审计/展示用；运行中用户改 Focus → **下一轮以当前 Focus 为准**。 |

### 4.1 开 Loop 的两种 UX（拍板）

| 路径 | 用户怎么做 | Loop 结束时 Focus |
|------|------------|-------------------|
| **A · 分步** | 先 `/focus …`（已 on），再 `/loop` 或 `/loop start <note>` | **保持**：不自动 off。Focus→Mission **正文**（标注）；裸 `<note>` **预填**对焦「目标」，退出条件仍须确认。细节 [`loop-engineering.md`](./loop-engineering.md) §3 |
| **B · 直开** | Focus 未 on 时直接 `/loop <text>` | **自动** `focus set+on` 用 `<text>`；结束时 **focus off**（内容可保留，仅停注入） |

要点：

- 不必每次都先 focus 再 loop；直开会代开 Focus。  
- **谁开的谁收**：仅当本次 Loop **代开/代打开**了 Focus（`openedFocus`）时，结束才 off；用户事先设好的 Focus 不被 Loop 收走。  
- Focus **clear/off**（用户主动）时：活跃 Loop **cancel**（无孤儿）——见 [`loop-engineering.md`](./loop-engineering.md)。

---

## 5. 存储（草案）

新建或迁移自 `goals.db`：

- 表名建议：`focus` / `thread_focus`  
- 字段：`thread` 键、`title`、`body`、`enabled`（on/off）、时间戳  
- **不**再使用「completed/cancelled」任务终态语义；Focus 只有 on/off/cleared  

实施可：

1. 新库 `focus.db`，迁移 active goal → focus on；或  
2. 原地改表 + 兼容读旧 `goals` 行  

细节在实现 PR，不阻塞本概念文。

---

## 6. 废弃 Goal

| 旧面 | 处置 |
|---|---|
| `/goal`、`/g`、`/目标` | 已退役；使用 `/focus` |
| `mcp__agim__long_task` | 已退役；使用 `mcp__agim__focus_set` |
| `mcp__agim__complete_goal` | 已退役；用 Loop / `loop_verdict` 做闭环 |
| `docs/goals.md` | 顶部加废弃声明，指向本文 |
| goal-critic 名字 | 可暂留代码名；产品文案为 on-track critic；**不得**把 Focus 当硬任务门闸 |

兼容期已结束；Focus/Loop 是现行产品面。

---

## 7. 验收（Focus 落地时）

- [ ] `/focus set` 后下一 turn 可见注入  
- [ ] `/focus off` 后不再注入，再 `/focus on` 恢复同一内容  
- [ ] `/focus clear` 后无注入、无残留内容  
- [ ] `/goal` 兼容路径有明确废弃提示或等价转发  
- [ ] 文档与 naming 不再把 Focus 写成「可验收任务」

---

## 8. TL;DR

> **Focus = 开/关注入的注意力锚点。**  
> **Goal 废弃。**  
> **Loop：可先 focus 再 loop（结束保留 focus），或 `/loop <text>` 代开（结束 focus off）。**

---

## 9. 修订记录

| 日期 | 变更 |
|---|---|
| 2026-07-24 | 初稿：Focus 契约；与 Loop 边界；废弃 Goal |
