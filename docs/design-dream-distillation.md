# 设计：梦境蒸馏（Dream Distillation）+ 可配置蒸馏 LLM

状态：草案 v1（待评审）· 关联：长期记忆子系统（`src/core/memory*.ts`、`src/core/persona.ts`）

## 1. 背景

agim 的长期记忆分两层：

- **冷层 = 原始事实**（`facts` 表，FTS5 关键词索引）——由对话**自动蒸馏**写入，按需 `memory_query` 取回。
- **热层 = persona 摘要**（≤300 字，always-injected）——`memory-consolidate` 周期（默认 24h）把事实卷成摘要。

当前**蒸馏触发是 per-turn 的**：每条非琐碎回复后 `router.ts` 调 `scheduleDistillation()` → `memory-distill.runDistillation()`，优先 `llmRoles.cheap` 直连，否则**回退 spawn 当轮 agent**。这带来两个问题：

1. **成本**：每条回复都跑一次抽取；没配 `cheap` 角色时，每条回复多 spawn 一次完整 CLI agent（claude-code/codex）——慢且贵。这是"默认开"的最大障碍。
2. **质量**：逐轮孤立抽取，无法跨轮去重 / 消解矛盾 / 判断"整段会话里什么值得长期记"。

> 前置依赖：召回链路（`memory_query`）此前因 `t.user_key` 过滤 contentless FTS 列而恒返回 0，已在 PR #107 修复。本设计建立在"冷层可取回"之上。

## 2. 目标

把**事实抽取**从热路径（每条回复）移到**空闲时的后台批量 pass**（"做梦时蒸馏"）：

- 回复路径零 LLM 成本（只缓冲）。
- N 轮对话 ≈ 1 次抽取调用（批量、更便宜、更高质量）。
- 蒸馏所用 LLM **可配置**，给运营者两种来源方式。
- 让"默认开记忆"在成本上变得可接受（后续阶段）。

## 3. 已定决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | 召回延迟 | 安静时 ≤ tick 间隔；忙碌时 ≤ 陈旧度下限（见 §5 建议值） |
| 2 | 蒸馏角色 | **新建 `distill` 角色**（不复用 `cheap`） |
| 3 | LLM 来源 | 零配 = **当前/代表 agent**；配置时 **方案 A / 方案 B 二选一** |
| 4 | 调度 | **独立调度**：distiller 自成一套，consolidator 仍 24h，两者解耦 |

## 4. 架构

### 4.1 热路径：只缓冲，不调 LLM

`router.ts` 回复后的 `scheduleDistillation(...)` → `enqueuePendingTurn(...)`，往新表追加一行。回复路径成本 = 一次 SQLite insert，崩溃安全。

```sql
CREATE TABLE IF NOT EXISTS pending_distill (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key      TEXT    NOT NULL,
  platform      TEXT    NOT NULL,
  user_message  TEXT    NOT NULL,
  agent_reply   TEXT    NOT NULL,
  agent_name    TEXT    NOT NULL,   -- 用于零配模式选"代表 agent"
  trace_id      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_distill_user ON pending_distill(user_key, created_at);
```

### 4.2 distiller：独立后台调度（决策 4）

新增 `startMemoryDistiller()`，与 `startMemoryConsolidator()` 完全解耦。每 tick：

1. **门槛**：`job-board._activeJobCount() === 0`（空闲）**或** 某用户最老 pending 超过陈旧度下限（强制 flush，保证忙碌 bot 也按时学）。
2. 对每个达标用户：取其 pending（按 `BATCH_MAX` 分块）→ 合并成一个抽取 prompt → 蒸馏 LLM（见 §4.4）→ 解析 → 复用 `findFactIdByWhat` 去重 → `saveFact` → 删除已处理行。
3. **不**触发巩固：consolidator 仍按自己 24h 节奏把新事实卷成摘要（解耦）。可选未来增强：distiller 写完给用户打 `dirty` 标记，让 consolidator 优先处理（不耦合调度，P2+）。

> 代价：新事实进入"常驻摘要"最坏滞后一个 consolidate 周期（默认 24h），但**立刻可被 `memory_query` 取到**。

### 4.3 批量抽取

复用 `memory-distill.ts` 现有的抽取 prompt / `tryParseFactsJson` / 归一化 / 去重逻辑，输入从"单轮"改为"多轮拼接"。Prompt 里逐轮标注，要求跨轮去重并解决矛盾。超过 `BATCH_MAX` 轮的分块多次调用。

### 4.4 蒸馏 LLM 来源解析（决策 2、3）

单一设置 `memory.distillSource ∈ { auto, agent, llm }`，互斥：

| 值 | 含义 | 解析为 |
|---|---|---|
| `auto`（默认/零配） | 用这一批的**代表 agent** | 批内**最新一轮的 `agent_name`**，回退 `config.defaultAgent` 的 `sendPrompt` |
| `agent`（方案 A） | 用户选定的已启用 agent | `memory.distillAgent` 指定 agent 的 `sendPrompt` |
| `llm`（方案 B） | 专用 LLM 直连 | `tryIntrospect({ role: 'distill' })` |

新建 `distill` 角色（`registry.ts` 的 `LlmRole` 增加 `'distill'`）。解析失败（如 `llm` 模式但 `distill` 未映射）→ 记一条 warn、**跳过本轮批量抽取**（记忆仍可手动 `memory_save` + 按需 `memory_query` + 已有摘要）。

## 5. 调度建议值（决策 1）

| 旋钮（env） | 建议默认 | 说明 |
|---|---|---|
| `AGIM_MEMORY_DISTILL_INTERVAL_MS` | `300000`（5 分钟） | distiller tick 间隔；安静 bot 实际延迟 ≤5 min |
| `AGIM_MEMORY_DISTILL_FLOOR_MIN` | `30` | 最老 pending 超 30 min 强制 flush（忙碌 bot 兜底） |
| `AGIM_MEMORY_DISTILL_BATCH_MAX` | `20` | 单次抽取最多 20 轮；超出分块 |
| `AGIM_MEMORY_DISTILL_MAX_PENDING` | `200` | 每用户 pending 上限（背压）；超了合并/丢最旧 |

口径：**安静时 ≤5 分钟、最坏（持续忙）≤30 分钟**内学到新事实。可选增强（P1.5）：监听 `activeJobs → 0` 跳变即时 flush，比轮询更跟手。

## 6. 配置面（Memory Tab 新增"蒸馏"子标签）

UI 模板用 `src/web-app/src/routes/memory/vector-backend-form.tsx`。**方案 B 复用现成的 `/api/llm/*` + `settings/llm.tsx`，不重造 LLM 配置 UI。**

- **来源**：◉ 自动（当前 agent）／○ 指定 Agent ▾（列 `settings/agents.tsx` 的已启用项 → 写 `memory.distillSource=agent` + `memory.distillAgent`）／○ 指定 LLM 后端 ▾（列 `GET /api/llm` → 选中即 `PUT /api/llm/roles {distill:<backend>}` + 写 `memory.distillSource=llm`；旁链 Settings→LLM 管密钥）
- **调度**：间隔 / 强制下限 / `[ ] 仅空闲` → `PUT /api/env`
- **手动**：`[立即蒸馏]` 按钮（新增 `POST /api/memory/distill`）+ 上次运行状态（`/api/memory/distill/status`），仿 `persona.tsx` 的 consolidate trigger/status。

存储：调度旋钮走 env（`PUT /api/env` + `ENV_EDITABLE_KEYS` 白名单）；方案 B 的 backend/role 走结构化 `/api/llm/*`（共享 registry + secrets）。

## 7. 分期

- **P1（后端，本设计核心）**：`pending_distill` 表 + `enqueuePendingTurn` + 热路径改 buffer + `startMemoryDistiller`（空闲 + 下限）+ 批量抽取 + `distill` 角色解析链。**附 node 回归测试**（沿用 #107 的 `npm run test:node` 模式，bun 测不了 SQLite）。
- **P2（配置面）**：Memory Tab"蒸馏"子标签 + `/api/memory/distill[/status]` + 复用 `/api/llm`。
- **P3（默认开）**：成本被 P1 压平后，把 `AGIM_MEMORY_ENABLED` 默认翻开（opt-out）。

## 8. 测试

- **node 回归**（`test/node/memory-distill.mjs`，在 node 下跑真实 SQLite）：
  - `enqueuePendingTurn` 落库；
  - distiller 批量处理 N 轮 → 写出去重后的 facts → 清空 pending；
  - 空闲门槛 + 陈旧度下限两条路径；
  - 三种来源解析（auto/agent/llm，用桩 agent / 桩 provider）。
- bun 单测覆盖纯函数（prompt 拼接、解析、来源解析的分支）。

## 9. 风险与取舍

| 风险 | 缓解 |
|---|---|
| 召回延迟（事实要等下次 pass） | 陈旧度下限压到分钟级；当前会话上下文本就含该信息 |
| 进程在"做梦前"挂掉丢未蒸馏轮次 | `pending_distill` 落库（参照 outbox 持久化范式） |
| 忙碌 bot 永不空闲 | 陈旧度下限强制 flush |
| 批量 token 超限 | `BATCH_MAX` 分块 |
| pending 涨太快 | `MAX_PENDING` 上限 + 合并/丢最旧 |

## 10. 参考（代码锚点）

- 热路径触发：`src/core/router.ts`（`scheduleDistillation` 调用处）
- 蒸馏：`src/core/memory-distill.ts`（`runDistillation` / `buildExtractionPrompt` / `tryParseFactsJson`）
- 角色/registry：`src/core/llm/registry.ts`（`LlmRole`、`getProvider`）、`src/core/llm/introspection.ts`（`tryIntrospect` / `tryIntrospectChain`）
- 巩固（独立、保持 24h）：`src/core/memory-consolidate.ts`（`startMemoryConsolidator`）
- 空闲信号：`src/core/job-board.ts`（`_activeJobCount`）
- 配置面范式：`src/web-app/src/routes/memory/vector-backend-form.tsx`、`src/web-app/src/routes/settings/llm.tsx`、`src/web/server.ts`（`/api/llm/*`、`/api/memory/consolidate*`、`/api/env`）
