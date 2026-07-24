# Focus 设计（概念与架构）

> 状态：**现行设计（planning · 文档先行）** · 2026-07-24  
> 产品定位：**让 agent 时刻聚焦在某件事上**（软约束注入）。  
> **废弃**：[`../goals.md`](../goals.md) 所描述的 `/goal` 原语（见 §6）。  
> 关联：[`loop-engineering.md`](./loop-engineering.md)（Phase C · `/loop`）· [`../naming.md`](../naming.md)

---

## 0. 一句话

**Focus = 当前对话线程上的「注意力锚点」：开启时自动注入 system/wire 上下文，关闭时停止注入，内容可保留。**

它**不是**任务完成系统，**不是** Loop-engineering，**不是** Heartbeat。

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
Stay on this focus unless the user explicitly changes topic or turns focus off.
```

边界：title/body 截断策略可复用今日 goal 的预算（body store cap / snippet cap），实施时从 `goals.ts` 迁出或共用 helper。

### 2.4 工具面（草案）

| 工具（建议名） | 作用 |
|---|---|
| `mcp__agim__focus_set` | 设置并默认 on |
| `mcp__agim__focus_on` / `focus_off` | 开关 |
| `mcp__agim__focus_clear` | 清除 |

旧名 `mcp__agim__long_task` → **废弃**，兼容期内转发到 `focus_set`（见 §6）。

---

## 3. 非目标

- 完成门闸 / evidence / epoch（不放在 Focus）  
- 观察者闭环（那是 `/loop`）  
- 墙钟提醒（Heartbeat）  
- 多条并行 Focus（首期一 thread 一条）

---

## 4. 与 Loop 的关系

```text
Focus (on)  ──可选──►  /loop start   （Phase C）
   │                      │
   │ 每 turn 注入         │ 检查点观察者
   ▼                      ▼
 agent 聚焦            continue|revise|stop
```

- `/loop` **要求**当前 thread Focus 为 **on** 且有内容。  
- Focus **off** 时拒绝 start loop（或强制先 focus on——产品倾向：**拒绝**）。  
- Loop **结束**不自动 `focus off`（聚焦可继续）。  
- Focus **clear/off** 时：活跃 Loop 必须 cancel（无孤儿），规则写在 [`loop-engineering.md`](./loop-engineering.md)。

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
| `/goal`、`/g`、`/目标` | 废弃；兼容期提示改用 `/focus`，或静默转发 |
| `mcp__agim__long_task` | 废弃 → `focus_set` |
| `mcp__agim__complete_goal` | **废弃**（完成语义不归 Focus；若 Loop 需要「收尾」，另定 `/loop complete`，不复活 goal） |
| `docs/goals.md` | 顶部加废弃声明，指向本文 |
| goal-critic 名字 | 可暂留代码名；产品文案改为「focus-critic / on-track critic」，避免再强化 goal |

兼容期长度：实现 PR 定（建议 ≥1 个次要版本 + CHANGELOG 大声通知）。

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
> **Loop（Phase C）建在 Focus 之上，不抢 Focus 的定位。**

---

## 9. 修订记录

| 日期 | 变更 |
|---|---|
| 2026-07-24 | 初稿：Focus 契约；与 Loop 边界；废弃 Goal |
