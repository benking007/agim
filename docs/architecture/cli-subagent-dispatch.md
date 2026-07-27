# CLI sticky 父派 Subagent

> **状态**：现行 · 2026-07-27  
> **产品分界**：**CLI 可派工，不可当 Loop 父**  
> **关联**：[Subagent](./subagent.md) · [Loop](./loop-engineering.md) · [派工画像](./agent-profiles.md) · [编排路线图](./orchestration-roadmap.md) · [命名](../naming.md) · [接入 SOP](../agent-integration-sop.md)

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

| registry id | 注入方式（摘要） |
|-------------|------------------|
| `claude-code` | 每轮临时 `--mcp-config` |
| `codex` | `-c mcp_servers.agim.*` |
| `copilot` | `--additional-mcp-config` |
| `opencode` | `ensure-mcp-config`（stdio；HTTP driver 另论） |
| `cursor` | `~/.cursor/mcp.json` |
| `kimi-code` | `~/.kimi-code/mcp.json` |
| `qoder` | 内联 `--mcp-config` JSON |
| `mimo` | 环境注入 MCP 配置 |
| `antigravity` | `~/.gemini/config/mcp_config.json` |
| `pi` | **非 MCP**：`pi/agim-extension.ts` → 同一 approval bus |

实现 SSOT：`src/plugins/agents/claude-code/mcp-approval-server.ts`（`call_agent` / `call_agents`）· `src/plugins/agents/pi/agim-extension.ts`。

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
| `CALL_AGENTS_TASKS_HARD_MAX` | 8 | `tasks[]` 硬顶 |

Join：**allSettled**（工具层 ok；按 lane 报 ok/error）。  
深度 / 自调用 / ACL：既有 A2A（`AGIM_A2A_*`）。

**Agim 独有（CLI 没有）**：

- 同族 `role` / `backend` / `isolate` 参数  
- 每 turn `AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN`（CLI 路径暂不镜像）  
- Loop 门禁 + `loop_verdict` / Focus 工具  
- specialty catalog **全文**注入（画像主要服务 Agim 父；见 [`agent-profiles.md`](./agent-profiles.md)）

---

## 3. 与 Loop / sticky / 画像

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

## 4. 验收

### 自动化

```bash
# 需本地 agim 已 start；CLI 在 PATH（可用 stub）
node tools/cli-agents-matrix-ws.mjs
```

对 10 个非 Agim CLI 各跑 `call_agent` + `call_agents`（嵌套工人建议 mock `agim`）。  
单测：`mcp-approval-server.test.ts` · `agim-extension.test.ts`。

### 手工（Chat）

1. sticky 切到目标 CLI（`/cc` `/cx` …）  
2. 「用 call_agent 派 agim …」→ Subagents: 1，`"ok": true`  
3. 「用 call_agents 两路 fan-out …」→ Subagents: 2，`okCount: 2`  
4. sticky Agim → `/loop …` 仍可用；CLI sticky **看不到** `loop_verdict` 工具  

---

## 5. 非目标

- CLI 当完整 Loop 父（挂 `loop_verdict` / Focus）  
- sidecar 注入完整 specialty catalog  
- sidecar `call_agent` 对齐 Agim 的 `role`/`backend`/`isolate`（可后续）  
- 同 thread 双 sticky 对等并行  

---

## 6. TL;DR

> **所有 sticky CLI 都能派 Subagent（单路 + 批量）。**  
> **只有 Agim 能当 Loop 父。**  
> 管子仍是 A2A / approval bus；Portal 子代理卡片同一套。
