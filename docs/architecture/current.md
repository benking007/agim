# im-hub 架构总览（v0.2.15 + v2 升级）

> 基线 commit：`18f96fb`（CR 修复批后） + 2026-05-02 v2 升级（A/D/B 已落地，C 自然就位）
> 配套文档：[`development.md`](../development.md) · [`extending.md`](../extending.md) · [`deployment.md`](../deployment.md)
> v2 详细：[`im-gateway-v2-plan.md`](../im-gateway-v2-plan.md) · [`agent-cwd-and-memory.md`](./agent-cwd-and-memory.md) · [ADR 0004](../adr/0004-sticky-agent-and-split-ttl.md) · [ADR 0005](../adr/0005-agent-cwd-isolation.md)

---

## 一、系统形态

im-hub 是一个**进程内多面体网关**：单个 Node.js 进程同时扮演 IM 接入端、Agent 调用方、HTTP/REST/SSE/WebSocket 服务端、定时调度器和审计存储。所有组件共享同一个 `~/.im-hub/` 数据目录与同一棵 pino logger 树。

```
                         ┌─── 外部触发 ───┐
                         │ cron 30s tick │
                         │ webhook → /api/notify
                         │ REST → /api/invoke
                         │ ACP /tasks (sync/SSE)
                         └────────┬───────┘
  ┌─ IM 入口 ─────────────────────┼─────────────────────────┐
  │ WeChat iLink (1s long-poll + 60s heartbeat)             │
  │ Telegram (grammy long-poll)                              │
  │ Feishu (Lark SDK WebSocket)                              │
  │ Web Chat (browser WS, /tasks /settings 同源)             │
  └────────────────────────────────┬─────────────────────────┘
                                   │ MessageContext
                                   ▼
              ┌── Pre-route gates ─────────────────┐
              │ workspace.resolve(userId)          │
              │ rateLimiter.allow(userKey)         │
              │ traceId 生成 + pino child logger    │
              └────────────────┬───────────────────┘
                               ▼
              ┌── parseMessage + Intent ───────────┐
              │ /<cmd>          → builtin 子命令   │
              │ /<agent>        → explicit 切换    │
              │ default         → classifyIntent   │
              │   ├ topic regex (CJK + ASCII)      │
              │   ├ keyword profile               │
              │   ├ sticky session bias           │
              │   └ LLM judge (opt-in 兜底)        │
              └────────────────┬───────────────────┘
                               ▼
              ┌── Agent invocation ────────────────┐
              │ workspace whitelist + circuit       │
              │ breaker + isAvailable cache        │
              │ AgentBase.sendPrompt → spawnStream │
              │  (LineBuffer · 真流式 · abort/timeout)
              └────────────────┬───────────────────┘
                ┌──────┬───────┼────────┬─────────┐
                ▼      ▼       ▼        ▼         ▼
            opencode claude  codex   copilot  ACP remote
                       │             │
                       ▼             ▼
                 ┌─ Job Board ─┐    持久化任务（SQLite）
                 │ schedules → cron 自动 runJob
                 └─────────────┘
                       │
                       ▼
   ┌─ Cross-cutting ───────────────────────────────────┐
   │ audit-log (SQLite, 30 天保留)                     │
   │ metrics  (Prom text via /api/metrics)             │
   │ session  (~/.im-hub/sessions/, JSONL append)      │
   │ pino     (traceId 全链路, JSON in production)     │
   └───────────────────────────────────────────────────┘
```

整个进程**单实例**：没有外部 Redis/MQ 依赖。SQLite 三件套（`audit.db` / `jobs.db` / `schedules.db`）+ session 文件树就是全部的持久化。

---

## 二、v2 升级形态（2026-05-02 落地）

针对"Agent 漂移、记忆丢失、工作目录共用、会话保持时间过短"四个痛点，做了以下结构调整：

### 2.1 路由层 · sticky-agent 绝对锁（Phase A）

```
Pre-route gates ──► parseMessage ──► classifyIntent
                                         │
                                ┌────────┴────────┐
                                │  stickyAgent ?  │
                                └────────┬────────┘
                                  yes ──►│ early return（不评分）
                                   no ──►│ topic regex + keyword + LLM judge
```

**关键变化**：`stickyAgent` 在可用列表里时，`classifyIntent` 直接返回，不进入评分流程。
opencode 权重也从 `1.2` 降到 `1.0`，与 claude-code 持平。**没有显式 `/cc` `/oc`，
agent 不会变。**

### 2.2 会话层 · 双层 TTL（Phase D）

```
session ─┬─ messages[]              （短 TTL：30 min，env: IMHUB_SESSION_MESSAGES_TTL_MS）
         │   └─ <key>.log
         └─ meta（agent, model, claudeSessionId, usage, subtasks）
             （长 TTL：7 d，env: IMHUB_SESSION_META_TTL_MS）
             └─ <key>.json
```

cleanup 定时器每 5 min 跑一次，分两步：
- messages 过期 → 仅清空 in-memory `messages[]` + 删 `.log` 文件
- meta 过期 → 完整删除 session（含 `.json`）

**对 Claude Code 的关键收益**：`claudeSessionId` 7d 内不丢，下次回来 `claude --resume <uuid>`
能续上 `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl` 的完整历史。

### 2.3 Agent 调用层 · per-Agent cwd（Phase B）

```
                   AgentBase.spawnStream
                          │
                  ┌───────┴────────┐
                  │ resolveAgentCwd(agent, opts)
                  │   • IMHUB_<AGENT>_CWD env → use it
                  │   • opts.threadId+platform → ~/.im-hub-workspaces/<agent>/
                  │   • else → undefined（继承 im-hub `/`）
                  └───────┬────────┘
                          ▼
                crossSpawn(cmd, args, { cwd, env })
```

cwd 注入只发生在 IM 上下文（threadId + platform 都有值）。Web/scheduler/intent-llm
判定一律 `undefined`，不影响既有行为。

启动时 `cli.ts` 调 `bootstrapAgentWorkspaces()` 幂等创建：

```
~/.im-hub-workspaces/
├── claude-code/
│   ├── CLAUDE.md          # IM 入口的 Claude 角色定义（首次启动种子，后续不覆盖）
│   └── memory/            # Claude auto-memory 自动落入
└── opencode/
    ├── AGENTS.md          # IM 入口的 opencode 角色定义
    └── memory/
```

### 2.4 长期项目记忆（Phase C，自然就位）

不引入新存储层，直接复用 Claude / opencode 已有的 per-project 记忆机制。Phase B 落
地后：

| Agent | 自动加载 | auto-memory 入口 | jsonl 历史 |
|---|---|---|---|
| Claude Code | `~/.im-hub-workspaces/claude-code/CLAUDE.md` | `<cwd>/memory/MEMORY.md` | `~/.claude/projects/-root-im-hub-workspaces-claude-code/<uuid>.jsonl` |
| opencode | `~/.im-hub-workspaces/opencode/AGENTS.md` | 用户手写到 `PROJECT.md` 后由 AGENTS.md 引用 | （opencode 不持久 session） |

具体使用见 [`docs/im-workspaces-guide.md`](../im-workspaces-guide.md)。

### 2.5 形态对比

| 维度 | v0.2.13 基线 | v0.2.15 + v2 |
|---|---|---|
| Agent 决策 | 每条消息跑 `classifyIntent`（含 sticky 偏置） | 有 sticky 直接返回，无 sticky 才分类 |
| opencode/claude-code 权重 | 1.2 vs 1.0（不平衡） | 1.0 vs 1.0 |
| Session TTL | 单层 30 min | 双层（messages 30 min + meta 7 d） |
| `claudeSessionId` 寿命 | 30 min | 7 d |
| Agent 子进程 cwd | im-hub 进程的 `/`（systemd） | IM 调用 → `~/.im-hub-workspaces/<agent>`；其他入口仍 `/` |
| Agent 全局配置 | 全局共享（直连终端 + IM 互相污染） | IM 入口隔离（`~/.im-hub-workspaces/<agent>/{CLAUDE,AGENTS}.md`） |
| 长期项目记忆 | 无 | 沿用 Claude/opencode 原生 per-cwd 记忆，自然就位 |

---

## 三、关键文件索引

| 关注点 | 路径 |
|---|---|
| 路由分类 | `src/core/intent.ts` |
| 会话管理 | `src/core/session.ts` |
| cwd 解析 + 工作区 bootstrap | `src/core/agent-cwd.ts` |
| Agent 抽象 / spawn 流式 | `src/core/agent-base.ts` |
| Claude adapter | `src/plugins/agents/claude-code/index.ts` |
| opencode adapter | `src/plugins/agents/opencode/index.ts` |
| 主流程入口 | `src/cli.ts` |
| systemd unit（生产） | `/etc/systemd/system/agim.service` |

---

## 四、v1.x 演化（后续增量）

v0.2.x 的进程内多面体网关形态没变，但 1.0 后加了几条横切层。简要图示：

```
                              ┌────────────────────────────────────┐
                              │  Approval Bus (Unix socket)        │
                              │  approval / reminder / memo /      │
                              │  push / memory / a2a 全部走它       │
                              └──┬───────────────────────┬─────────┘
                                 │                       │
                  ┌──── MCP sidecars ────┐    ┌── Web /api/notify ──┐
                  │ claude-code / opencode│    │ HTTP 入口 push       │
                  │  daemon → tools       │    └──────────────────────┘
                  └──────────────────────┘
```

### 4.1 Approval Bus（v0.2.x 起 → v1.0 收口）

`src/core/approval-bus.ts` 是 MCP 工具 ↔ agim 主进程的统一通道，line-delimited JSON over Unix socket。
runId → RunContext 解析负责把 LLM 调起的工具绑定回真实的 IM 用户：

| 消息类型 | runId 路径 | `_im_context` fallback |
|---|---|---|
| approval | 必须 | 不支持 |
| reminder | 优先 | ✅ 支持（单用户 MCP 用） |
| memo | 优先 | ✅ 支持 |
| **memory** | **必须** | **不支持（v1.2.0 关闭，防共享 daemon 跨用户伪造）** |
| **push** | **必须** | **不支持（同上）** |
| a2a | 必须 | 不支持 |

### 4.2 长期记忆子系统（v1.2.0+）

```
~/.agim/memory.db
├── persona_profile (user_key TEXT PK, summary TEXT, updated_at)
└── facts (id, user_key, what, who, when_text, where_label, why,
            category, confidence, source, created_at,
            embedding BLOB, embedding_model, embedding_dims, embedded_at)
    + facts_fts (FTS5 virtual, unicode61 tokenizer + 手动 CJK 单字分词)
```

数据流：

```
agent reply → router → scheduleDistillation()  ─┐
                                                 ▼
                            memory-distill (LLM JSON 抽取)
                                                 │
                                                 ▼
                            memory.saveFact() ┌──┴───────────────┐
                                              │ INSERT facts +   │
                                              │ INSERT facts_fts │
                                              │ (transaction)    │
                                              └───┬──────────────┘
                                                  │ setImmediate
                                                  ▼
                                        embedAndStoreFact()
                                              │
                                              ▼  (lazy / autowarm)
                                  memory-vector.getActiveBackend()
                                              │
                                ┌─────────────┼──────────────┐
                                ▼             ▼              ▼
                          OffBackend    LocalBgeBackend  OpenAIBackend
                                        (Xenova/BGE-zh    (/v1/embeddings,
                                        ONNX, lazy load)   30s timeout)
```

检索：`router.ts` 注入 `[long-term memory]` 块到 prompt → `persona.ts` 拼装；Agent 主动用 `mcp__imhub__memory_query` 走 `queryFactsHybrid()`（FTS5 + 向量 RRF 融合）。

每日 `memory-consolidate` cron（24h；可手动触发 `POST /api/memory/consolidate`）：把最近 N 条 facts 喂 LLM 合并成 ≤600 字符的 persona summary。

### 4.3 Crash-safe delivery 全套（v1.1+）

```
agent reply ──► message-sink ──► SQLite outbox ──► outbox-worker (指数退避)
                                                    │
                                                    ▼
                                              messenger.send()
                                                  ↓ 失败
                                              retry / abandon
```

inline-job 跟踪每条入站消息：`pending → running → completed → delivered`。重启时 `job-recovery.scanInterruptedAndNotify()` 找回 10min 内被中断的 row，对每个 thread 发原生按钮卡（Telegram / 飞书）或文字提示。

### 4.4 Web 控制台 v1.1.10 鉴权

- 默认 token 鉴权（cookie `agim_token` + `Authorization: Bearer` + 127.0.0.1 旁路）
- 公开路径：`/v/:id` viewer / `/loc` 定位捕获 / `/l/<token>` 短链 / `/api/health`
- `agim token create / list / revoke` 管理
- v1.2.0 SECRET_KEYS 加入 `IMHUB_MEMORY_VECTOR_OPENAI_API_KEY`（mask 返回 + 写入时检测掩码值跳过）

### 4.5 Admin 白名单（v1.0+，v1.2.2 加 invite）

- `IMHUB_ADMIN_USERS=platform:userId,...`（首字段大小写无关）
- 首次部署：`~/.agim/admin-bootstrap-token` 单次消费，IM 发 `/setup admin <token>` 自助
- v1.2.2：现有管理员可用 `agim admin invite` / 交互菜单生成新一次性 token 拉人入伙
- 守卫范围：`/restart` / `/stop` IM 命令 + `POST /api/service/*` Web 端点
