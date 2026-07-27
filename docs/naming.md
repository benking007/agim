# Naming glossary

Canonical names for Agim surfaces. When code, config, UI, and docs
disagree, **this file wins** for new work. Historical keys stay as
aliases until the migration window closes — see
[`migration-naming-v2.md`](./migration-naming-v2.md).

## Identity matrix

| Layer | Canonical | Also accepted | Do not invent |
|-------|-----------|---------------|---------------|
| Brand | **Agim** / 阿吉姆 | — | “Agim CLI product” as a separate brand |
| npm package | `agim-cli` | — | renaming without a major release |
| Binary / state dir | `agim`, `~/.agim/` | — | — |
| Built-in agent (UI / chat) | **Agim Agent** | slash `/agim`, `/na`, `/llm`, `/native` | calling it “PI” in operator docs |
| Built-in agent (config / registry) | `agim` | `native` (legacy alias) | new third id for the same agent |
| Built-in agent (code dir) | `src/plugins/agents/agim-agent/` | was `pi-native/` | treating `pi` CLI as the same thing |
| Shared prompt/policy helpers | `src/plugins/agents/agim-agent-shared/` | was `native/` | assuming this folder is the adapter |
| Built-in tools (advertised) | `agim_*` | `native_*` (dispatch alias) | inventing a third prefix |
| Agim Agent session root | `~/.agim/agim-sessions/` | `pi-sessions/` (boot-migrated) | confusing with PI CLI `.pi-sessions` |
| Access-rule config field | `tenants[]` | `workspaces[]` (read + dual-write) | using bare “workspace” for both concepts |
| External PI CLI agent | registry `pi` | `/pi`, `/pi-agent` | “pi-native” |

Display rule: show **Agim Agent** to humans; persist **`agim`** in
`config.json` / new sessions / jobs. Boot migrates legacy `native`.

First-run rule: recommend `agim go` (Web + one agent). Empty `messengers`
is a supported web-console-only shape; Telegram/Discord stay gated behind
`AGIM_ENABLE_GLOBAL_IM=1`.

## Protocols (do not collapse)

| Name | Meaning | Typical knobs |
|------|---------|---------------|
| **A2A** | Transport/guardrails for calling **another registered** `AgentAdapter` (`callAgentByName` / `call_agent`) | `AGIM_A2A_*` |
| **Subagent** | Nested worker while the **parent keeps** user-facing control (agents-as-tools). Parent may be **Agim** or a sticky **CLI** (MCP sidecar / PI). Same-family (`agim` + role/backend/isolate) **or** cross-adapter via A2A | `mcp__agim__call_agent` / `mcp__agim__call_agents`; Agim also has `role`/`backend`/`isolate`; [`architecture/subagent.md`](./architecture/subagent.md) |
| **Subagent parallel fan-out** | One parent turn joins multiple SubagentRuns (batch tool); Agim dispatcher **and** CLI MCP sidecar | `AGIM_SUBAGENT_PARALLEL` (default on), `AGIM_SUBAGENT_PARALLEL_MAX` (default 3); Agim also uses `AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN` (default 3) |
| **Focus** | Per-thread attention anchor: auto-inject when **on**, stop inject when **off**, optional clear | `/focus`; SSOT [`architecture/focus.md`](./architecture/focus.md) |
| **Loop / Loop Engineering**（Phase C；历史名 Long-engineering） | **L3 自动调度层**：目标 → 拆解 → 调度 Subagent → 验收 →（未达）反思再来 → 退出。**父编排者 = Agim only**；Codex 等 sticky CLI **不**跑 `/loop`（可派 Subagent，但无 `loop_verdict`） | `/loop`; Portal 底栏/小精灵; `AGIM_LOOP_*`; SSOT [`architecture/loop-engineering.md`](./architecture/loop-engineering.md) §6 |
| **Agent Loop（L2）** | Single-agent Observe→Think→Tools→Results while not done | pi-agent / native tool loop — **not** `/loop` |
| **≠ Claude Code `/loop`** | Claude 博客里的 `/loop` 是**定时再跑 prompt**（time-based）；Agim `/loop` ≈ 他们的 **`/goal` 级使命闭环**。定时触发属 Heartbeat/R6，不占用 `/loop` | 见 [`architecture/loop-engineering.md`](./architecture/loop-engineering.md) §对照 |
| **goal**（retired） | Former sustained-objective slash/tools — product surface removed; storage reused by Focus | see [`architecture/goal-residue.md`](./architecture/goal-residue.md) |
| **goal-critic** | In-process cheap on-track check — **not** a Subagent / not Loop observer; product copy may say focus-critic | `AGIM_NATIVE_CRITIC_*` |
| **ACP**（retired） | Former inbound `:9090` agent endpoint + outbound remote agents | removed; SSRF helpers in `src/core/url-guard.ts` |
| **Heartbeat** | Wall-clock “anything to do?” — must **not** share LoopRun paths | `AGIM_HEARTBEAT_*` |
| **Handoff / sticky switch** | User conversation control moves to another backend (`/cc`, `/oc`, …) — **not** a Subagent | session sticky |

UI copy should say “Subagent” for nested workers and “A2A” only when
discussing cross-adapter transport.
Do not call sticky `/cc` a “subagent”.

## Workspace (two different words)

| Surface | Meaning | Route / field |
|---------|---------|---------------|
| **Agent files** | Per-agent CWD browser (AGENTS.md, memory files, …) | SPA `/workspace`, API `/api/workspace-files` |
| **Access rules** | Multi-tenant member / agent / rate-limit scopes | SPA `/settings/workspaces`, config `tenants[]` (alias `workspaces[]`) |

Never use the bare word “workspace” in new UI strings without the
qualifier (files vs access rules).

## Env families (ops)

| Concern | Canonical env | Legacy alias (still read) |
|---------|---------------|---------------------------|
| Approval timeout policy (`allow` \| `deny`) | `AGIM_APPROVAL_ON_TIMEOUT` | `AGIM_TIMEOUT_DEFAULT` |
| Plan mode process default | `AGIM_PLAN_MODE` = `on` \| `off` \| `disabled` | `AGIM_NATIVE_PLAN_MODE` (truthy → on), `AGIM_DISABLE_PLAN_MODE=1` (→ disabled) |
| Agim Agent behavioral knobs | `AGIM_NATIVE_*` (historical prefix) | Future: `AGIM_AGENT_*` with aliases — not renamed in this pass |

Boolean truthiness still varies by family (`on`/`off`, `1`/`0`). New knobs
should prefer `on`/`off` and document the default explicitly.

## Jobs vocabulary

| Term | Meaning |
|------|---------|
| **Jobs** (`/tasks/jobs`) | Agim `job-board` rows (inline IM turns, async tasks) |
| **Background jobs** (`/tasks/bgjobs`) | Host CLI agent background scripts (Claude/opencode/codex) |
| **A2A / inline job** | Nested `call_agent` tracking row under a parent job |

## Naming v2 (shipped)

Operator guide: [`migration-naming-v2.md`](./migration-naming-v2.md).

| Item | Status |
|------|--------|
| Registry id `native` → `agim` | Done (alias kept) |
| Tools `native_*` → `agim_*` | Done (dispatch accepts both) |
| Session dir `pi-sessions` → `agim-sessions` | Done (boot rename) |
| Config `workspaces[]` → `tenants[]` | Done (read both; dual-write) |
