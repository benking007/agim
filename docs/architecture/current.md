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

---

## 五、v1.3.0 增量 · 原生 LLM 栈 + 长目标/心跳/选择题/技能

v1.3.0 在 v0.2.x 的"进程内多面体网关"上再叠了一层 **`native` AgentAdapter** 与一组横切原语。完整设计立场见 [`../architecture-bridge-and-native.md`](../architecture-bridge-and-native.md)；PR 落地顺序与端到端能力矩阵见 [`../nanobot-comparison-rollout.md`](../nanobot-comparison-rollout.md)。

### 5.1 Native AgentAdapter（in-process LLM loop）

```
                                ┌──────────────────────────────┐
                  router ──►   │ AgentRegistry                │
                                │   • claude-code  [cli]       │
                                │   • codex        [cli]       │
                                │   • opencode     [cli]       │
                                │   • antigravity  [cli]       │
                                │   • native       [in-process]│  ◄── 新
                                │   • <acp:*>      [remote]    │
                                └────────────┬─────────────────┘
                                             │ AgentAdapter.sendPrompt
                                             ▼
                ┌─ 'native' adapter ────────────────────────────────┐
                │ src/plugins/agents/native/ + src/core/llm/        │
                │                                                    │
                │   ChatHistory + ChatOptions ─► agent-loop          │
                │                                    │ (≤N 轮)       │
                │            ┌───────────────────────┼──────────┐   │
                │            ▼                       ▼          ▼   │
                │     provider chat()         builtin-dispatcher  approval gate
                │   openai-compat /           (skill_read /        (policy:        │
                │   anthropic / ollama       memory_query /        allow-list/    │
                │                              push_message …)     deny-list/    │
                │                                                    autoAllow)   │
                │                                    │                            │
                │                                    ▼                            │
                │                          mcp-client.callTool                    │
                │                          (外挂 MCP server)                       │
                └────────────────────────────────────────────────────────────────┘
```

关键点：

- **`AgentAdapter.kind` 是 UI tag，不是分支**：router / approval-bus / A2A / audit / `/router compare` / fallback 链 **全部不写** `if (kind === ...)`。Anti-pattern 在 `architecture-bridge-and-native.md` § 7。
- **provider** 实现在 `src/core/llm/{openai-compat-provider,anthropic-provider}.ts`，统一 `chat({ messages, tools? }) → { text, toolCalls?, usage }`。
- **`agent-loop.ts`** 多轮：assistant 文本 / 工具调用 → dispatcher 执行 → 工具结果回灌 → 下一轮，直到模型不再 call tool 或触发 `IMHUB_NATIVE_MAX_TURNS`。DeepSeek 的 `reasoning_content` 在工具调用轮原样回灌（防 `ctx loss`）。
- **dispatcher 两路**：builtin（`skill_read` / `memory_query` / `push_message` / `ask_user` / `call_agent` …，与 CLI sidecar 同名空间）+ MCP 外挂（`mcp_<server>_<tool>`，连接靠 `mcp-client.ts`，注册靠 `mcp-registry.ts` + `~/.agim/mcp-config.json`）。
- **approval gate** 在每次工具调用前过 `policy-approval-gate.ts`，落 audit。模式：`allow-list` / `deny-list` / `always-allow` / `always-deny`；`autoAllow=N` 给某些工具前 N 次免审。
- **boot wiring**：`cli.ts` 在 `loadBuiltInPlugins()` 之后调 `loadLlmFromConfig(config)` + `loadMcpFromConfig(config)` + `mcpRegistry.connectAll()`，并打印 `describeNativeAgent()`。所以 `native.isAvailable()` 在配置有 backend 时**首次启动**就为 true。

### 5.2 LLM 配置三件套

```
~/.agim/config.json
├── llmBackends: BackendDef[]      // openai-compat / anthropic provider 配置
└── llmRoles: { [role]: backendName }
                                   //   cheap        → 路由器 / memory-distill / intent-llm
                                   //   evaluator    → 通知评估门 / heartbeat DECIDE
                                   //   native-chat  → /na 用户路径
~/.agim/llm-secrets.json (0o600)
└── 仅按 backend.name 存 apiKey
```

`/settings/llm`（Web）和 `agim setup llm`（CLI）是对等的 CRUD 入口；`agim diag llm` 等价于点 Ping。`tryIntrospectChain(roles[], prompt)` 助手按角色顺序尝试每个 backend，第一个成功即返回——这就是 v1.3 之前 `memory-distill` / `memory-consolidate` / `intent-llm` 的 CLI fallback 的"native 优先 → CLI 兜底"演化形态。

### 5.3 三大新原语（与 AgentAdapter 解耦）

| 原语 | 入口 | 注入路径 | 存储 | 横切层 |
|---|---|---|---|---|
| `/goal` | 命令 + MCP | `router.ts` → prompt 头部 `[goal]` 块 | `~/.agim/goals.db`（每 thread 至多一个 active） | `/tasks/goals` + `/api/goals` |
| `/heartbeat` | 命令 + scheduler | tick → 同步 `MessageContext` 走 router → DECIDE/EXECUTE/EVALUATE | `~/.agim/heartbeat.db`（thread bindings） | `/tasks/heartbeat` + `/api/heartbeat/bindings` |
| `mcp__imhub__ask_user` | 仅 MCP | 通过 outbox 发 IM 卡 → `ask-user-router` 等回包 → 解 RPC | 内存 + audit（一次性等待，timeout 失效） | `/tasks/asks` + `/api/asks/pending` |

三者都不知道**也不该知道**对端是 CLI agent 还是 native——一切走 `AgentAdapter.sendPrompt`。

### 5.4 Skills 引擎（agim-owned）

```
扫描两路（5 min 缓存，/skill refresh 强制重建）：
   ~/.agim/skills/<name>/SKILL.md          ← operator 优先
   <agim-dist>/skills/builtin/<name>/SKILL.md  ← 内置兜底

三层渐进披露：
   tier 1 — name + description           每轮自动进 system prompt
   tier 2 — SKILL.md body                按需 mcp__imhub__read_skill('name')
   tier 3 — scripts/ references/ assets/  由 body 引用 → agent 普通 file-read
```

Web 编辑器在 `/settings/agim-skills`；`/skill list|show|refresh` 在 IM 也能用。CLI agent 与 native 通过 builtin-dispatcher 的 `read_skill` 工具透明访问。

### 5.5 通知评估门（push / heartbeat → IM）

`mcp__imhub__push_message` 与 `POST /api/notify`（包括 heartbeat EVALUATE 阶段的产物）在写出之前过 `notification-evaluator.ts`：把"建议内容 + thread 最近 N 条上下文 + 用户偏好"喂 `llmRoles.evaluator` 让 LLM 给一个 `deliver|skip|reword` 决定；命中 `skip` 直接落 audit 不打扰用户。

### 5.6 `/router compare` A/B

```
/router compare agent:claude-code agent:native "...prompt..."

→ 并发触发两路 AgentAdapter.sendPrompt
→ 收集 (text, latency, usage)
→ 拼成一个 IM 卡片回投
```

代码在 `src/core/commands/router-compare.ts`；判别完全不区分 CLI/native——这就是 § 5.1 "kind 是 UI tag" 立场的天然回报。

### 5.7 关键文件索引（v1.3 增量）

| 关注点 | 路径 |
|---|---|
| native AgentAdapter | `src/plugins/agents/native/index.ts` |
| LLM provider 抽象 | `src/core/llm/provider-base.ts` |
| OpenAI-compat provider | `src/core/llm/openai-compat-provider.ts` |
| Anthropic provider | `src/core/llm/anthropic-provider.ts` |
| 多轮 agent loop | `src/core/llm/agent-loop.ts` |
| builtin dispatcher | `src/core/llm/builtin-dispatcher.ts` |
| 外挂 MCP client / registry | `src/core/llm/mcp-client.ts` · `src/core/llm/mcp-registry.ts` |
| 策略审批门 | `src/core/llm/policy-approval-gate.ts` |
| LLM registry + roles | `src/core/llm/registry.ts` |
| Secrets | `src/core/llm/secrets.ts` |
| 路由 fallback 链 | `src/core/llm/introspection.ts`（`tryIntrospectChain`） |
| `/goal` 命令 / 存储 | `src/core/commands/goal.ts` · `src/core/goals.ts` |
| `/heartbeat` 命令 / 调度 | `src/core/commands/heartbeat.ts` · `src/core/heartbeat.ts` · `src/core/heartbeat-store.ts` |
| `ask_user` 原语 | `src/core/ask-user-router.ts` · `src/core/ask-user-rpc.ts` |
| Skills 加载器 | `src/core/skills/loader.ts` |
| Skills RPC | `src/core/skills-rpc.ts` |
| 通知评估门 | `src/core/notification-evaluator.ts` |
| `/router compare` | `src/core/commands/router-compare.ts` · `src/core/router-compare.ts` |
| CLI 向导 setup llm | `src/cli-ui/setup-llm.ts` |
| CLI 向导 setup mcp | `src/cli-ui/setup-mcp.ts` |
| CLI diag | `src/cli-ui/diag.ts` |
| 行内年龄注释 | `src/core/util/format-age.ts` · `src/core/persona.ts` |

---

## 六、v1.2.86–v1.2.104 增量 · native 可靠性栈 + 安全收口 + 运行时热配置

这一轮全部围绕一个判断展开：**当 `native` 成为日常默认 agent（而不仅是 `/router compare` 的对照项）时，它必须自己当好"检察者"** —— 既能察觉自己在原地打转 / 偏题 / 空转，又不能在工具层把敏感数据漏给 IM。下面六块是这一立场的落地。

### 6.1 native turn 可靠性栈（四层早停 / 复盘）

`agent-loop.ts` 的多轮循环外面包了四层独立的"健康检查"，从机械到语义递进，命中即带特定 `finishReason` 早停，由 `native/index.ts` 渲染结构化复盘卡，而不是把垃圾继续推给用户：

| 层 | 触发 | 机制 | finishReason |
|---|---|---|---|
| 空响应自动补刀 | turn 结束 `text==''` 且 `finishReason=stop` 且 tools>0 | 用**同一 provider、禁用工具**再问一刀，逼它把"刚才干了啥"讲出来 | （补刀成功则正常返回） |
| max-iter 复盘 | 撞到 `IMHUB_NATIVE_AGENT_MAX_ITER` | 不再静默截断，渲染"干到第 N 步还没收尾 + 已执行工具列表 + 建议下一步" | `max_iterations` |
| 死循环检测 | 同名 + 同 isError + 同 preview 连续 3 次 | 机械指纹比对，免 LLM 成本，立即早停 | `stuck_loop` |
| goal-critic 偏题检测 | 工具调用 ≥5 次后周期性（每轮 ≤2 次） | 单次廉价 LLM 调用，喂"原始 prompt + 活动 goal + 最近工具轨迹"判 onTrack | `off_track` |

- **goal-critic** 默认 **goal-only**（仅当 thread 有活动 `/long_task` 目标时才烧钱）；env `IMHUB_NATIVE_CRITIC=off|always|goal-only`；用 `llmRoles.cheap`（或 `IMHUB_NATIVE_CRITIC_ROLE`）。代码 `src/core/llm/goal-critic.ts`。
- 复盘卡都给"继续 / 换方向 / 自己指方向 / `/cc` `/oc` `/cs` 切别的 agent"四选项，把决策权交回用户。

### 6.2 native 工具套件扩展

native 不再只有 builtin RPC 工具，补齐了一套"能真正干活"的本地工具，全部过 `policy-approval-gate` + 审计：

| 工具 | 实现 | 说明 |
|---|---|---|
| `native_exec` | `src/core/llm/exec-dispatcher.ts` | shell 执行；`IMHUB_EXEC_SANDBOX=bwrap` 时走 bubblewrap 隔离（Linux，opt-in）；危险模式黑名单 + 内网 URL 拦截 |
| `native_web_fetch` / `native_web_search` | `src/core/llm/*` | 抓取 + 搜索（ddg → metaso 兜底） |
| `native_fs` / `native_grep` / `native_glob` | fs-dispatcher | 工作区受限文件操作；`sensitive-paths` 黑名单依旧生效 |
| bgjob 长任务桥接 | exec-dispatcher `isBgjobInvocation()` | 识别 `bgjob` wrapper 调用，长任务（>10min）detach 到后台；v1.2.99 收紧：命令含 shell-chain 元字符则不豁免沙箱 |
| Python-RPC sidecar | `src/core/llm/agim-rpc-server.ts` + `bin/agim_rpc.py` | native 起的 Python 子脚本通过 Unix socket + per-process token 回调 agim（白名单：search_memos / save_memo / read_skill / list_skills / push_message） |
| reminder 四件套 | `imhub-dispatcher.ts` | create / list / cancel / snooze_reminder 直接给 native（不必绕 CLI sidecar） |

### 6.3 敏感路径硬黑名单（B1 / B5，含 native_exec）

`src/core/sensitive-paths.ts` 在审批总线的"只读自动放行"**之前**做硬拒绝——即便管理员想点同意也不放行，因为输出可能直接落进公开 IM：

- `checkSensitiveToolUse(toolName, input)`：路径类工具（Read/Edit/Write/Glob/Grep/LS）查路径前缀 + 基名黑名单；shell 类工具（**Bash 与 v1.2.101 起的 `native_exec`**）扫命令串。覆盖：env 文件 / `~/.ssh/` / `/etc/shadow` / agim token store / `AGENTS.md`·`CLAUDE.md` / `env`·`printenv` dump / `credentials.{json,yaml,yml}`。
- `scrubOutboundText(text)`：出站前再扫一遍，把 token 形状的子串替换成 `[REDACTED-<kind>]`（agim/OpenAI/GitHub/Slack/AWS/Telegram/Discord/PEM/JWT）。
- **v1.2.101 关键修复**：`native_exec` 之前没走这个扫描（只有 `Bash` 走），等于 native 路由的 `cat .env; env|grep DB_` 能绕过 auto-allow。现在两者共用同一黑名单。

### 6.4 live-config 单例 · 默认 agent 热生效 + 启用列表过滤（v1.2.103）

`src/core/live-config.ts` 解决两个"改了不生效"的坑：

- 之前 `config.defaultAgent` 在 `startWebServer` / `startACPServer` / IM `onMessage` routeCtx 里都是**启动快照**，Web 改默认 agent 要重启才生效。
- 之前 `registry.loadBuiltInPlugins()` 无条件注册所有内置 agent，`config.agents[]`（SPA 的启用开关）**从没被消费**——关掉某 agent 是装饰性的。

修法：cli.ts 启动时 `setLiveConfig(config)`，PUT `/api/config` 保存后再 `setLiveConfig()` 热刷新。`registry.findAgent` / `listAgents` 经 `isAgentEnabled()` 过滤（空 `agents:[]` = 全开，向后兼容）；Web/ACP/IM 默认 agent 读 `getDefaultAgent()`。改完下一条消息即生效，无需重启。

### 6.5 MCP server 失败自动重连（v1.2.96）

`mcp-registry.ts` 的 `callToolByName` 两路检测连接掉线（显式 closed + 调用抛错），5s 冷却内 `tryReconnect` 一次再重试，避免外挂 MCP server 短暂抖动就让整轮工具调用失败。

### 6.6 DingTalk richText 多形态解析（v1.2.89/90/104）

钉钉富文本的段数组在不同 SDK 版本 / 会话类型下挂在不同位置。`flattenDingtalkRichText()`（`dingtalk-adapter.ts`，纯函数可测）按优先级探测：**`msg.content.richText[]`（数组本体，v1.2.104 实测的真实形态）** → `msg.richText[]` → 三个旧的 `.msgList` 嵌套形态。掏不出文字时 dump `fullPayload` 到 warn 日志 + 给用户兜底 ack。

### 6.7 关键文件索引（v1.2.86–104 增量）

| 关注点 | 路径 |
|---|---|
| native 多轮循环 + 早停 | `src/core/llm/agent-loop.ts` |
| goal-critic 偏题检测 | `src/core/llm/goal-critic.ts` |
| native 复盘卡渲染 | `src/plugins/agents/native/index.ts`（`composeUnfinishedTurnRecap` / `composeOffTrackRecap`） |
| native_exec + bwrap | `src/core/llm/exec-dispatcher.ts` |
| Python-RPC bridge | `src/core/llm/agim-rpc-server.ts` · `bin/agim_rpc.py` |
| reminder 四件套（native） | `src/core/llm/imhub-dispatcher.ts` |
| 敏感路径 / 出站脱敏 | `src/core/sensitive-paths.ts` |
| live-config 单例 | `src/core/live-config.ts` |
| MCP 自动重连 | `src/core/llm/mcp-registry.ts` |
| 钉钉 richText 扁平化 | `src/plugins/messengers/dingtalk/dingtalk-adapter.ts`（`flattenDingtalkRichText`） |
| `/long_task` `/complete_goal` slash | `src/core/router.ts`（→ `goal.ts`） |

---

## 七、v1.2.145 增量 · 一轮 CR 修复 + native harness 升级（2026-06）

这一轮分两条线：(A) 一次严格代码 CR 暴露的运行时 / 安全缺陷修复；(B) 参照 [agentic-harness-patterns](https://github.com/keli-wen/agentic-harness-patterns-skill) 对 native agent 做的"harness 工程"升级（上下文预算化 / 工具注册表 / 记忆卫生 / 指令分层 / 验证子代理 / 信任门）。下面给后续 agent 一份"读代码前先看这里"的导览。

### 7.1 运行时可靠性修复（CR 线）

| 修复 | 现象 | 关键改动 | 文件 |
|---|---|---|---|
| **熔断器探针泄漏** | `isOpen()` 有副作用（领走 half-open 探针），却被路由 filter / 前置门调用，探针无人配对 → agent 永久卡"熔断中" | 拆出无副作用的 `peek()`（filter/门用）+ `acquireProbe()`（仅真正调用前），保留 `isOpen()` 语义 | `circuit-breaker.ts` · `intent.ts` · `router.ts` |
| **outbox 重复投递** | 无 claim/lease + `markDelivered` 失败仅 warn → worker 每秒重投已送达消息 | 新增 `sending` 租约：`claimForSend()` 原子认领 → 仅认领成功才发；`requeueStuckSending()` 启动回收；`enqueue` 支持 `dedupKey`（部分唯一索引 + INSERT OR IGNORE） | `outbox.ts` · `message-sink.ts` |
| **提醒/调度非原子** | 投递后崩溃→重复触发；schedule `next_run` 后置更新→重复建 job / 缺 agent 时 30s 空转 | reminder 投递带稳定 `dedupKey`；schedule 改 **CAS 先推进 `next_run` 再建 job**（`WHERE next_run = ?`） | `reminders.ts` · `schedule.ts` |
| **distill 追加无去重** | 同一事实每轮重插，膨胀 persona/检索 | 写入时 `findFactIdByWhat()` 命中则 `touchFact()`（bump `last_referenced_at`）而非插行 | `memory.ts` · `memory-distill.ts` |

### 7.2 安全修复（CR 线，详见 [`security-hardening.md`](../security-hardening.md)）

| 修复 | 摘要 | 文件 |
|---|---|---|
| **viewer 越权删除** | `DELETE /api/viewer/:id` 之前无守卫；现加 `requireAdmin`（所有 mutation 端点一致） | `web/server.ts` |
| **notify_url SSRF** | 词法校验只看 host 串；新增 `assertWebhookHostPublic()` 在 fetch 前 DNS 解析 + 拒私网/回环/link-local（堵 DNS-rebinding / 主机名解析进内网） | `schedule.ts` |
| **sensitive-paths 绕过** | denylist 可被 `/proc/<pid>/{root,cwd}` 与 symlink 绕过；`canonical()` 现做 `realpath`，并对字面 + 解析后路径双重匹配 + 直拒 `/proc` 间接寻址 | `sensitive-paths.ts` |
| **IM 入站阻塞** | Feishu/DingTalk 在 SDK 回调内 `await` 整轮 agent，阻塞接收循环；改 fire-and-forget（钉钉先 ack 再派发） | `feishu-adapter.ts` · `dingtalk-client.ts` |
| **微信会话恢复丢消息** | `SESSION_EXPIRED` 恢复消费 cursor 却只存 token 不派发 → 整批丢失；现走 `handleIncomingMessage` | `wechat/ilink-adapter.ts` |

### 7.3 native harness 升级（升级线）

"把 context 当预算而非垃圾场" + "工具注册表" + "记忆三层" + "验证子代理" + "信任 all-or-nothing"五个 harness 原则的落地：

| 升级 | 做了什么 | 文件 |
|---|---|---|
| **Anthropic 可作 native 后端** | 伪流式 `_callApiStream` 现透传完整 `toolCalls`（之前流式下 Anthropic 工具调用全丢）；baseURL 规范化去尾部 `/v1`（preset 双 `/v1` → 404 修复） | `anthropic-provider.ts` · `agent-loop.ts`（`ChatStreamChunk.toolCalls`） |
| **上下文预算（T1/T3）** | `readOperatorRole` 按 mtime/size memoize（每轮省一次磁盘读+注入扫描）；system-prompt skills 列表封顶 `MAX_INJECTED_SKILLS`（之前未封顶且与 router 注入重复） | `native/index.ts` |
| **单一工具注册表（T2）** | `tools[]` / `combineDispatchers` / 静态 `parallelSafeTools` 三份并行清单合一 → `tool-registry.ts` 的 `assembleNativeTools()`；并发判定改 **逐调用** classifier（`agent-loop` 新增 `parallelSafeClassifier`，fail-closed）；外部 MCP 分区按名排序（prompt-cache 稳定） | `native/tool-registry.ts` · `agent-loop.ts` |
| **指令分层（T4, local-wins）** | `readOperatorRole` 从单 `AGENTS.md` → `<cwd>/AGENTS.md`（project）+ `<cwd>/AGENTS.local.md`（local，**最后拼接=胜出**）；`IMHUB_NATIVE_AGENT_ROLE_FILE` 仍可 pin 单文件 | `native/index.ts` |
| **验证子代理 SOP（T5）** | system prompt 增加"产出实质结果后用全新子代理独立校验 + 自包含 brief + 先综合再委派"指导（纯 prompt，无运行时分支） | `native/index.ts` |
| **工作区信任门（T6）** | `IMHUB_NATIVE_TRUST_WORKSPACE=off` → `readOperatorRole` 一次性跳过所有工作区发现的 role 文件（多租户/A2A 防注入）；显式 pin 文件不受门控 | `native/index.ts`（`isWorkspaceTrusted()`） |
| **native 审计 traceId（ADR-0002 修复）** | native 之前自造 `native-<sid>-<ts>` traceId → 审计行无法关联入站消息；`AgentSendOpts.traceId` 由 router 透传，native 优先用之；进程内 A2A 子调用链接 `${parent}/a2a-${id}` | `types.ts` · `router.ts` · `native/index.ts` · `imhub-dispatcher.ts` |

### 7.4 本轮新增 / 相关 env

| env | 默认 | 作用 |
|---|---|---|
| `IMHUB_NATIVE_TRUST_WORKSPACE` | on（信任） | `off`/`0`/`false`/`no` → native 跳过工作区 `AGENTS.md`/`AGENTS.local.md` 注入 |
| `IMHUB_ALLOW_PRIVATE_WEBHOOKS` | 未设 = 关 | `=1` 同时放行词法校验 + fetch-time DNS 守卫的私网 webhook |
| `IMHUB_NATIVE_AGENT_ROLE_FILE` | 未设 | pin 单一 role 文件，绕过 project+local 层级发现 |
| `IMHUB_NATIVE_CALL_AGENT_IN_PROCESS` | on | `off` → `call_agent('native')` 回退 subprocess 路径（见下方已知偏差） |

### 7.5 已知偏差（后续 agent 注意，尚未收口）

- **A2A native 进程内快路径**（`imhub-dispatcher.ts` `call_agent('native')`）绕过 `callAgentByName`，**不建 inline job、不写 `intent:'a2a'` 审计行** → `/a2a stats|tree` 看不到这些进程内 fan-out（本轮只补了 trace 链接，未补审计/作业对齐）。
- **`isAgentEnabled('native')` 恒 true**（`live-config.ts`）：无视 `config.agents` 禁用开关，破坏 peer 对称性。
- **ACP 侧 SSRF** 仅覆盖 Web test/discover API；config 持久化 / discovery 二跳 / 运行时 client 仍缺校验（该面默认被 `IMHUB_ENABLE_REMOTE_AGENT` 关闭）。

详细立场见 [`architecture-bridge-and-native.md`](../architecture-bridge-and-native.md) § 10。

### 7.6 关键文件索引（本轮）

| 关注点 | 路径 |
|---|---|
| 熔断器 peek/acquireProbe | `src/core/circuit-breaker.ts` |
| outbox 租约 + dedupKey | `src/core/outbox.ts` · `src/core/message-sink.ts` |
| schedule CAS + webhook DNS 守卫 | `src/core/schedule.ts` |
| distill 写入去重 | `src/core/memory.ts`（`findFactIdByWhat`/`touchFact`）· `src/core/memory-distill.ts` |
| sensitive-paths realpath + /proc | `src/core/sensitive-paths.ts` |
| native 工具注册表 | `src/plugins/agents/native/tool-registry.ts` |
| 逐调用并发 classifier | `src/core/llm/agent-loop.ts`（`parallelSafeClassifier`） |
| Anthropic 流式 toolCalls | `src/core/llm/anthropic-provider.ts` · `provider-base.ts`（`ChatStreamChunk.toolCalls`） |
| native 指令分层 + 信任门 + role memoize | `src/plugins/agents/native/index.ts`（`readRoleFile`/`readOperatorRole`/`isWorkspaceTrusted`） |
| viewer delete admin 守卫 | `src/web/server.ts` |
| IM 入站非阻塞 | `src/plugins/messengers/feishu/feishu-adapter.ts` · `src/plugins/messengers/dingtalk/dingtalk-client.ts` |
