# agim Agent-to-Agent 升级计划

> 目标：让一个 agent（claude-code / opencode / codex）能在跑的过程中**程序化**调用另一个 agent，把结果拿回来继续推理。从"用户手动切 agent"升级到"agent 编排 agent"。
> 起始日期：2026-05-15
> 当前分支：main（待开 feat/agent-to-agent）
> 维护人：ben.wangzj@gmail.com（用户）+ Claude Code（执行）

---

## 背景

agim 当前已支持 4 种 agent（claude-code / opencode / codex / copilot）和多种 IM 入口。用户层路由很完整：

- `/cc` `/oc` `/cx` 显式切换
- intent classifier 自动选 agent
- `/job create <agent> <prompt>` 手工把任务丢给指定 agent
- ACP server + client 让 agim 既能被上游调用、也能调远端 ACP agent

但**这一切都在用户层**。一个 agent 跑到一半，想"让 codex 帮我看下这段代码"或"让 opencode 跑一下测试"，目前只能通过 prompt 让用户手动切换。

A2A 升级的本质是：**给每个 agent 一个新工具，能在 agim 内部触发另一个 agent**。最小语义就解锁了"先 claude 出方案 → 再 codex 实现 → 再 opencode 测试"这类多步推理。

---

## 现状摸底（2026-05-15）

| 事实 | 出处 | 含义 |
|---|---|---|
| 共用 MCP sidecar 给三种 agent | `src/plugins/agents/claude-code/mcp-approval-server.ts` | claude-code / opencode / codex 都从同一个进程加载工具；新增 tool 一次注册三家通用 |
| Sidecar 通过 unix socket + runId 跟 agim 主进程通信 | env `IMHUB_APPROVAL_SOCK` + `IMHUB_RUN_ID` | 已有 RPC 通道；A2A 调用复用同一信道即可 |
| bus 已支持多种 RPC（approval / reminder / memo / location） | `src/core/approval-bus.ts` | 加一类"call_agent" RPC 是同一套模式 |
| `runId → RunContext` 映射在 bus 里 | `approval-bus.ts:99-104` (RunContext) | A2A 调用方天然带上自己的 ctx，可以传给被调用方 |
| 已有 sticky agent / per-agent cwd / per-agent native session | `core/intent.ts`、`core/agent-cwd.ts`、`core/session.ts` | 被调 agent 的会话独立，不污染调用方的对话历史 |
| Subtask 表已嵌在 session 里 | `core/types.ts:131-141` `SubtaskMeta` | A2A 调用可以记录为 subtask 行，给用户层 `/job list` 见 |
| Phase 2 inline job 已落地 | `feat/task-recovery` | A2A 调用就是一种特殊的 inline job：parent_id 指向调用方 |
| ACP server 已有 POST /tasks（外部调 agim → 跑 agent → 返回） | `core/acp-server.ts:146` | A2A 是同一形态的内部版 |

**结论**：基础设施 ~80% 已就位。A2A 第一层主要是"加一个 MCP tool + bus 路由 + subtask 记账"。

---

## 路线图

按价值递增、复杂度递增：

| Layer | 名字 | 解锁 | 工作量 |
|---|---|---|---|
| L1 | `agim.call_agent` MCP tool | 单步：A 调 B，B 跑完返回结果 | ~2-3 天 |
| L2 | Shared artifact pool | 多步：A 写文件 → B 读文件 | ~1-2 天 |
| L3 | Workflow DSL | 编排：YAML/JSON 描述 A→B→C 流水线 | ~1 周 |

L1 是核心，L2/L3 是渐进增强。先做 L1 跑半个月再决定 L2/L3。

---

## Layer 1 — `agim.call_agent` MCP tool

### 公开形态

新增 MCP tool（在共用 sidecar 注册）：

```typescript
// 工具名：mcp__imhub__call_agent
{
  agent: 'claude-code' | 'opencode' | 'codex'  // 必填
  prompt: string                                // 必填
  timeout_ms?: number                           // 默认 600_000 (10 min)
  use_default_thread?: boolean                  // 默认 true：复用 caller 的 thread；
                                                // false：开一个独立的 subtask thread
}
→ 返回 JSON-encoded text:
  { ok: true, result: string, job_id: number, agent: string, duration_ms: number }
  | { ok: false, error: string }
```

### 调用链

```
caller (claude-code 例) 跑到一半
  → tool call: mcp__imhub__call_agent({ agent: 'codex', prompt: '...' })
  → MCP sidecar 收到，转发给 bus.callAgent(runId, payload)
  → bus 用 runId 查 RunContext (platform/channelId/threadId/userId)
  → router.callAgentByName(target_agent, prompt, ctx)
    - 创建 inline job 行 (kind='inline', parent_id=caller_job_id)
    - 调 callAgentWithHistory(targetAgent, ...) 跑到完
    - 累积 fullResponse
  → bus 返回 result string 给 sidecar
  → sidecar 返回 tool result 给 caller
caller 拿到结果继续推理
```

### 关键决策

#### 复用 caller thread 还是开独立 subtask thread？

- **复用 thread**（`use_default_thread=true`，默认）：被调 agent 共用 caller 的 IM thread，user 能在 IM 里看到"⇒ codex: ..."的中间输出（取决于 sink 改造）。**适合大多数场景**。
- **独立 subtask thread**（`use_default_thread=false`）：被调 agent 开个新的 subtask thread（已有 SubtaskMeta 机制），用户层看不到中间过程，只看到最终汇总。**适合 caller 想保持 IM 干净**。

#### 死循环防护：`X-Call-Depth`

- bus 在每次 call_agent 时检查 RunContext 的 depth 字段
- 默认 max_depth=3（A→B→C 是 3 层，A→B→C→D 拒绝）
- 超过 max_depth 返回 `{ok: false, error: 'call depth exceeded'}`
- env `IMHUB_A2A_MAX_DEPTH` 可调
- depth 通过 ctx 透传：caller ctx.depth=2 → bus 给 callee 注入 ctx.depth=3

#### 防自调

- 不允许 caller=callee（claude 不能调 claude，避免 vacuous 递归）
- 返回 `{ok: false, error: 'cannot call self'}`

#### 成本可观测

- 每个 call_agent 写一条 audit row（type='a2a'）
- caller / callee / duration / token cost 都记
- `/a2a stats` 命令查近 N 条调用

#### 超时

- 默认 10 min。超过返回 `{ok: false, error: 'timed out'}`，但 callee 进程不强杀（让它跑完写 audit）
- env `IMHUB_A2A_TIMEOUT_DEFAULT_MS`

### Schema 改动

复用 Phase 2 已有的 jobs 表，加 1 列：

```sql
ALTER TABLE jobs ADD COLUMN parent_id INTEGER;  -- caller job id，A2A 调用专用
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id) WHERE parent_id IS NOT NULL;
```

`/job list` 可加可选 `--tree` 显示父子链。

### 实施清单

- [ ] bus 新增 `callAgent(runId, payload): Promise<CallAgentResult>` RPC
- [ ] sidecar 注册 `mcp__imhub__call_agent` tool
- [ ] router 新增 `callAgentByName(name, prompt, ctx, opts)` 函数（reuse callAgentWithHistory）
- [ ] depth check + self-call check
- [ ] jobs.parent_id 列 + index
- [ ] audit 新 type='a2a'，`/a2a stats` 命令
- [ ] env 配置：`IMHUB_A2A_MAX_DEPTH`、`IMHUB_A2A_TIMEOUT_DEFAULT_MS`
- [ ] IMHUB_A2A_ENABLED=0 整套关停（默认 1）
- [ ] 单元测试：depth check / self-call / happy path / timeout / 错误透传
- [ ] 端到端：claude → codex → opencode 三跳成功 + 超过 max_depth 被拒

---

## Layer 2 — Shared artifact pool（B 的副产品）

### 痛点

L1 只有"字符串 in / 字符串 out"。如果 claude 让 codex 改一个 100 行的文件，回传整个文件内容到 caller 上下文是浪费。更好的形态：**共享文件系统**。

### 形态

每个 inline job 的 cwd 下有个 `artifacts/` 目录：

```
~/.agim-workspaces/<agent>/artifacts/<job_id>/
  ├── INPUT.md        # caller 写入的输入
  ├── OUTPUT.md       # callee 产出的主结果
  └── *.{json,txt,py}  # 任意 callee 落盘的中间文件
```

`call_agent` tool 加可选字段：

```typescript
{
  ...,
  artifacts_in?: string[]     // caller 已有的文件路径，复制到 callee 的 artifacts/
  artifacts_out?: string[]    // callee 应该产出的文件名（验收）
}
```

返回值多一个 `artifacts_dir`，caller 可以 `Read` 拿产出。

### 取舍

- 共享 fs vs 显式 message passing：fs 对 token 效率高；message passing 对协议清晰
- 当前选 fs，因为 claude-code / opencode / codex 都支持原生文件读写工具
- 文件留多久？复用 inline job retention（24h）

### 实施清单

- [ ] artifacts dir 创建 hook（在 router.callAgentByName 里）
- [ ] artifacts_in 文件拷贝（caller cwd → callee cwd）
- [ ] tool 返回 artifacts_dir 路径
- [ ] retention 顺带删 artifacts/
- [ ] 端到端：claude 让 codex 改文件 → claude 读改后文件

---

## Layer 3 — Workflow DSL（可选，最后做）

### 痛点

L1 + L2 已能让 agent **runtime 编排** agent。但有些工作流是固定的（"周报：先 codex 跑数据查询，再 claude 写总结，再 opencode 发邮件"），写在 agent 的 prompt 里不利于调试 + 复用。

### 形态

`agim workflow run plan.yaml`：

```yaml
name: weekly-report
steps:
  - id: query
    agent: codex
    prompt: 跑 SQL 查上周数据 → artifacts/data.csv
  - id: summary
    agent: claude-code
    prompt: 读 ${query.artifacts_dir}/data.csv 写总结 → artifacts/summary.md
    depends_on: [query]
  - id: send
    agent: opencode
    prompt: 把 ${summary.artifacts_dir}/summary.md 发邮件
    depends_on: [summary]
```

### 取舍

- DSL vs prompt-as-code：DSL 利于复用 + 调试，但是又一套语义层
- 先做 L1 + L2 + 在内部用半个月，看真实需要才上 L3
- L3 也可以是另一种东西，比如 LangGraph-style code SDK 而非 YAML

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| **A→B→A 死循环** | depth check（max 3，env 可调）；自调禁止 |
| **成本爆炸**（A 调 B 调 C，每层 1k token） | per-user budget 已经在 Phase 1 路线图里；A2A 调用计入同一 budget；audit 记账 |
| **跨 agent 的 prompt 注入** | 被调 agent 收到的 prompt 视为不可信文本，跟普通 IM 输入同等对待 |
| **callee 跑太久阻塞 caller** | 超时机制 + caller 看到 "callee 还在跑" 心跳？v1 先用超时，v2 看需要再加 |
| **callee 副作用乱写 caller cwd** | per-agent cwd 已隔离（Phase B agent-cwd-isolation），artifacts/ 是显式共享区 |
| **认证 / 多租户** | A2A 沿用 caller 的 RunContext（同一 userId / workspace_id）；不允许跨 workspace 调用 |
| **MCP tool 长 await 撞 sidecar 超时** | MCP 协议本身支持长 await；现有 reminder polish 已经能 await 数十秒 |

---

## 与已有架构的关系

- **复用 Phase 2 jobs 表** — A2A 调用就是一种 inline job（加 parent_id 列）
- **复用 Phase 1 sink** — A2A 的 callee 输出走 sink 投递（如果 use_default_thread=true）
- **复用 Phase 3 recovery** — A2A 子任务在 agim 崩溃时也会被标 'interrupted'；恢复时只通知 root caller（最顶层那条）
- **复用 ACP server** — 远端 ACP agent 也可以作为 A2A 调用目标（agent name 形如 `acp:remote-1`）
- **复用 MCP sidecar** — 不新建进程，只新增 tool 注册

---

## 工作量预估

| Layer | 工作量 | 主风险 | 可独立上线 |
|---|---|---|---|
| L1 call_agent | 2-3 天 | depth check 漏判；callee timeout 后清理；audit/budget 钩子 | ✅ |
| L2 artifacts | 1-2 天 | 路径权限；跨 cwd 拷贝；retention 顺带删 | ✅ |
| L3 workflow DSL | ~1 周 | DSL 设计折腾、错误传播、并行 step | ✅（不依赖 L2，但建议先 L1 + L2 沉淀几周）|

**总 ~2 周**。L1 单独上线就能解锁绝大部分场景，L2 / L3 看实际使用反馈。

---

## 跨会话恢复指引（给下一次接手的我）

如果新会话需要接力本工作：

1. 先读本文件 `docs/agent-to-agent-plan.md`
2. 看 `docs/task-recovery-plan.md` 了解 Phase 1-3 上下文（A2A 复用了其 jobs 表、sink、recovery 机制）
3. 看 `git log --oneline -10 src/core/approval-bus.ts src/plugins/agents/claude-code/mcp-approval-server.ts` 确认 sidecar / bus 是否已扩展
4. DB 现状：
   ```bash
   sqlite3 ~/.agim/jobs.db "PRAGMA table_info(jobs)" | grep parent_id  # L1 落地后有
   sqlite3 ~/.agim/audit.db "SELECT type, COUNT(*) FROM invocations WHERE type='a2a' GROUP BY type"
   ```
5. 灰度开关：`echo $IMHUB_A2A_ENABLED`（默认 1）

---

## 参考文件

| 文件 | 角色 |
|---|---|
| `src/plugins/agents/claude-code/mcp-approval-server.ts` | MCP sidecar，所有 agent 共用 — L1 新增 tool 注册点 |
| `src/core/approval-bus.ts` | bus + RunContext + socket RPC — L1 新增 callAgent RPC |
| `src/core/router.ts` `callAgentWithHistory` | 实际跑 agent 的入口 — L1 复用 |
| `src/core/job-board.ts` | inline job 表 — L1 加 parent_id 列 |
| `src/core/message-sink.ts` | 投递层 — L1 callee 输出走它 |
| `src/core/agent-cwd.ts` | per-agent cwd — L2 artifacts 复用 |
| `src/plugins/agents/opencode/ensure-mcp-config.ts` | opencode mcp 注册路径 — L1 新 tool 自动复用 |
| `src/plugins/agents/codex/build-mcp-cli-args.ts` | codex mcp 注册路径 — 同上 |

---

## 进度追踪

| Layer | 状态 | 完成日 | PR / Commit | 备注 |
|---|---|---|---|---|
| L1 call_agent | ⏳ planned | — | — | — |
| L2 artifacts | ⏳ planned | — | — | — |
| L3 workflow DSL | ⏳ planned | — | — | — |

---

## 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-15 | 初始设计稿。task-recovery 灰度部署同日落地 | Claude Code |
