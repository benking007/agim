# CLI sticky 父派 Subagent

> **状态**：现行 · 2026-07-27  
> **产品分界**：**CLI 可派工，不可当 Loop 父**  
> **关联**：[Subagent](./subagent.md) · [Loop](./loop-engineering.md) · [派工画像](./agent-profiles.md) · [编排路线图](./orchestration-roadmap.md) · [Agent 后端表](../agents.md) · [命名](../naming.md) · [接入 SOP](../agent-integration-sop.md) · [桌面回归 §4b](../desktop-regression.md)

## 0. 一句话

**sticky Codex / Claude / … 可以 `call_agent` / `call_agents` 派子工人；`/loop` + `loop_verdict` + Focus 工具只挂 Agim Agent。**

父可以是 Agim（in-process）或 sticky CLI（MCP sidecar / PI extension）；子工人统一进 SubagentRun / A2A job 树。

---

## 1. 谁可以派

| 父形态 | `call_agent` | `call_agents` | `loop_verdict` / `focus_*` |
|--------|--------------|---------------|----------------------------|
| **Agim Agent**（in-process） | ✅ + `role`/`backend`/`isolate` | ✅ | ✅（Loop 父） |
| **CLI sticky**（MCP sidecar） | ✅（agent+prompt；可选 inputs） | ✅ | ❌ |
| **PI sticky**（extension） | ✅ | ✅ | ❌ |

### 覆盖的 CLI（共用 sidecar，除非另注）

| registry id | sticky 别名（摘自 [`agents.md`](../agents.md)） | 注入方式（摘要） |
|-------------|-----------------------------------------------|------------------|
| `claude-code` | `/cc` `/claude` | 每轮临时 `--mcp-config` |
| `codex` | `/cx` | `-c mcp_servers.agim.*` |
| `copilot` | `/co` `/gh-copilot` | `--additional-mcp-config` |
| `opencode` | `/oc` | `ensure-mcp-config`（stdio；HTTP driver 另论） |
| `cursor` | `/cs` `/cur` | `~/.cursor/mcp.json` |
| `kimi-code` | `/kimi` `/km` | `~/.kimi-code/mcp.json` |
| `qoder` | `/qd` `/qodercli` | 内联 `--mcp-config` JSON |
| `mimo` | `/mo` `/mimo-code` | 环境注入 MCP 配置 |
| `antigravity` | `/agy` `/gemini` `/ag` | `~/.gemini/config/mcp_config.json` |
| `pi` | `/pi` `/pi-agent` | **非 MCP**：`pi/agim-extension.ts` → 同一 approval bus |

实现 SSOT：

- `src/plugins/agents/claude-code/mcp-approval-server.ts` — `call_agent` / `call_agents`
- `src/plugins/agents/pi/agim-extension.ts` — 同上能力，经 PI extension
- `src/core/subagent-parallel.ts` — `mapPool` / parallel knobs / hard max

别名与安装提示以 [`agents.md`](../agents.md) 为唯一 inventory；本文不维护第二份列表。

---

## 2. 运行时路径

```text
sticky CLI turn
    │
    ├─ prepareCommand 注册 runId → approvalBus
    ├─ 启动 CLI，挂上 agim MCP（或 PI extension）
    │
    ▼
mcp__agim__call_agent / call_agents
    │
    ▼
ApprovalClient → unix bus type:a2a  (×N + mapPool for batch)
    │
    ▼
callAgentByName → Subagent job + activity + Portal 卡片
```

批量护栏（与 Agim Phase B 同 knobs）：

| knobs | 默认 | 含义 |
|-------|------|------|
| `AGIM_SUBAGENT_PARALLEL` | on | batch 是否并行 |
| `AGIM_SUBAGENT_PARALLEL_MAX` | 3 | 单次 batch 并发上限 |
| `CALL_AGENTS_TASKS_HARD_MAX` | 12 | `tasks[]` 硬顶 |

Join：**allSettled**（工具层 ok；按 lane 报 ok/error）。  
深度 / 自调用 / ACL：既有 A2A（`AGIM_A2A_*`）。

**Agim 独有（CLI 没有）**：

- 同族 `role` / `backend` / `isolate` 参数  
- 每 turn `AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN`（CLI 路径暂不镜像）  
- Loop 门禁 + `loop_verdict` / Focus 工具  
- specialty catalog **全文**注入（画像主要服务 Agim 父；CLI 父侧目前靠工具 description 短提示）

---

## 3. 工具契约（sidecar / PI）

工具名在 MCP 面为 `call_agent` / `call_agents`；日志与 UI 常显示 `mcp__agim__call_agent(s)`。

### 3.1 `call_agent`（单路）

```json
{
  "agent": "agim",
  "prompt": "Objective: …\nOutput: …\nBoundaries: …\nDone-when: …",
  "timeoutMs": 120000,
  "inputs": [
    { "name": "brief.md", "content": "…" }
  ],
  "expectOutputs": ["summary.md"]
}
```

成功大致：`{ ok: true, result, jobId, agent, durationMs, … }`  
失败：`{ ok: false, error }`。

### 3.2 `call_agents`（批量 fan-out）

```json
{
  "tasks": [
    { "agent": "agim", "prompt": "Lane A: …" },
    { "agent": "agim", "prompt": "Lane B: …" }
  ]
}
```

每条 task 字段与单路相同（`agent`/`prompt` + 可选 `timeoutMs`/`inputs`/`expectOutputs`）。  
硬顶 `1…CALL_AGENTS_TASKS_HARD_MAX`；偏好 2–3 路。

成功时工具文本含 join 摘要 + JSON：

```json
{
  "ok": true,
  "okCount": 2,
  "parallel": true,
  "concurrency": 2,
  "lanes": [
    { "ok": true, "index": 0, "agent": "agim", "jobId": 12, "durationMs": 800, "result": "…" },
    { "ok": false, "index": 1, "agent": "agim", "error": "…" }
  ]
}
```

父模型应**合成**各 lane，不要原样倾倒 transcript。  
同文件并行写：拆目录或串行。

### 3.3 Brief 质量（与 Subagent 同原则）

callee **看不到**父会话 history。brief 至少含：目标 / 输出格式 / 边界 / 完成条件。详见 [`subagent.md`](./subagent.md)。

---

## 4. 与 Loop / sticky / 画像

| 概念 | 关系 |
|------|------|
| **Loop L3** | 父编排者 = **Agim only**。sticky CLI 上跑 `/loop` 没有 `loop_verdict`；请 `/agim` 后再 `/loop` |
| **sticky handoff** | `/cc` `/cx` … 换的是用户主会话 agent，**不是** Subagent |
| **CLI 再派工** | sticky 父保留对用户回复权，用 `call_agent(s)` 嵌套工人 — **是** Subagent |
| **派工画像** | 告诉 **Agim** 该派哪个 CLI；CLI 父侧目前靠工具 description 短提示，无完整 catalog |

用户话术建议：

- 「用 Codex 改这段，再叫 Agim 便宜模型核对」→ sticky Codex + `call_agent(agim, …)` ✅  
- 「开一个工程闭环 `/loop`」→ sticky **Agim** ✅；别指望 sticky Codex 跑 Loop ❌  

---

## 5. 排障速查

| 现象 | 常见原因 | 处理 |
|------|----------|------|
| CLI 说「我不会 call_agent」 | MCP/extension 未挂上，或模型拒用工具 | `agim doctor`；看该 adapter 的 MCP 注入；明确要求「用 mcp__agim__call_agent」 |
| `tasks.length exceeds hard max` | 超过 `CALL_AGENTS_TASKS_HARD_MAX`（12） | 拆批或减 lane |
| lane `ok:false` + depth/self-call | A2A 深度或自调用禁令 | 换目标 agent / 降嵌套 |
| Portal 无 Subagent 卡片 | 未走 bus / runId 丢失 | 确认会话在 Agim 托管的 sticky 轮次内（非裸终端 CLI） |
| 想用 `/loop` 但无 `loop_verdict` | 当前 sticky 是 CLI | `/agim` 后再 `/loop` |
| matrix 偶发 429 / rate limit | Web 租户默认 rateLimit | 调高 `tenants[].rateLimit` 或放慢 matrix（仅本机） |
| 嵌套 `agim` 无 API key | 子工人需可用 `llmBackends` | 配 `~/.agim/llm-secrets.json`，或 matrix 用 mock LLM |

---

## 6. 验收

### 自动化

```bash
# 需本地 agim 已 start；CLI 在 PATH（可用 stub）
node tools/cli-agents-matrix-ws.mjs
```

对 10 个非 Agim CLI 各跑 `call_agent` + `call_agents`（嵌套工人建议 mock `agim`）。  
单测：`mcp-approval-server.test.ts` · `agim-extension.test.ts`。  
桌面清单：[`desktop-regression.md` §4b](../desktop-regression.md)。

### 手工（Chat）

1. sticky 切到目标 CLI（`/cc` `/cx` …）  
2. 「用 call_agent 派 agim …」→ Subagents: 1，`"ok": true`  
3. 「用 call_agents 两路 fan-out …」→ Subagents: 2，`okCount: 2`  
4. sticky Agim → `/loop …` 仍可用；CLI sticky **看不到** `loop_verdict` 工具  

新接入 CLI 时：SOP 能力表要求 `call_agent` + `call_agents` 均可；**不要**在 sidecar 挂 `loop_verdict` / Focus。

---

## 7. 非目标

- CLI 当完整 Loop 父（挂 `loop_verdict` / Focus）  
- sidecar 注入完整 specialty catalog  
- sidecar `call_agent` 对齐 Agim 的 `role`/`backend`/`isolate`（可后续）  
- 同 thread 双 sticky 对等并行  
- 镜像 Agim 的 `AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN` 到 CLI 路径  

---

## 8. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-27 | **落地**：sidecar + PI 暴露 `call_agents`；复用 A2A + `mapPool`；Loop 仍仅 Agim |
| 2026-07-27 | **验收**：`tools/cli-agents-matrix-ws.mjs`（10 CLI × 单路/批量） |
| 2026-07-27 | **文档**：本 SSOT + agents / Subagent / Loop / roadmap / Portal / SOP / 回归交叉引用 |

---

## 9. TL;DR

> **所有 sticky CLI 都能派 Subagent（单路 + 批量）。**  
> **只有 Agim 能当 Loop 父。**  
> 管子仍是 A2A / approval bus；Portal 子代理卡片同一套。
