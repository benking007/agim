# agim 会话模型与 Agent 会话的关系

> 作用：把 agim 自己的 session、Claude Code 的 session、OpenCode/Codex 的 session 关系放到一张图里，便于排查"为什么会话突然没了 / 续不上 / 像失忆"。
> 关联：[`adr/0003-session-path-safety.md`](./adr/0003-session-path-safety.md) · [`adr/0004-sticky-agent-and-split-ttl.md`](./adr/0004-sticky-agent-and-split-ttl.md) · [`im-workspaces-guide.md`](./im-workspaces-guide.md)

---

## 一、三层 session，两个真实持久化

agim 在一次 IM 对话里面其实有三层"会话"，但只有前两层会真的落到磁盘：

```
   ┌─ agim session ───────────────────────────────────────┐
   │  ~/.agim/sessions/<safe-key>.json   (元数据)          │
   │  ~/.agim/sessions/<safe-key>.log    (消息 JSONL)      │
   │  生命周期：MESSAGES 30 min · META 7 d                    │
   └────────────────┬───────────────────────────────────────┘
                    │ 通过 claudeSessionId 字段索引
                    ▼
   ┌─ Claude Code session ──────────────────────────────────┐
   │  ~/.claude/projects/<cwd-encoded>/<uuid>.jsonl          │
   │  生命周期：Claude 自己保留，无主动清理                  │
   └────────────────────────────────────────────────────────┘

   ┌─ OpenCode / Codex native session ─────────────────────┐
   │  opencodeSessionId / codexSessionId 记录在 session meta │
   │  后续轮次优先走 CLI 原生 resume；没有 id 时才拼 history。 │
   └────────────────────────────────────────────────────────┘
```

---

## 二、agim session

### 2.1 Key 与文件布局

会话 key 由消息入口的三元组组成：

```
key = `${platform}:${channelId}:${threadId}`
```

落盘前先过 `sanitizeKey()`（白名单 `[A-Za-z0-9_-]`，其他字符 → SHA-256 前 8 位，详见 ADR 0003），再生成两个文件：

| 文件 | 写入时机 | 作用 |
|---|---|---|
| `<safe-key>.json` | 创建 / 任意 meta 字段更新 | 元数据（agent / model / variant / claudeSessionId / usage / subtasks） |
| `<safe-key>.log` | 每次 `addMessage` | append-only JSONL 消息历史，避免每条消息全量改写 json |

代码：`src/core/session.ts`

### 2.2 字段与生命周期

```typescript
interface Session {
  id: string                   // 内部唯一 id
  channelId, threadId, platform: string

  agent: string                // sticky agent — 决定下条无前缀消息打给谁
  model?: string               // sticky model
  variant?: string             // sticky variant

  claudeSessionId?: string     // ← 把 agim session 与 Claude session 粘在一起的索引
  claudeSessionPrimed?: boolean
  opencodeSessionId?: string   // OpenCode 原生 session id（ses_...）
  codexSessionId?: string      // Codex 原生 thread id

  usage?: { ... }              // /stats 看到的累计
  subtasks?, activeSubtaskId?  // 子任务独立会话

  createdAt, lastActivity: Date
  ttl: number                  // 现在等于 META_TTL（向后兼容）
  messages: ChatMessage[]      // 内存中的消息数组，对应 .log
}
```

### 2.3 双层 TTL（v2 Phase D）

历史上是单层 30 min — 长停留必丢 sticky agent 与 `claudeSessionId`，导致漂移。现在拆成两层：

| TTL | 默认 | env 变量 | 过期时做什么 |
|---|---|---|---|
| `MESSAGES_TTL` | 30 min | `AGIM_SESSION_MESSAGES_TTL_MS` | 清空内存 `messages[]` + 删 `.log` 文件，**保留** `.json` 与 sticky / `claudeSessionId` |
| `META_TTL` | 7 d | `AGIM_SESSION_META_TTL_MS` | 完整删除（`.json` + `.log` + 内存 entry） |

cleanup 定时器每 5 min 跑一次，用同一对 helper 在两个层级独立判定。

### 2.4 触发会话变化的事件

| 事件 | 效果 |
|---|---|
| 任意消息进来 | `lastActivity` 推到当前时间，两个 TTL 都重置 |
| 30 min 不说话 | 仅清消息历史，sticky agent / Claude UUID 保留 |
| 7 d 不说话 | 整条 session 删除 |
| `/cc` `/oc` 等显式切换 | `switchAgent` 改 `agent` 字段并落盘；不动 `claudeSessionId` |
| `/new` | 清消息 + 删 `claudeSessionId` + 重置 approval auto-allow（强制下次 Claude 起新 UUID） |
| 进程重启 | 内存 Map 重建：来一条消息时按 key 从磁盘 `loadSession` 拉回 |

### 2.5 sticky agent 的绝对锁（v2 Phase A）

只要 `.json` 还在（即未越过 META_TTL），`classifyIntent` 在入口处就早返回 sticky，不进评分流程。意味着：

- 跨日 / 7 d 内回来 → agent 不会变
- 想换只能 `/cc` `/oc` 显式命令或 `/new` 重置
- 评分仅在"全新 thread / sticky 已过 META TTL"时跑

---

## 三、Claude Code session

### 3.1 Claude 自己的存储

Claude 用 `--session-id <uuid>`（首次）或 `--resume <uuid>`（续接），在 cwd 维度的目录里写 jsonl：

```
~/.claude/projects/<cwd-encoded>/<uuid>.jsonl
```

`<cwd-encoded>` 是 cwd 路径里 `/` 替换为 `-` 的结果。v2 升级前 IM Claude 都跑在 `/`，所以全在 `~/.claude/projects/-/`；升级后落到 `~/.claude/projects/-root-agim-workspaces-claude-code/`。

### 3.2 与 agim session 的桥梁

```
agim session.claudeSessionId  ──►  Claude 那个 <uuid>.jsonl
                  ▲
                  │ 由 cli.ts 在第一次给 thread 调 Claude 时分配
                  │ 后续调用按 agentSessionResume=true 走 --resume
```

关键代码 `src/core/router.ts` `callAgentWithHistory` 里的：

```ts
const effectiveHistory = ctx.agentSessionResume ? [] : history
```

当走 `--resume`，**agim 不再把 messages[] 拼回 prompt**，让 Claude 完全靠它自己的 jsonl 读历史，避免双倍上下文。

### 3.3 寿命对齐

Claude 那边的 jsonl 永不过期（除非手动清）。但只要 agim 这边的 `claudeSessionId` 字段被 META_TTL 清掉，下一条消息就走"分配新 UUID + `--session-id`"路径，旧 jsonl 还在但没人指它了。

→ **想让 Claude 跨周续接，把 META_TTL 调大；想强制起新对话，`/new`。**

---

## 四、OpenCode / Codex native session

OpenCode 与 Codex 会在 JSON 事件流里暴露自己的 session/thread id。agim 捕获后分别写入：

| Agent | 字段 | 后续调用 |
|---|---|---|
| OpenCode | `opencodeSessionId` | 传回 OpenCode adapter，并把 `agentSessionResume=true` |
| Codex | `codexSessionId` | 使用 `codex exec resume <id>` |

当 `agentSessionResume=true` 时，router 会把 `effectiveHistory` 置空，避免"CLI 原生历史 + agim 拼接历史"双喂上下文。

如果还没有捕获到原生 id（例如首次调用或旧版本升级后的第一轮），才依赖 agim 的 `messages[]` 拼接历史。

后果：

| 情形 | opencode 看到的 |
|---|---|
| 首轮 / 尚未捕获 native session id | agim 拼接的 `messages[]` |
| 已捕获 `opencodeSessionId` | OpenCode 原生 session 历史 |
| 30 min 不说话再回来 | agim 短历史可能清空，但 native session id 仍在 META TTL 内保留 |

建议：

- 在 `~/.agim-workspaces/opencode/PROJECT.md` 写"长期不变的项目档案"，让 opencode 启动时读
- 把 `AGIM_SESSION_META_TTL_MS` 调大，以延长 native session id 的可恢复窗口
- 重要事实主动让用户复述，或建一个 prompt 前缀模板

---

## 五、子任务（subtask）会话

`/job` 创建的子任务有自己的独立会话，key 形如 `${platform}:${channelId}:${threadId}:sub:${jobId}`。父 session 的 `activeSubtaskId` 字段把当前焦点指向子任务；该字段非空时，无前缀消息打给子任务而非主会话。

v0.2.30 起，`/test` / `/review` / `/diff` 等 agentCommand 也遵循同一焦点规则：active subtask 下会进入子会话，不再落回父会话。

子任务会话也是 agim session 的一种实例，TTL 规则一致，并且有自己的 `claudeSessionId` / `opencodeSessionId` / `codexSessionId`。这意味着主会话与子任务不会在 Agent CLI 原生 session 层串线。

---

## 六、运维：调 TTL 的 systemd 片段

```ini
# /etc/systemd/system/agim.service.d/override.conf
[Service]
Environment="AGIM_SESSION_MESSAGES_TTL_MS=3600000"   # 1h，opencode 久聊用
Environment="AGIM_SESSION_META_TTL_MS=2592000000"    # 30d，长 sticky
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart agim
```

env 钩子完整列表见 `im-workspaces-guide.md § 六`。

---

## 七、诊断手册

| 症状 | 怎么查 |
|---|---|
| Agent 又漂了 | `/audit` 看最近一条 `intent`：`sticky` = 锁正常；`topic` / `keyword` = sticky 失效（要么 META 过期要么 bug）；同时 `ls -la ~/.agim/sessions/<safe-key>.json` 看元数据是否还在 |
| Claude 上下文丢了 | `jq '.claudeSessionId, .lastActivity' ~/.agim/sessions/<safe-key>.json`；为空 = META 过期；非空但 Claude 报 "session not found" = cwd 与 jsonl 路径不一致（v2 升级冷启动一次会出现，发一条消息生成新 UUID 即可） |
| opencode / Codex 像失忆 | 查 `opencodeSessionId` / `codexSessionId` 是否仍在 META TTL 内；为空则只剩 agim 短历史（可调大 `MESSAGES_TTL`）。adapter 有原生 resume；不要当成「完全没有 session」 |
| Web Chat 刷新后空了 | 见下文「Web Chat」；查 `localStorage.agim-web-thread-id` 与 `~/.agim/sessions/web:web:<id>.*`；超过 `MESSAGES_TTL`（默认 30 min）会清气泡但 sticky agent 可保留 |
| 想看消息历史 | `cat ~/.agim/sessions/<safe-key>.log`（JSONL，每行一条） |
| 想看 Claude 历史 | `ls -lt ~/.claude/projects/-root-agim-workspaces-claude-code/*.jsonl \| head` |

---

## 八、给后来者的速查表

| 问题 | 答案 |
|---|---|
| agim session 在哪 | `~/.agim/sessions/<safe-key>.{json,log}` |
| safe-key 怎么算 | `${platform}:${channelId}:${threadId}` 过 sanitizeKey |
| 短 TTL 与长 TTL 各管什么 | 短管消息历史 / 长管 sticky agent + Claude UUID |
| Claude 续接靠什么 | session 的 `claudeSessionId` + `--resume` |
| OpenCode/Codex 续接靠什么 | session 的 `opencodeSessionId` / `codexSessionId` + adapter resume |
| sticky 怎么改 | `/cc` `/oc` 等显式命令或 `/new` 重置 |
| Agim Agent JSONL 在哪 | `~/.agim/agim-sessions/`；退役进 `~/.agim/agim-session-quarantine/` |
| `/new` 清 JSONL 吗 | 不清内容原地删；rename 进 quarantine（忙则延后） |
| 跨平台共享 sticky 吗 | 不共享，key 含 platform |
| 重启进程会丢吗 | 不会，落盘的元数据会被 lazy 加载回来 |

---

## 九、Agim Agent JSONL（第三层）

Agim Agent 的对话真源不在 `sessions/*.log`，而在：

```
~/.agim/agim-sessions/<cwd-encoded>/<timestamp>_<session.id>.jsonl
```

`session.id` 与主 session 元数据绑定。`/new`、`switchAgent`、META TTL 会换新 id；MESSAGES TTL 只清消息、**保留** id。

### 9.1 Quarantine / retention

| 路径 | 作用 |
|---|---|
| `~/.agim/agim-sessions/` | 活跃 JSONL（JsonlSessionRepo） |
| `~/.agim/agim-session-quarantine/` | 退役归档（**sessionsRoot 外**，避免 `repo.list()` 扫回） |

触发退役（rename → quarantine，忙则 deferred）：

- `/new` → `resetConversation`（reason `new`）
- `switchAgent`（reason `switch`）
- META TTL 全量驱逐（reason `meta_ttl`）
- Boot orphan inventory：磁盘 JSONL id ∉ 任何 `sessions/*.json` 的 `id`（reason `orphan`）

宽限期后物理删除：`AGIM_AGENT_SESSION_QUARANTINE_DAYS`（默认 7）。

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `AGIM_AGENT_SESSION_QUARANTINE` | `on` | `off` / `on` / `inventory`（只记日志不移动） |
| `AGIM_AGENT_SESSION_QUARANTINE_DAYS` | `7` | quarantine 后保留天数；`0` 表示不自动 purge |
| `AGIM_AGENT_SESSION_RETENTION_SWEEP_MS` | `6h` | 周期 sweep；`0` 关闭 |
| `AGIM_AGENT_SESSION_RETIRE_WAIT_MS` | `30000` | 等待 session lock 排空的上限 |

代码：`src/core/agim-agent-session-lifecycle.ts`；adapter hooks 在 `agim-agent/factory.ts`。

---

## 十、Web Chat 会话恢复

Web 控制台（`/` / `/m/chat`）与 IM 共用同一套 `~/.agim/sessions/` 模型，key 形如：

```
web:web:<threadId>
```

| 机制 | 说明 |
|---|---|
| 浏览器 thread id | SPA 把 id 存在 `localStorage['agim-web-thread-id']`（`web-…` 形） |
| 恢复协议 | 每次 WS `open` 发 `get-history { threadId }`；服务端 rekey 到该 id 并回放 `.log` |
| 空历史 | session 仍在但消息已过 `MESSAGES_TTL` 时仍发 `history`（可为空），用于恢复 sticky agent |
| 「新对话」 | WS `new-conversation` → `resetConversation`；**同一** localStorage thread id，气泡清空 |
| Agent 切换 | UI 气泡可保留；Agim Agent JSONL 按 §九 quarantine |

排障：

1. DevTools → Application → `agim-web-thread-id`
2. `ls ~/.agim/sessions/web:web:<id>.*`（或 sanitize 后的 safe-key）
3. 超过默认 30 min 无活动：气泡被清属预期；调 `AGIM_SESSION_MESSAGES_TTL_MS` 可延长
